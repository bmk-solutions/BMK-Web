-- Isolated signed logo uploads. Run only in the dedicated IMO3D project.
BEGIN;
CREATE TABLE public.imo3d_brand_upload_sessions(
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES public.imo3d_projects ON DELETE CASCADE,
 size bigint NOT NULL CHECK(size BETWEEN 1 AND 5242880),mime text NOT NULL CHECK(mime IN('image/jpeg','image/png','image/webp')),
 object_key text NOT NULL UNIQUE,name text NOT NULL,accent text NOT NULL,logo_style text NOT NULL CHECK(logo_style IN('clean','original')),
 prior_updated_at timestamptz,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','completed')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours',lease_token text,lease_until timestamptz);
CREATE INDEX imo3d_brand_upload_project ON public.imo3d_brand_upload_sessions(project_id);
ALTER TABLE public.imo3d_brand_upload_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.imo3d_brand_upload_sessions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.imo3d_brand_upload_sessions TO service_role;
CREATE FUNCTION public.imo3d_begin_brand_upload(p_id text,p_project_id text,p_size bigint,p_mime text,p_object_key text,p_name text,p_accent text,p_logo_style text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous timestamptz;
BEGIN
 PERFORM 1 FROM public.imo3d_projects WHERE id=p_project_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF length(trim(p_name))<1 OR length(p_name)>80 OR p_accent !~ '^#[0-9a-f]{6}$' THEN RAISE EXCEPTION 'INVALID_BRANDING'; END IF;
 IF (SELECT count(*) FROM public.imo3d_brand_upload_sessions WHERE project_id=p_project_id AND status<>'completed' AND expires_at>now())>=10 THEN RAISE EXCEPTION 'TOO_MANY_PENDING_UPLOADS'; END IF;
 SELECT updated_at INTO previous FROM public.imo3d_project_branding WHERE project_id=p_project_id;
 INSERT INTO public.imo3d_brand_upload_sessions(id,project_id,size,mime,object_key,name,accent,logo_style,prior_updated_at) VALUES(p_id,p_project_id,p_size,p_mime,p_object_key,p_name,p_accent,p_logo_style,previous);
 RETURN true;
END $$;
CREATE FUNCTION public.imo3d_claim_brand_upload(p_id text,p_project_id text,p_lease text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.imo3d_brand_upload_sessions;
BEGIN
 SELECT * INTO u FROM public.imo3d_brand_upload_sessions WHERE id=p_id AND project_id=p_project_id FOR UPDATE;
 IF u.id IS NULL OR u.expires_at<now() OR u.status='completed' OR (u.status='processing' AND u.lease_until>now()) THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 UPDATE public.imo3d_brand_upload_sessions SET status='processing',lease_token=p_lease,lease_until=now()+interval '5 minutes' WHERE id=p_id;
 RETURN true;
END $$;
CREATE FUNCTION public.imo3d_release_brand_upload(p_id text,p_lease text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.imo3d_brand_upload_sessions SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=p_id AND lease_token=p_lease AND status='processing';RETURN FOUND;
END $$;
CREATE FUNCTION public.imo3d_commit_brand_upload(p_id text,p_project_id text,p_lease text,p_asset jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.imo3d_brand_upload_sessions; current_updated_at timestamptz;
BEGIN
 PERFORM 1 FROM public.imo3d_projects WHERE id=p_project_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO u FROM public.imo3d_brand_upload_sessions WHERE id=p_id AND project_id=p_project_id FOR UPDATE;
 IF u.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF u.status='completed' THEN RETURN true; END IF;
 IF u.status<>'processing' OR u.lease_token IS DISTINCT FROM p_lease OR u.lease_until<now() THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 SELECT updated_at INTO current_updated_at FROM public.imo3d_project_branding WHERE project_id=p_project_id FOR UPDATE;
 IF current_updated_at IS DISTINCT FROM u.prior_updated_at THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_asset->>'mime'<>'image/webp' OR p_asset->>'storage_key' NOT LIKE 'branding/'||p_project_id||'/%' OR (p_asset->>'byte_size')::bigint<1 THEN RAISE EXCEPTION 'INVALID_LOGO'; END IF;
 INSERT INTO public.imo3d_project_brand_assets(id,project_id,mime,storage_key,sha256,byte_size) VALUES(p_asset->>'id',p_project_id,'image/webp',p_asset->>'storage_key',p_asset->>'sha256',(p_asset->>'byte_size')::bigint);
 INSERT INTO public.imo3d_project_branding(project_id,name,accent,logo_asset_id,logo_style,updated_at) VALUES(p_project_id,u.name,u.accent,p_asset->>'id',u.logo_style,clock_timestamp())
 ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,accent=excluded.accent,logo_asset_id=excluded.logo_asset_id,logo_style=excluded.logo_style,updated_at=excluded.updated_at;
 UPDATE public.imo3d_brand_upload_sessions SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.imo3d_begin_brand_upload(text,text,bigint,text,text,text,text,text),public.imo3d_claim_brand_upload(text,text,text),public.imo3d_release_brand_upload(text,text),public.imo3d_commit_brand_upload(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imo3d_begin_brand_upload(text,text,bigint,text,text,text,text,text),public.imo3d_claim_brand_upload(text,text,text),public.imo3d_release_brand_upload(text,text),public.imo3d_commit_brand_upload(text,text,text,jsonb) TO service_role;
COMMIT;
