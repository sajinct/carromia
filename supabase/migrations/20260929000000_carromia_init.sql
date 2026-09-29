-- CARROMIA: tournament storage, officials and audit trail.
-- Only the server (secret key) reads or writes these tables. Row level security is enabled with
-- no policies, so the publishable/anon key and signed-in browser sessions get no access at all.

create table public.tournament (
  id text primary key default 'main',
  version bigint not null check (version > 0),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.officials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  role text not null check (role in ('admin', 'official')),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references auth.users (id) on delete set null,
  actor_name text not null,
  action text not null,
  detail jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

alter table public.tournament enable row level security;
alter table public.officials enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.tournament, public.officials, public.audit_log from anon, authenticated;
