-- Apply only to the newly created, empty IMO 3D Supabase project.
-- Deliberately no IF NOT EXISTS/UPSERT for tables: a collision aborts deployment.
BEGIN;
CREATE TABLE public.imo3d_projects(id text PRIMARY KEY,name text NOT NULL,location text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.imo3d_developers(id text PRIMARY KEY,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.imo3d_project_developers(project_id text PRIMARY KEY REFERENCES public.imo3d_projects ON DELETE CASCADE,developer_id text NOT NULL REFERENCES public.imo3d_developers);
CREATE TABLE public.imo3d_tours(id text PRIMARY KEY,project_id text NOT NULL REFERENCES public.imo3d_projects ON DELETE CASCADE,revision bigint NOT NULL CHECK(revision>=0),published boolean NOT NULL DEFAULT false,payload jsonb NOT NULL,
 CHECK(payload->>'id'=id),CHECK(payload->>'projectId'=project_id),CHECK((payload->>'revision')::bigint=revision),CHECK((payload->>'published')::boolean=published));
CREATE INDEX imo3d_tours_project ON public.imo3d_tours(project_id);
CREATE TABLE public.imo3d_assets(id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,file text NOT NULL,mime text NOT NULL,storage_key text NOT NULL,sha256 text,byte_size bigint CHECK(byte_size>=0));
CREATE INDEX imo3d_assets_tour ON public.imo3d_assets(tour_id);
CREATE TABLE public.imo3d_scene_originals(scene_id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,file text NOT NULL,mime text NOT NULL,width integer NOT NULL,height integer NOT NULL,storage_key text NOT NULL,sha256 text,byte_size bigint CHECK(byte_size>=0));
CREATE INDEX imo3d_originals_tour ON public.imo3d_scene_originals(tour_id);
CREATE TABLE public.imo3d_leads(id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,name text NOT NULL,phone text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX imo3d_leads_order ON public.imo3d_leads(created_at DESC,id DESC);
CREATE TABLE public.imo3d_request_limits(key text PRIMARY KEY,count integer NOT NULL,expires bigint NOT NULL);
CREATE TABLE public.imo3d_project_brand_assets(id text PRIMARY KEY,project_id text NOT NULL REFERENCES public.imo3d_projects ON DELETE CASCADE,mime text NOT NULL,storage_key text NOT NULL,sha256 text NOT NULL,byte_size bigint NOT NULL CHECK(byte_size>=0),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.imo3d_project_branding(project_id text PRIMARY KEY REFERENCES public.imo3d_projects ON DELETE CASCADE,name text NOT NULL,accent text NOT NULL,logo_asset_id text REFERENCES public.imo3d_project_brand_assets,updated_at timestamptz NOT NULL DEFAULT now(),logo_style text NOT NULL DEFAULT 'clean');
CREATE TABLE public.imo3d_integration_keys(id text PRIMARY KEY,project_id text NOT NULL REFERENCES public.imo3d_projects ON DELETE CASCADE,name text NOT NULL,prefix text NOT NULL,secret_hash text NOT NULL UNIQUE,scopes jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz,revoked_at timestamptz);
CREATE TABLE public.imo3d_processing_jobs(id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,status text NOT NULL,progress double precision NOT NULL DEFAULT 0,stage text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),input_hash text NOT NULL,lease_owner text,lease_until bigint NOT NULL DEFAULT 0,cancel_requested boolean NOT NULL DEFAULT false,attempts integer NOT NULL DEFAULT 0,error text,result jsonb,warnings jsonb NOT NULL DEFAULT '[]');
CREATE UNIQUE INDEX imo3d_processing_one_active ON public.imo3d_processing_jobs(tour_id) WHERE status IN('queued','running');
CREATE TABLE public.imo3d_processing_worker_lock(name text PRIMARY KEY,owner text NOT NULL,lease_until bigint NOT NULL);
CREATE TABLE public.imo3d_ai_plan_jobs(id text PRIMARY KEY,tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,input_hash text NOT NULL,status text NOT NULL,progress double precision NOT NULL DEFAULT 0,stage text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),lease_owner text,lease_until bigint NOT NULL DEFAULT 0,error text,result jsonb);
CREATE UNIQUE INDEX imo3d_ai_plan_one_active ON public.imo3d_ai_plan_jobs(tour_id) WHERE status IN('queued','running');
-- Safe public projections live separately from private job results and local paths.
CREATE TABLE public.imo3d_approved_plan_refs(tour_id text NOT NULL REFERENCES public.imo3d_tours ON DELETE CASCADE,floor integer NOT NULL,job_id text NOT NULL REFERENCES public.imo3d_ai_plan_jobs ON DELETE CASCADE,storage_key text NOT NULL,sha256 text NOT NULL,navigation jsonb,public_metadata jsonb NOT NULL DEFAULT '{}',scene_ids jsonb NOT NULL DEFAULT '[]',input_hash text NOT NULL,PRIMARY KEY(tour_id,floor));

CREATE FUNCTION public.imo3d_scene_signature(p_scenes jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_array(s->>'id',s->>'image',s->'floor') ORDER BY s->>'id'),'[]'::jsonb) FROM jsonb_array_elements(coalesce(p_scenes,'[]')) s;
$$;
CREATE FUNCTION public.imo3d_create_project(p_id text,p_name text,p_location text,p_developer_id text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_projects;
BEGIN
 INSERT INTO public.imo3d_projects(id,name,location) VALUES(p_id,p_name,p_location) RETURNING * INTO r;
 IF p_developer_id IS NOT NULL THEN INSERT INTO public.imo3d_project_developers VALUES(p_id,p_developer_id); END IF;
 RETURN jsonb_build_object('id',r.id,'name',r.name,'location',r.location,'createdAt',r.created_at,'developerId',p_developer_id);
END $$;
CREATE FUNCTION public.imo3d_edit_project(p_project_id text,p_name text,p_location text,p_developer_id text,p_assign_developer boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_projects; d text;
BEGIN
 UPDATE public.imo3d_projects SET name=p_name,location=p_location WHERE id=p_project_id RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_assign_developer THEN
  DELETE FROM public.imo3d_project_developers WHERE project_id=p_project_id;
  IF p_developer_id IS NOT NULL THEN INSERT INTO public.imo3d_project_developers VALUES(p_project_id,p_developer_id); END IF;
 END IF;
 SELECT developer_id INTO d FROM public.imo3d_project_developers WHERE project_id=p_project_id;
 RETURN jsonb_build_object('id',r.id,'name',r.name,'location',r.location,'createdAt',r.created_at,'developerId',d);
END $$;
CREATE FUNCTION public.imo3d_save_tour(p_tour jsonb,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old public.imo3d_tours; revised jsonb; rev bigint;
BEGIN
 IF p_expected_revision IS NULL THEN
  rev:=coalesce((p_tour->>'revision')::bigint,0)+1;
  revised:=p_tour||jsonb_build_object('revision',rev,'updatedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO public.imo3d_tours VALUES(p_tour->>'id',p_tour->>'projectId',rev,coalesce((p_tour->>'published')::boolean,false),revised);
 ELSE
  SELECT * INTO old FROM public.imo3d_tours WHERE id=p_tour->>'id' FOR UPDATE;
  IF NOT FOUND OR old.revision<>p_expected_revision OR old.project_id<>p_tour->>'projectId' THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
  rev:=old.revision+1; revised:=p_tour||jsonb_build_object('revision',rev,'updatedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.imo3d_tours SET revision=rev,published=coalesce((p_tour->>'published')::boolean,false),payload=revised WHERE id=old.id;
  UPDATE public.imo3d_processing_jobs SET status='cancelled',cancel_requested=true,updated_at=now(),stage='تغيرت الجولة' WHERE tour_id=old.id AND status IN('queued','running');
  UPDATE public.imo3d_ai_plan_jobs SET status='stale',updated_at=now(),stage='تغيرت الجولة' WHERE tour_id=old.id AND status IN('queued','running');
  IF public.imo3d_scene_signature(old.payload->'scenes') IS DISTINCT FROM public.imo3d_scene_signature(revised->'scenes') THEN DELETE FROM public.imo3d_approved_plan_refs WHERE tour_id=old.id; END IF;
 END IF;
 RETURN revised;
END $$;
CREATE FUNCTION public.imo3d_commit_scene_upload(p_tour_id text,p_expected_revision bigint,p_scene jsonb,p_assets jsonb,p_original jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current public.imo3d_tours; a jsonb; revised jsonb;
BEGIN
 SELECT * INTO current FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 IF NOT FOUND OR current.revision<>p_expected_revision THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(current.payload->'scenes') s WHERE s->>'id'=p_scene->>'id') THEN RAISE EXCEPTION 'SCENE_EXISTS' USING ERRCODE='23505'; END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(p_assets) LOOP
  INSERT INTO public.imo3d_assets(id,tour_id,file,mime,storage_key,sha256,byte_size) VALUES(a->>'id',p_tour_id,a->>'file',a->>'mime',a->>'storage_key',a->>'sha256',(a->>'byte_size')::bigint);
 END LOOP;
 INSERT INTO public.imo3d_scene_originals(scene_id,tour_id,file,mime,width,height,storage_key,sha256,byte_size) VALUES(p_scene->>'id',p_tour_id,p_original->>'file',p_original->>'mime',(p_original->>'width')::integer,(p_original->>'height')::integer,p_original->>'storage_key',p_original->>'sha256',(p_original->>'byte_size')::bigint);
 revised:=jsonb_set(current.payload,'{scenes}',coalesce(current.payload->'scenes','[]')||jsonb_build_array(p_scene));
 RETURN public.imo3d_save_tour(revised,p_expected_revision);
END $$;
CREATE FUNCTION public.imo3d_delete_scene(p_tour_id text,p_scene_id text,p_expected_revision bigint,p_tour jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current public.imo3d_tours; removed jsonb; revised jsonb;
BEGIN
 SELECT * INTO current FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 IF NOT FOUND OR current.revision<>p_expected_revision OR p_tour->>'id'<>p_tour_id THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 SELECT s INTO removed FROM jsonb_array_elements(current.payload->'scenes') s WHERE s->>'id'=p_scene_id;
 IF removed IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tour->'scenes') s WHERE s->>'id'=p_scene_id) THEN RAISE EXCEPTION 'INVALID_SCENE_REMOVAL'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(current.payload->'scenes'))<>(SELECT count(*)+1 FROM jsonb_array_elements(p_tour->'scenes')) OR EXISTS(SELECT s->>'id' FROM jsonb_array_elements(current.payload->'scenes') s WHERE s->>'id'<>p_scene_id EXCEPT SELECT s->>'id' FROM jsonb_array_elements(p_tour->'scenes') s) THEN RAISE EXCEPTION 'INVALID_SCENE_SET'; END IF;
 revised:=public.imo3d_save_tour(p_tour,p_expected_revision);
 DELETE FROM public.imo3d_scene_originals WHERE scene_id=p_scene_id AND tour_id=p_tour_id;
 DELETE FROM public.imo3d_assets a WHERE a.tour_id=p_tour_id AND strpos(removed::text,'"/api/imo3d/assets/'||a.id||'"')>0 AND strpos(revised::text,'"/api/imo3d/assets/'||a.id||'"')=0;
 RETURN revised;
END $$;
CREATE FUNCTION public.imo3d_delete_tour(p_tour_id text,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_tours; keys jsonb;
BEGIN
 SELECT * INTO r FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TOUR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_expected_revision IS NOT NULL AND r.revision<>p_expected_revision THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 SELECT coalesce(jsonb_agg(storage_key),'[]') INTO keys FROM (SELECT storage_key FROM public.imo3d_assets WHERE tour_id=p_tour_id UNION SELECT storage_key FROM public.imo3d_scene_originals WHERE tour_id=p_tour_id UNION SELECT storage_key FROM public.imo3d_approved_plan_refs WHERE tour_id=p_tour_id) s;
 DELETE FROM public.imo3d_tours WHERE id=p_tour_id; RETURN keys;
END $$;
CREATE FUNCTION public.imo3d_delete_project(p_project_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t record; keys jsonb:='[]'; brands jsonb;
BEGIN
 PERFORM 1 FROM public.imo3d_projects WHERE id=p_project_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 FOR t IN SELECT id FROM public.imo3d_tours WHERE project_id=p_project_id LOOP keys:=keys||public.imo3d_delete_tour(t.id,NULL); END LOOP;
 SELECT coalesce(jsonb_agg(storage_key),'[]') INTO brands FROM public.imo3d_project_brand_assets WHERE project_id=p_project_id;
 DELETE FROM public.imo3d_project_branding WHERE project_id=p_project_id;
 DELETE FROM public.imo3d_projects WHERE id=p_project_id; RETURN keys||brands;
END $$;
CREATE FUNCTION public.imo3d_rate_limit(p_key text,p_limit integer,p_window_ms bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n bigint:=(extract(epoch FROM clock_timestamp())*1000)::bigint; c integer;
BEGIN
 IF p_limit<1 OR p_window_ms<1 OR p_window_ms>86400000 THEN RAISE EXCEPTION 'INVALID_RATE_LIMIT'; END IF;
 INSERT INTO public.imo3d_request_limits AS r VALUES(p_key,1,n+p_window_ms) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN r.expires<n THEN 1 ELSE r.count+1 END,expires=CASE WHEN r.expires<n THEN n+p_window_ms ELSE r.expires END RETURNING count INTO c;
 RETURN c<=p_limit;
END $$;
CREATE FUNCTION public.imo3d_list_leads(p_project_id text DEFAULT NULL,p_cursor_created_at timestamptz DEFAULT NULL,p_cursor_id text DEFAULT NULL,p_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE total bigint; results jsonb; amount integer:=least(1000,greatest(1,p_limit));
BEGIN
 SELECT count(*) INTO total FROM public.imo3d_leads l JOIN public.imo3d_tours t ON t.id=l.tour_id WHERE p_project_id IS NULL OR t.project_id=p_project_id;
 SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO results FROM (SELECT l.id,l.tour_id AS "tourId",l.name,l.phone,l.note,l.created_at AS "createdAt",p.id AS "projectId",p.name AS "projectName",t.payload->>'title' AS "tourTitle" FROM public.imo3d_leads l JOIN public.imo3d_tours t ON t.id=l.tour_id JOIN public.imo3d_projects p ON p.id=t.project_id WHERE (p_project_id IS NULL OR p.id=p_project_id) AND (p_cursor_created_at IS NULL OR (l.created_at,l.id)<(p_cursor_created_at,p_cursor_id)) ORDER BY l.created_at DESC,l.id DESC LIMIT amount+1) s;
 RETURN jsonb_build_object('total',total,'hasMore',jsonb_array_length(results)>amount,'leads',CASE WHEN jsonb_array_length(results)>amount THEN results-amount ELSE results END);
END $$;

CREATE FUNCTION public.imo3d_enqueue_job(p_tour_id text,p_input_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_processing_jobs;
BEGIN
 PERFORM 1 FROM public.imo3d_tours WHERE id=p_tour_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TOUR_NOT_FOUND'; END IF;
 SELECT * INTO r FROM public.imo3d_processing_jobs WHERE tour_id=p_tour_id AND status IN('queued','running');
 IF NOT FOUND THEN INSERT INTO public.imo3d_processing_jobs(id,tour_id,status,stage,input_hash) VALUES(gen_random_uuid()::text,p_tour_id,'queued','في انتظار المعالجة',p_input_hash) RETURNING * INTO r; END IF;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.imo3d_claim_job(p_owner text,p_lease_ms bigint DEFAULT 30000) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_processing_jobs; n bigint:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 UPDATE public.imo3d_processing_jobs SET status='failed',stage='تحتاج إعادة محاولة',error='Worker lease expired repeatedly',updated_at=now() WHERE status='running' AND lease_until<n AND attempts>=3;
 SELECT * INTO r FROM public.imo3d_processing_jobs WHERE (status='queued' OR status='running' AND lease_until<n) AND NOT cancel_requested AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.imo3d_processing_jobs SET status='running',lease_owner=p_owner,lease_until=n+least(300000,greatest(5000,p_lease_ms)),attempts=attempts+1,updated_at=now(),stage='تجهيز الصور' WHERE id=r.id RETURNING * INTO r; RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.imo3d_heartbeat_job(p_id text,p_owner text,p_progress double precision,p_stage text,p_lease_ms bigint DEFAULT 30000) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n bigint:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 UPDATE public.imo3d_processing_jobs SET lease_until=n+least(300000,greatest(5000,p_lease_ms)),progress=least(99,greatest(0,p_progress)),stage=p_stage,updated_at=now() WHERE id=p_id AND lease_owner=p_owner AND lease_until>=n AND status='running' AND NOT cancel_requested; RETURN FOUND;
END $$;
CREATE FUNCTION public.imo3d_fail_job(p_id text,p_owner text,p_error text,p_retry boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.imo3d_processing_jobs SET status=CASE WHEN p_retry AND attempts<3 THEN 'queued' ELSE 'failed' END,error=left(p_error,2000),stage='تحتاج إعادة محاولة',lease_owner=NULL,lease_until=0,updated_at=now() WHERE id=p_id AND lease_owner=p_owner AND status='running' AND lease_until>=(extract(epoch FROM clock_timestamp())*1000)::bigint; RETURN FOUND;
END $$;
CREATE FUNCTION public.imo3d_commit_job(p_id text,p_owner text,p_expected_revision bigint,p_input_hash text,p_tour jsonb,p_result jsonb,p_warnings jsonb,p_assets jsonb DEFAULT '[]',p_status text DEFAULT 'review',p_stage text DEFAULT 'اكتملت المعالجة') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.imo3d_processing_jobs; t public.imo3d_tours; revised jsonb; a jsonb;
BEGIN
 SELECT * INTO j FROM public.imo3d_processing_jobs WHERE id=p_id;
 SELECT * INTO t FROM public.imo3d_tours WHERE id=j.tour_id FOR UPDATE;
 SELECT * INTO j FROM public.imo3d_processing_jobs WHERE id=p_id FOR UPDATE;
 IF j.id IS NULL OR t.id IS NULL OR j.status<>'running' OR j.cancel_requested OR j.lease_owner IS DISTINCT FROM p_owner OR j.lease_until<(extract(epoch FROM clock_timestamp())*1000)::bigint OR j.input_hash<>p_input_hash OR t.revision<>p_expected_revision OR p_tour->>'id'<>t.id OR p_tour->>'projectId'<>t.project_id THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_status NOT IN('review','completed') THEN RAISE EXCEPTION 'INVALID_JOB_STATUS'; END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(p_assets) LOOP
  INSERT INTO public.imo3d_assets(id,tour_id,file,mime,storage_key,sha256,byte_size) VALUES(a->>'id',t.id,a->>'file',a->>'mime',a->>'storage_key',a->>'sha256',(a->>'byte_size')::bigint);
 END LOOP;
 revised:=p_tour||jsonb_build_object('revision',t.revision+1,'published',t.published,'updatedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 UPDATE public.imo3d_tours SET revision=t.revision+1,payload=revised WHERE id=t.id;
 UPDATE public.imo3d_processing_jobs SET status=p_status,progress=100,stage=p_stage,result=p_result,warnings=coalesce(p_warnings,'[]'),lease_until=0,updated_at=now() WHERE id=j.id;
 RETURN revised;
END $$;
CREATE FUNCTION public.imo3d_claim_ai_job(p_owner text,p_lease_ms bigint DEFAULT 60000) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.imo3d_ai_plan_jobs; n bigint:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 UPDATE public.imo3d_ai_plan_jobs SET status='failed',stage='المعالجة متوقفة',error='Worker lease expired; explicit retry required',updated_at=now() WHERE status='running' AND lease_until<n;
 SELECT * INTO r FROM public.imo3d_ai_plan_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.imo3d_ai_plan_jobs SET status='running',lease_owner=p_owner,lease_until=n+least(300000,greatest(5000,p_lease_ms)),updated_at=now() WHERE id=r.id RETURNING * INTO r; RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.imo3d_heartbeat_ai_job(p_id text,p_owner text,p_progress double precision,p_stage text,p_lease_ms bigint DEFAULT 60000) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n bigint:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 UPDATE public.imo3d_ai_plan_jobs SET lease_until=n+least(300000,greatest(5000,p_lease_ms)),progress=least(99,greatest(0,p_progress)),stage=p_stage,updated_at=now() WHERE id=p_id AND lease_owner=p_owner AND lease_until>=n AND status='running'; RETURN FOUND;
END $$;
CREATE FUNCTION public.imo3d_commit_ai_job(p_id text,p_owner text,p_expected_revision bigint,p_input_hash text,p_result jsonb,p_plan_refs jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.imo3d_ai_plan_jobs; t public.imo3d_tours; r jsonb;
BEGIN
 SELECT * INTO j FROM public.imo3d_ai_plan_jobs WHERE id=p_id;
 SELECT * INTO t FROM public.imo3d_tours WHERE id=j.tour_id FOR UPDATE;
 SELECT * INTO j FROM public.imo3d_ai_plan_jobs WHERE id=p_id FOR UPDATE;
 IF j.id IS NULL OR t.id IS NULL OR j.status<>'running' OR j.lease_owner IS DISTINCT FROM p_owner OR j.lease_until<(extract(epoch FROM clock_timestamp())*1000)::bigint OR j.input_hash<>p_input_hash OR t.revision<>p_expected_revision THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 -- Pending AI artifacts stay private until a separate explicit review action.
 UPDATE public.imo3d_ai_plan_jobs SET status='draft',progress=100,stage='المخطط جاهز للمراجعة',result=p_result||jsonb_build_object('pendingCloudPlanRefs',p_plan_refs),lease_until=0,updated_at=now() WHERE id=j.id RETURNING * INTO j; RETURN to_jsonb(j);
END $$;

-- Atomic, insert-only migration. The importer must have verified the new project
-- ref and all private object hashes first. Any preexisting row aborts everything.
CREATE FUNCTION public.imo3d_import_metadata(p_tables jsonb,p_export_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE names text[]:=ARRAY['projects','developers','project_developers','tours','assets','scene_originals','leads','request_limits','project_brand_assets','project_branding','integration_keys','processing_jobs','processing_worker_lock','ai_plan_jobs','approved_plan_refs']; n text; amount bigint; counts jsonb:='{}';
BEGIN
 IF length(p_export_id)<8 THEN RAISE EXCEPTION 'INVALID_EXPORT'; END IF;
 PERFORM pg_advisory_xact_lock(74921063001);
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_tables) k WHERE NOT k=ANY(names)) THEN RAISE EXCEPTION 'UNKNOWN_IMPORT_TABLE'; END IF;
 FOREACH n IN ARRAY names LOOP EXECUTE format('SELECT count(*) FROM public.%I','imo3d_'||n) INTO amount; IF amount<>0 THEN RAISE EXCEPTION 'TARGET_NOT_EMPTY'; END IF; END LOOP;
 FOREACH n IN ARRAY names LOOP
  EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_recordset(NULL::public.%I,$1)','imo3d_'||n,'imo3d_'||n) USING coalesce(p_tables->n,'[]');
  GET DIAGNOSTICS amount=ROW_COUNT; counts:=counts||jsonb_build_object(n,amount);
 END LOOP; RETURN counts;
END $$;

-- Never change organization-wide defaults or permissions for unrelated tables.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'imo3d\_%' ESCAPE '\' LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.tablename);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',r.tablename);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',r.tablename);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'imo3d\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
 END LOOP;
END $$;
COMMIT;
