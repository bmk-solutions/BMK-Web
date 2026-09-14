-- Atomic upload normalization: retain the existing floor geometry and recalculate
-- missing floor plans/navigation/quality before the single revision increment.
BEGIN;
CREATE FUNCTION public.imo3d_commit_upload_v2(p_id text,p_tour_id text,p_lease text,p_expected_revision bigint,p_scene jsonb,p_assets jsonb,p_original jsonb,p_tour jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.imo3d_tours; u public.imo3d_upload_sessions; result jsonb; a jsonb; s jsonb;
BEGIN
 SELECT * INTO t FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 SELECT * INTO u FROM public.imo3d_upload_sessions WHERE id=p_id AND tour_id=p_tour_id FOR UPDATE;
 IF u.id IS NULL OR t.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF u.status='completed' THEN RETURN t.payload; END IF;
 IF t.revision<>p_expected_revision OR u.status<>'processing' OR u.lease_token IS DISTINCT FROM p_lease OR u.lease_until<now() OR p_scene->>'id'<>u.scene_id OR p_scene->>'sourceName'<>u.name OR (p_scene->>'floor')::integer<>u.floor OR p_original->>'storage_key'<>u.object_key OR (p_original->>'byte_size')::bigint<>u.size THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF jsonb_array_length(t.payload->'scenes')>=500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'scenes') old WHERE lower(normalize(old->>'sourceName',NFC))=lower(normalize(u.name,NFC))) THEN RAISE EXCEPTION 'DUPLICATE_OR_LIMIT' USING ERRCODE='23505'; END IF;
 IF jsonb_typeof(p_tour->'scenes') IS DISTINCT FROM 'array' OR jsonb_typeof(p_tour->'plans') IS DISTINCT FROM 'array' OR jsonb_typeof(p_tour->'quality') IS DISTINCT FROM 'object' OR
    (p_tour-'scenes'-'plans'-'quality') IS DISTINCT FROM (t.payload-'scenes'-'plans'-'quality') OR
    jsonb_array_length(p_tour->'scenes')<>jsonb_array_length(t.payload->'scenes')+1 THEN RAISE EXCEPTION 'INVALID_NORMALIZED_UPLOAD'; END IF;
 IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(p_tour->'scenes') item)<>jsonb_array_length(p_tour->'scenes') OR
    (SELECT item FROM jsonb_array_elements(p_tour->'scenes') item WHERE item->>'id'=u.scene_id) IS DISTINCT FROM p_scene THEN RAISE EXCEPTION 'INVALID_NEW_SCENE'; END IF;
 FOR s IN SELECT * FROM jsonb_array_elements(t.payload->'scenes') LOOP
  IF (SELECT item-'links'-'visualLinks' FROM jsonb_array_elements(p_tour->'scenes') item WHERE item->>'id'=s->>'id') IS DISTINCT FROM (s-'links'-'visualLinks') THEN RAISE EXCEPTION 'EXISTING_SCENE_CHANGED'; END IF;
 END LOOP;
 FOR s IN SELECT * FROM jsonb_array_elements(t.payload->'plans') LOOP
  IF NOT (p_tour->'plans' @> jsonb_build_array(s)) THEN RAISE EXCEPTION 'EXISTING_PLAN_CHANGED'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_tour->'plans') plan WHERE (plan->>'floor')::integer=u.floor) THEN RAISE EXCEPTION 'UPLOAD_FLOOR_MISSING'; END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(p_assets) LOOP
  INSERT INTO public.imo3d_assets(id,tour_id,file,mime,storage_key,sha256,byte_size) VALUES(a->>'id',t.id,a->>'file',a->>'mime',a->>'storage_key',a->>'sha256',(a->>'byte_size')::bigint);
 END LOOP;
 INSERT INTO public.imo3d_scene_originals(scene_id,tour_id,file,mime,width,height,storage_key,sha256,byte_size) VALUES(u.scene_id,t.id,p_original->>'file',p_original->>'mime',(p_original->>'width')::integer,(p_original->>'height')::integer,p_original->>'storage_key',p_original->>'sha256',(p_original->>'byte_size')::bigint);
 result:=public.imo3d_save_tour(p_tour,p_expected_revision);
 UPDATE public.imo3d_upload_sessions SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=p_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.imo3d_commit_upload_v2(text,text,text,bigint,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imo3d_commit_upload_v2(text,text,text,bigint,jsonb,jsonb,jsonb,jsonb) TO service_role;
COMMIT;
