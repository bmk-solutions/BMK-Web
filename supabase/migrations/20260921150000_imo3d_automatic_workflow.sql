-- Scoped orchestration only: no photo, tour or existing plan data is modified.
create or replace function public.imo3d_start_tour_workflow(p_tour_id text,p_input_hash text,p_plan_hash text,p_scenes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.imo3d_tours; j jsonb; plan_id uuid;
begin
 select * into strict t from public.imo3d_tours where id=p_tour_id for update;
 if public.imo3d_plan_scene_snapshot(t.payload) is distinct from p_scenes then raise exception 'STALE' using errcode='40001'; end if;
 j:=public.imo3d_enqueue_job(p_tour_id,p_input_hash);
 if jsonb_array_length(t.payload->'scenes') between 2 and 100 then
  select id into plan_id from public.imo3d_subscription_plan_jobs where tour_id=p_tour_id and input_hash=p_plan_hash and status='draft' order by created_at desc limit 1;
  if plan_id is null then plan_id:=public.imo3d_enqueue_subscription_plan(p_tour_id,p_plan_hash,p_scenes); end if;
 end if;
 return j;
end $$;
create or replace function public.imo3d_cancel_tour_workflow(p_tour_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.imo3d_processing_jobs;
begin
 perform 1 from public.imo3d_tours where id=p_tour_id for update;
 if not found then raise exception 'TOUR_NOT_FOUND'; end if;
 update public.imo3d_processing_jobs set status='cancelled',cancel_requested=true,stage='أُلغيت المعالجة',updated_at=now()
 where tour_id=p_tour_id and status in ('queued','running');
 update public.imo3d_subscription_plan_jobs set status='cancelled',stage='أُلغي التحليل والمخطط'
 where tour_id=p_tour_id and status in ('queued','running');
 select * into j from public.imo3d_processing_jobs where tour_id=p_tour_id order by created_at desc,id desc limit 1;
 if j.id is null then return null; end if;
 return to_jsonb(j);
end $$;
revoke all on function public.imo3d_start_tour_workflow(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.imo3d_cancel_tour_workflow(text) from public,anon,authenticated;
grant execute on function public.imo3d_start_tour_workflow(text,text,text,jsonb) to service_role;
grant execute on function public.imo3d_cancel_tour_workflow(text) to service_role;
