-- Strip render-only arrays inside PostgreSQL, before transporting the dashboard.
-- This is a read-only projection; the stored tour and private assets stay intact.
create or replace function public.imo3d_list_tour_summaries(p_project_id text default null)
returns setof jsonb language sql stable security definer set search_path='' as $$
 select (t.payload - 'photoEdits') || jsonb_build_object('scenes', coalesce((
   select jsonb_agg(s.value - 'depth' - 'displayDepth' order by s.ordinality)
   from jsonb_array_elements(t.payload->'scenes') with ordinality s(value,ordinality)
 ), '[]'::jsonb))
 from public.imo3d_tours t
 where p_project_id is null or t.project_id = p_project_id
 order by t.payload->>'updatedAt' desc nulls last, t.id;
$$;
revoke all on function public.imo3d_list_tour_summaries(text) from public,anon,authenticated;
grant execute on function public.imo3d_list_tour_summaries(text) to service_role;
