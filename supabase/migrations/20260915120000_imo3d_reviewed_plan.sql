begin;
create function public.imo3d_use_furnished_draft(p_draft uuid,p_revision bigint,p_job text,p_key text,p_sha text,p_previous_job text) returns boolean language plpgsql security definer set search_path='' as $$
declare d public.imo3d_chatgpt_drafts;t public.imo3d_tours;previous text;scenes jsonb;metadata jsonb;
begin
 select * into strict d from public.imo3d_chatgpt_drafts where id=p_draft;
 select * into strict t from public.imo3d_tours where id=d.tour_id for update;
 if t.revision<>p_revision or t.project_id<>d.project_id or not (d.result ? 'furnished') then raise exception 'CONFLICT' using errcode='40001';end if;
 if p_key<>'reviewed-plans/'||d.project_id||'/'||d.tour_id||'/'||p_job||'.png' or p_sha !~ '^[a-f0-9]{64}$' then raise exception 'Invalid artifact';end if;
 select job_id into previous from public.imo3d_approved_plan_refs where tour_id=d.tour_id and floor=d.floor;
 if previous is distinct from p_previous_job then raise exception 'CONFLICT' using errcode='40001';end if;
 select jsonb_agg(s->>'id') into scenes from jsonb_array_elements(t.payload->'scenes') s where (s->>'floor')::integer=d.floor;
 metadata:=jsonb_build_object('source','administrator-reviewed-draft','sceneCount',jsonb_array_length(scenes),'limitations',jsonb_build_array('Photo-derived plan; not surveyed'),'floors',jsonb_build_array(jsonb_build_object('floor',d.floor,'sceneIds',scenes,'audit',jsonb_build_object('verdict','draft','issues','[]'::jsonb,'limitations','[]'::jsonb))));
 insert into public.imo3d_ai_plan_jobs(id,tour_id,input_hash,status,progress,stage,result) values(p_job,d.tour_id,d.input_hash,'draft',100,'مخطط اختارته الإدارة',metadata);
 insert into public.imo3d_approved_plan_refs(tour_id,floor,job_id,storage_key,sha256,navigation,public_metadata,scene_ids,input_hash)
 values(d.tour_id,d.floor,p_job,p_key,p_sha,null,'{}',scenes,d.input_hash)
 on conflict(tour_id,floor) do update set job_id=excluded.job_id,storage_key=excluded.storage_key,sha256=excluded.sha256,navigation=null,public_metadata=excluded.public_metadata,scene_ids=excluded.scene_ids,input_hash=excluded.input_hash;
 return true;
end $$;
revoke all on function public.imo3d_use_furnished_draft(uuid,bigint,text,text,text,text) from public,anon,authenticated;
grant execute on function public.imo3d_use_furnished_draft(uuid,bigint,text,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
