begin;
create table public.imo3d_chatgpt_codes (
 code_hash text primary key, client_id text not null, redirect_uri text not null,
 challenge text not null, project_id text not null references public.imo3d_projects(id) on delete cascade,
 expires_at timestamptz not null
);
create table public.imo3d_chatgpt_connections (
 id uuid primary key, project_id text not null references public.imo3d_projects(id) on delete cascade,
 client_id text not null, access_hash text unique not null, refresh_hash text unique not null,
 expires_at timestamptz not null, refresh_expires_at timestamptz not null,
 created_at timestamptz not null default now(), revoked_at timestamptz
);
create table public.imo3d_chatgpt_drafts (
 id uuid primary key, project_id text not null references public.imo3d_projects(id) on delete cascade,
 tour_id text not null references public.imo3d_tours(id) on delete cascade, floor integer not null,
 input_hash text not null, result jsonb not null, created_at timestamptz not null default now()
);
alter table public.imo3d_chatgpt_codes enable row level security;
alter table public.imo3d_chatgpt_connections enable row level security;
alter table public.imo3d_chatgpt_drafts enable row level security;
revoke all on public.imo3d_chatgpt_codes,public.imo3d_chatgpt_connections,public.imo3d_chatgpt_drafts from public,anon,authenticated;
grant select,insert,delete on public.imo3d_chatgpt_codes to service_role;
grant select,insert,update on public.imo3d_chatgpt_connections to service_role;
grant select,insert on public.imo3d_chatgpt_drafts to service_role;
notify pgrst, 'reload schema';
commit;
