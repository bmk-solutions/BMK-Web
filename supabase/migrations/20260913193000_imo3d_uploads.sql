-- Upload reservations are private. Run after 20260913191500_imo3d_cloud.sql.
BEGIN;
CREATE TABLE public.imo3d_upload_sessions(
 id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,
 name text NOT NULL,size bigint NOT NULL CHECK(size BETWEEN 1 AND 104857600),mime text NOT NULL CHECK(mime IN('image/jpeg','image/png','image/webp')),
 floor integer NOT NULL CHECK(floor BETWEEN -10 AND 200),object_key text NOT NULL UNIQUE,scene_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','completed')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours',lease_token text,lease_until timestamptz);
CREATE INDEX imo3d_upload_tour ON public.imo3d_upload_sessions(tour_id);
ALTER TABLE public.imo3d_upload_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.imo3d_upload_sessions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.imo3d_upload_sessions TO service_role;
CREATE FUNCTION public.imo3d_begin_upload(p_id text,p_tour_id text,p_revision bigint,p_name text,p_size bigint,p_mime text,p_floor integer,p_object_key text,p_scene_id text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.imo3d_tours;
BEGIN
 SELECT * INTO t FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 IF t.id IS NULL OR t.revision<>p_revision THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF jsonb_array_length(t.payload->'scenes')>=500 OR length(p_name)>200 OR length(trim(p_name))=0 THEN RAISE EXCEPTION 'INVALID_UPLOAD'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'scenes') s WHERE lower(normalize(s->>'sourceName',NFC))=lower(normalize(p_name,NFC))) THEN RAISE EXCEPTION 'DUPLICATE_NAME' USING ERRCODE='23505'; END IF;
 IF (SELECT count(*) FROM public.imo3d_upload_sessions WHERE tour_id=p_tour_id AND status<>'completed' AND expires_at>now())>=25 THEN RAISE EXCEPTION 'TOO_MANY_PENDING_UPLOADS'; END IF;
 INSERT INTO public.imo3d_upload_sessions(id,tour_id,name,size,mime,floor,object_key,scene_id) VALUES(p_id,p_tour_id,p_name,p_size,p_mime,p_floor,p_object_key,p_scene_id);
 RETURN true;
END $$;
CREATE FUNCTION public.imo3d_claim_upload(p_id text,p_tour_id text,p_revision bigint,p_lease text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.imo3d_tours; u public.imo3d_upload_sessions;
BEGIN
 SELECT * INTO t FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 SELECT * INTO u FROM public.imo3d_upload_sessions WHERE id=p_id AND tour_id=p_tour_id FOR UPDATE;
 IF u.id IS NULL OR t.id IS NULL OR t.revision<>p_revision OR u.expires_at<now() OR u.status='completed' OR (u.status='processing' AND u.lease_until>now()) THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 UPDATE public.imo3d_upload_sessions SET status='processing',lease_token=p_lease,lease_until=now()+interval '10 minutes' WHERE id=p_id; RETURN true;
END $$;
CREATE FUNCTION public.imo3d_release_upload(p_id text,p_lease text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.imo3d_upload_sessions SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=p_id AND lease_token=p_lease AND status='processing';RETURN FOUND;
END $$;
CREATE FUNCTION public.imo3d_commit_upload(p_id text,p_tour_id text,p_lease text,p_expected_revision bigint,p_scene jsonb,p_assets jsonb,p_original jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.imo3d_tours; u public.imo3d_upload_sessions; result jsonb;
BEGIN
 SELECT * INTO t FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 SELECT * INTO u FROM public.imo3d_upload_sessions WHERE id=p_id AND tour_id=p_tour_id FOR UPDATE;
 IF u.id IS NULL OR t.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF u.status='completed' THEN RETURN t.payload; END IF;
 IF t.revision<>p_expected_revision OR u.status<>'processing' OR u.lease_token IS DISTINCT FROM p_lease OR u.lease_until<now() OR p_scene->>'id'<>u.scene_id OR p_scene->>'sourceName'<>u.name OR (p_scene->>'floor')::integer<>u.floor OR p_original->>'storage_key'<>u.object_key OR (p_original->>'byte_size')::bigint<>u.size THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF jsonb_array_length(t.payload->'scenes')>=500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'scenes') s WHERE lower(normalize(s->>'sourceName',NFC))=lower(normalize(u.name,NFC))) THEN RAISE EXCEPTION 'DUPLICATE_OR_LIMIT' USING ERRCODE='23505'; END IF;
 result:=public.imo3d_commit_scene_upload(p_tour_id,p_expected_revision,p_scene,p_assets,p_original);
 UPDATE public.imo3d_upload_sessions SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=p_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.imo3d_begin_upload(text,text,bigint,text,bigint,text,integer,text,text),public.imo3d_claim_upload(text,text,bigint,text),public.imo3d_release_upload(text,text),public.imo3d_commit_upload(text,text,text,bigint,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imo3d_begin_upload(text,text,bigint,text,bigint,text,integer,text,text),public.imo3d_claim_upload(text,text,bigint,text),public.imo3d_release_upload(text,text),public.imo3d_commit_upload(text,text,text,bigint,jsonb,jsonb,jsonb) TO service_role;
COMMIT;
