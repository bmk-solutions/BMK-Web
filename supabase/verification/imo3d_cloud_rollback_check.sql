-- Run only in the newly created IMO 3D database, BEFORE importing real data.
-- This creates synthetic SQL rows only, never storage objects. All writes roll back.
-- Any failed invariant raises an error; do not import/deploy until all pass.
BEGIN;
DO $verify$
<<verification>>
DECLARE
 project_id text:=gen_random_uuid()::text; tour_id text:=gen_random_uuid()::text; developer_id text:=gen_random_uuid()::text;
 upload_id text; scene_id text; asset_id text; lease text; object_key text; floor_number integer;
 branding_upload text; branding_asset text; owner text:='verify-'||gen_random_uuid()::text; rate_key text:='verify-'||gen_random_uuid()::text;
 t jsonb; next_t jsonb; saved jsonb; scene jsonb; assets jsonb; original jsonb; new_plan jsonb; job jsonb; page jsonb;
 old_revision bigint; n integer; blocked boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public.imo3d_projects) OR EXISTS(SELECT 1 FROM public.imo3d_developers) THEN
  RAISE EXCEPTION 'REFUSED: verification requires an empty IMO3D database before import';
 END IF;
 IF has_table_privilege('anon','public.imo3d_tours','SELECT') OR has_table_privilege('authenticated','public.imo3d_tours','UPDATE') OR
    has_function_privilege('anon','public.imo3d_save_tour(jsonb,bigint)','EXECUTE') OR has_function_privilege('authenticated','public.imo3d_commit_upload_v2(text,text,text,bigint,jsonb,jsonb,jsonb,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'FAIL: private tables or mutation functions have public privileges';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r' AND c.relname LIKE 'imo3d\_%' ESCAPE '\' AND NOT c.relrowsecurity) THEN RAISE EXCEPTION 'FAIL: an IMO3D table lacks RLS'; END IF;
 INSERT INTO public.imo3d_developers(id,name) VALUES(developer_id,'Synthetic verification developer');
 saved:=public.imo3d_create_project(project_id,'Synthetic verification project','Synthetic location',developer_id);
 IF saved->>'id'<>project_id OR saved->>'developerId'<>developer_id THEN RAISE EXCEPTION 'FAIL: create_project contract'; END IF;
 saved:=public.imo3d_edit_project(project_id,'Renamed verification project','Synthetic location',NULL,false);
 IF saved->>'developerId'<>developer_id THEN RAISE EXCEPTION 'FAIL: omitted developer removed assignment'; END IF;
 saved:=public.imo3d_edit_project(project_id,'Renamed verification project','Synthetic location',NULL,true);
 IF saved->>'developerId' IS NOT NULL THEN RAISE EXCEPTION 'FAIL: explicit developer removal'; END IF;
 t:=jsonb_build_object('id',tour_id,'projectId',project_id,'title','Synthetic tour','published',false,'revision',0,'scenes','[]'::jsonb,'plans','[]'::jsonb,'createdAt','2020-01-01T00:00:00.000Z','updatedAt','2020-01-01T00:00:00.000Z','unit',jsonb_build_object('code','','area',NULL,'price',NULL,'bedrooms',NULL,'bathrooms',NULL),'quality',jsonb_build_object('positioned',0,'depthScenes',0,'components',0,'warnings','[]'::jsonb));
 t:=public.imo3d_save_tour(t,NULL);
 IF (t->>'revision')::bigint<>1 THEN RAISE EXCEPTION 'FAIL: initial revision'; END IF;
 old_revision:=(t->>'revision')::bigint;t:=public.imo3d_save_tour(t||jsonb_build_object('title','Updated synthetic tour'),old_revision);
 blocked:=false;BEGIN PERFORM public.imo3d_save_tour(t,old_revision);EXCEPTION WHEN serialization_failure THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'FAIL: stale CAS accepted'; END IF;
 -- Exercise original upload RPC and its completed-session idempotence.
 upload_id:=gen_random_uuid()::text;scene_id:=gen_random_uuid()::text;asset_id:=gen_random_uuid()::text;lease:=gen_random_uuid()::text;object_key:='verification/'||tour_id||'/'||upload_id||'/original';
 PERFORM public.imo3d_begin_upload(upload_id,tour_id,(t->>'revision')::bigint,'legacy-verification.jpg',123,'image/jpeg',0,object_key,scene_id);
 PERFORM public.imo3d_claim_upload(upload_id,tour_id,(t->>'revision')::bigint,lease);
 scene:=jsonb_build_object('id',scene_id,'name','Legacy synthetic camera','sourceName','legacy-verification.jpg','room','Unassigned','floor',0,'position',NULL,'yaw',0,'links','[]'::jsonb,'image','/api/imo3d/assets/'||asset_id,'preview','/api/imo3d/assets/'||asset_id,'thumbnail','/api/imo3d/assets/'||asset_id);
 assets:=jsonb_build_array(jsonb_build_object('id',asset_id,'file',asset_id||'.webp','mime','image/webp','storage_key','verification/'||asset_id||'.webp','sha256',repeat('a',64),'byte_size',12));
 original:=jsonb_build_object('file',scene_id||'.original.jpeg','mime','image/jpeg','width',2048,'height',1024,'storage_key',object_key,'sha256',repeat('b',64),'byte_size',123);
 old_revision:=(t->>'revision')::bigint;t:=public.imo3d_commit_upload(upload_id,tour_id,lease,old_revision,scene,assets,original);
 saved:=public.imo3d_commit_upload(upload_id,tour_id,lease,old_revision,scene,assets,original);
 IF saved<>t OR jsonb_array_length(t->'scenes')<>1 THEN RAISE EXCEPTION 'FAIL: legacy upload idempotence'; END IF;
 -- Remove only this synthetic scene; the new uploader must populate the first floor.
 next_t:=t||jsonb_build_object('scenes','[]'::jsonb,'plans','[]'::jsonb);
 t:=public.imo3d_delete_scene(tour_id,scene_id,(t->>'revision')::bigint,next_t);
 IF EXISTS(SELECT 1 FROM public.imo3d_scene_originals WHERE public.imo3d_scene_originals.scene_id=verification.scene_id) THEN RAISE EXCEPTION 'FAIL: scene original metadata survived deletion'; END IF;
 FOR floor_number IN 0..1 LOOP
  upload_id:=gen_random_uuid()::text;scene_id:=gen_random_uuid()::text;asset_id:=gen_random_uuid()::text;lease:=gen_random_uuid()::text;object_key:='verification/'||tour_id||'/'||upload_id||'/original';
  PERFORM public.imo3d_begin_upload(upload_id,tour_id,(t->>'revision')::bigint,'camera-'||floor_number||'.jpg',123,'image/jpeg',floor_number,object_key,scene_id);
  PERFORM public.imo3d_claim_upload(upload_id,tour_id,(t->>'revision')::bigint,lease);
  blocked:=false;BEGIN PERFORM public.imo3d_claim_upload(upload_id,tour_id,(t->>'revision')::bigint,gen_random_uuid()::text);EXCEPTION WHEN serialization_failure THEN blocked:=true;END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: upload lease stolen'; END IF;
  scene:=jsonb_build_object('id',scene_id,'name','Synthetic camera','sourceName','camera-'||floor_number||'.jpg','room','Unassigned','floor',floor_number,'position',NULL,'yaw',0,'links','[]'::jsonb,'image','/api/imo3d/assets/'||asset_id,'preview','/api/imo3d/assets/'||asset_id,'thumbnail','/api/imo3d/assets/'||asset_id);
  assets:=jsonb_build_array(jsonb_build_object('id',asset_id,'file',asset_id||'.webp','mime','image/webp','storage_key','verification/'||asset_id||'.webp','sha256',repeat('a',64),'byte_size',12));
  original:=jsonb_build_object('file',scene_id||'.original.jpeg','mime','image/jpeg','width',2048,'height',1024,'storage_key',object_key,'sha256',repeat('b',64),'byte_size',123);
  new_plan:=jsonb_build_object('floor',floor_number,'label','Synthetic floor','kind','missing','bounds',jsonb_build_object('minX',-0.5,'minZ',-0.5,'maxX',1.5,'maxZ',1.5),'walls','[]'::jsonb);
  next_t:=t||jsonb_build_object('scenes',(t->'scenes')||jsonb_build_array(scene),'plans',(t->'plans')||jsonb_build_array(new_plan),'quality',jsonb_build_object('positioned',0,'depthScenes',0,'components',floor_number+1,'warnings',jsonb_build_array('Synthetic unpositioned capture')));
  old_revision:=(t->>'revision')::bigint;
  t:=public.imo3d_commit_upload_v2(upload_id,tour_id,lease,old_revision,scene,assets,original,next_t);
  IF (t->>'revision')::bigint<>old_revision+1 OR jsonb_array_length(t->'scenes')<>floor_number+1 OR jsonb_array_length(t->'plans')<>floor_number+1 OR (t#>>'{quality,components}')::integer<>floor_number+1 THEN RAISE EXCEPTION 'FAIL: first/new-floor spatial metadata or revision'; END IF;
  saved:=public.imo3d_commit_upload_v2(upload_id,tour_id,lease,old_revision,scene,assets,original,next_t);
  IF saved<>t THEN RAISE EXCEPTION 'FAIL: normalized upload idempotence'; END IF;
 END LOOP;
 -- Logo atomic save plus completed retry. No storage file is created by this script.
 branding_upload:=gen_random_uuid()::text;branding_asset:=gen_random_uuid()::text;lease:=gen_random_uuid()::text;
 PERFORM public.imo3d_begin_brand_upload(branding_upload,project_id,5242880,'image/png','verification/logo/original','Synthetic brand','#24b18b','clean');
 PERFORM public.imo3d_claim_brand_upload(branding_upload,project_id,lease);
 assets:=jsonb_build_object('id',branding_asset,'mime','image/webp','storage_key','branding/'||project_id||'/'||branding_asset||'.webp','sha256',repeat('c',64),'byte_size',12);
 PERFORM public.imo3d_commit_brand_upload(branding_upload,project_id,lease,assets);
 PERFORM public.imo3d_commit_brand_upload(branding_upload,project_id,lease,assets);
 SELECT count(*) INTO n FROM public.imo3d_project_brand_assets WHERE id=branding_asset;
 IF n<>1 THEN RAISE EXCEPTION 'FAIL: logo retry duplicated asset'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.imo3d_project_branding WHERE public.imo3d_project_branding.project_id=verification.project_id AND logo_asset_id=branding_asset) THEN RAISE EXCEPTION 'FAIL: brand commit'; END IF;
 -- Throttling, exact-count scoped pagination, processing lease ownership and CAS.
 IF NOT public.imo3d_rate_limit(rate_key,1,60000) OR public.imo3d_rate_limit(rate_key,1,60000) THEN RAISE EXCEPTION 'FAIL: atomic rate limit'; END IF;
 INSERT INTO public.imo3d_leads(id,tour_id,name,phone,note) VALUES(gen_random_uuid()::text,tour_id,'Synthetic lead one','+10000000001',''),(gen_random_uuid()::text,tour_id,'Synthetic lead two','+10000000002','');
 page:=public.imo3d_list_leads(project_id,NULL,NULL,1);
 IF (page->>'total')::integer<>2 OR (page->>'hasMore')::boolean IS NOT TRUE OR jsonb_array_length(page->'leads')<>1 THEN RAISE EXCEPTION 'FAIL: lead pagination'; END IF;
 job:=public.imo3d_enqueue_job(tour_id,'verification-input');job:=public.imo3d_claim_job(owner,300000);
 IF job->>'tour_id'<>tour_id OR job->>'lease_owner'<>owner THEN RAISE EXCEPTION 'FAIL: processing claim'; END IF;
 IF public.imo3d_heartbeat_job(job->>'id','wrong-owner',25,'Bad heartbeat',30000) OR NOT public.imo3d_heartbeat_job(job->>'id',owner,25,'Synthetic heartbeat',300000) THEN RAISE EXCEPTION 'FAIL: heartbeat ownership'; END IF;
 old_revision:=(t->>'revision')::bigint;blocked:=false;
 BEGIN PERFORM public.imo3d_commit_job(job->>'id','wrong-owner',old_revision,'verification-input',t,'{}','[]');EXCEPTION WHEN serialization_failure THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'FAIL: wrong worker committed'; END IF;
 blocked:=false;BEGIN PERFORM public.imo3d_commit_job(job->>'id',owner,old_revision-1,'verification-input',t,'{}','[]');EXCEPTION WHEN serialization_failure THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'FAIL: stale worker revision committed'; END IF;
 t:=public.imo3d_commit_job(job->>'id',owner,old_revision,'verification-input',t||jsonb_build_object('published',true),'{}','[]');
 IF (t->>'revision')::bigint<>old_revision+1 OR (t->>'published')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'FAIL: job commit publication/revision'; END IF;
 job:=public.imo3d_enqueue_job(tour_id,'verification-input-2');job:=public.imo3d_claim_job(owner,300000);old_revision:=(t->>'revision')::bigint;t:=public.imo3d_save_tour(t,old_revision);
 blocked:=false;BEGIN PERFORM public.imo3d_commit_job(job->>'id',owner,old_revision,'verification-input-2',t,'{}','[]');EXCEPTION WHEN serialization_failure THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'FAIL: cancelled processing committed'; END IF;
 PERFORM public.imo3d_delete_project(project_id);
 IF EXISTS(SELECT 1 FROM public.imo3d_tours WHERE id=verification.tour_id) OR EXISTS(SELECT 1 FROM public.imo3d_upload_sessions WHERE public.imo3d_upload_sessions.tour_id=verification.tour_id) OR EXISTS(SELECT 1 FROM public.imo3d_brand_upload_sessions WHERE public.imo3d_brand_upload_sessions.project_id=verification.project_id) THEN RAISE EXCEPTION 'FAIL: synthetic project cleanup cascades'; END IF;
 RAISE NOTICE 'PASS: cloud transactions, uploads, branding, leases, CAS, privacy, and pagination verified; rolling back all synthetic rows';
END $verify$;
ROLLBACK;
