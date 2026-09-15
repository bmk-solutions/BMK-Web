-- Additive private queue. Existing tours, assets and approved plans are untouched.
begin;
create table public.imo3d_plan_workers(id text primary key,seen_at timestamptz not null);
create table public.imo3d_subscription_plan_jobs(
 id uuid primary key default gen_random_uuid(),tour_id text not null references public.imo3d_tours on delete cascade,
 project_id text not null references public.imo3d_projects on delete cascade,input_hash text not null,scene_snapshot jsonb not null,
 status text not null default 'queued' check(status in ('queued','running','draft','failed','cancelled','stale')),
 stage text not null default 'في انتظار عامل ChatGPT',error text,worker_id uuid,lease_until timestamptz,draft_ids uuid[],
 created_at timestamptz not null default now());
create unique index imo3d_subscription_plan_active on public.imo3d_subscription_plan_jobs(tour_id) where status in ('queued','running');
alter table public.imo3d_plan_workers enable row level security;
alter table public.imo3d_subscription_plan_jobs enable row level security;
revoke all on public.imo3d_plan_workers,public.imo3d_subscription_plan_jobs from public,anon,authenticated;
grant select,insert,update on public.imo3d_plan_workers,public.imo3d_subscription_plan_jobs to service_role;

create function public.imo3d_plan_scene_snapshot(p_payload jsonb) returns jsonb language sql immutable set search_path=public as $$
 select jsonb_agg(jsonb_build_object('id',s->>'id','image',s->>'image','floor',s->'floor') order by s->>'id') from jsonb_array_elements(p_payload->'scenes') s;
$$;
create function public.imo3d_enqueue_subscription_plan(p_tour_id text,p_hash text,p_scenes jsonb) returns uuid language plpgsql security definer set search_path=public as $$
declare t public.imo3d_tours; j uuid;
begin
 select * into strict t from public.imo3d_tours where id=p_tour_id for update;
 if public.imo3d_plan_scene_snapshot(t.payload) is distinct from p_scenes then raise exception 'STALE'; end if;
 update public.imo3d_subscription_plan_jobs set status='failed',stage='انقطع عامل المعالجة' where tour_id=p_tour_id and status='running' and lease_until<now();
 select id into j from public.imo3d_subscription_plan_jobs where tour_id=p_tour_id and status in ('queued','running');
 if j is null then insert into public.imo3d_subscription_plan_jobs(tour_id,project_id,input_hash,scene_snapshot) values(p_tour_id,t.project_id,p_hash,p_scenes) returning id into j; end if;
 return j;
end $$;
create function public.imo3d_claim_subscription_plan(p_worker uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.imo3d_subscription_plan_jobs;
begin
 update public.imo3d_subscription_plan_jobs set status='failed',stage='انقطع عامل المعالجة؛ أعد المحاولة' where status='running' and lease_until<now();
 select * into j from public.imo3d_subscription_plan_jobs where status='queued' order by created_at for update skip locked limit 1;
 if j.id is null then return null; end if;
 update public.imo3d_subscription_plan_jobs set status='running',worker_id=p_worker,lease_until=now()+interval '90 seconds',stage='تجهيز صور المشروع' where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
create function public.imo3d_finish_subscription_plan(p_id uuid,p_worker uuid,p_drafts jsonb) returns boolean language plpgsql security definer set search_path=public as $$
declare j public.imo3d_subscription_plan_jobs;t public.imo3d_tours;d jsonb;ids uuid[]='{}';
begin
 select * into strict j from public.imo3d_subscription_plan_jobs where id=p_id for update;
 if j.status<>'running' or j.worker_id is distinct from p_worker or j.lease_until<now() then return false; end if;
 select * into strict t from public.imo3d_tours where id=j.tour_id for update;
 if public.imo3d_plan_scene_snapshot(t.payload) is distinct from j.scene_snapshot then
  update public.imo3d_subscription_plan_jobs set status='stale',stage='تغيرت الصور؛ أعد التحليل' where id=j.id;return false;
 end if;
 if jsonb_array_length(p_drafts)<1 then raise exception 'Missing drafts'; end if;
 for d in select * from jsonb_array_elements(p_drafts) loop
  insert into public.imo3d_chatgpt_drafts(id,project_id,tour_id,floor,input_hash,result)
   values((d->>'id')::uuid,j.project_id,j.tour_id,(d->>'floor')::integer,j.input_hash,d->'result');
  ids=array_append(ids,(d->>'id')::uuid);
 end loop;
 update public.imo3d_subscription_plan_jobs set status='draft',draft_ids=ids,stage='المخطط المفروش جاهز للمراجعة وتعديل الأسماء',lease_until=null where id=j.id;
 return true;
end $$;
revoke all on function public.imo3d_plan_scene_snapshot(jsonb),public.imo3d_enqueue_subscription_plan(text,text,jsonb),public.imo3d_claim_subscription_plan(uuid),public.imo3d_finish_subscription_plan(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.imo3d_enqueue_subscription_plan(text,text,jsonb),public.imo3d_claim_subscription_plan(uuid),public.imo3d_finish_subscription_plan(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
