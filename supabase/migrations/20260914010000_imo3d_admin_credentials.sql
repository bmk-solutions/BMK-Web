begin;
create table if not exists public.imo3d_admin_credentials (
  id text primary key default 'administrator' check (id = 'administrator'),
  password_hash text not null check (password_hash ~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$'),
  version uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.imo3d_admin_credentials enable row level security;
revoke all on public.imo3d_admin_credentials from public, anon, authenticated;
grant select, insert, update on public.imo3d_admin_credentials to service_role;
notify pgrst, 'reload schema';
commit;
