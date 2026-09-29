// Generates supabase/migrations/20260929010000_carromia_live.sql, seeding the sample tournament
// from the real engine so the SQL and the app always agree on its shape.
// Usage: node scripts/write-live-migration.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo, publicState } from '../lib/tournament.mjs';

const sample = seedDemo();
const json = value => { const text = JSON.stringify(value); if (text.includes('$seed$')) throw new Error('Seed contains the quote tag.'); return `$seed$${text}$seed$::jsonb`; };

const sql = `-- CARROMIA live site: the GitHub Pages app talks to Supabase directly.
-- Visitors read public.tournament_public (no mobile numbers or check-in tokens).
-- Officials read public.tournament and save through save_tournament(), which checks they are an
-- official, rejects stale saves, updates both copies together and writes the audit log.
-- Anyone may register a team through register_team(), which enforces the registration rules.
-- Run after 20260929000000_carromia_init.sql. Safe to re-run.

create table if not exists public.tournament_public (
  id text primary key default 'main',
  version bigint not null check (version > 0),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.tournament_public enable row level security;
grant select on public.tournament_public to anon, authenticated;
drop policy if exists "Anyone can read the public tournament" on public.tournament_public;
create policy "Anyone can read the public tournament" on public.tournament_public for select to anon, authenticated using (true);

create or replace function public.official_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.officials where user_id = auth.uid()
$$;

grant select on public.tournament, public.officials to authenticated;
drop policy if exists "Officials read the full tournament" on public.tournament;
create policy "Officials read the full tournament" on public.tournament for select to authenticated using (public.official_role() is not null);
drop policy if exists "Officials read their own profile" on public.officials;
create policy "Officials read their own profile" on public.officials for select to authenticated using (user_id = auth.uid());

-- Server clock in milliseconds, so every screen shows the same match timers.
create or replace function public.server_time() returns bigint
language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;
grant execute on function public.server_time() to anon, authenticated;

create or replace function public.save_tournament(p_expected bigint, p_state jsonb, p_public jsonb, p_action text default null, p_detail jsonb default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select name into v_name from public.officials where user_id = auth.uid();
    if v_name is null then raise exception 'Sign in as a tournament official.' using errcode = 'PT403'; end if;
  end if;
  if p_expected = 0 then
    insert into public.tournament (id, version, state) values ('main', 1, p_state) on conflict (id) do nothing returning version into v_version;
  else
    update public.tournament set state = p_state, version = version + 1, updated_at = now() where id = 'main' and version = p_expected returning version into v_version;
  end if;
  if v_version is null then raise exception 'The event was changed from another session. Please try again.' using errcode = 'PT409'; end if;
  insert into public.tournament_public (id, version, state) values ('main', v_version, p_public)
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  if p_action is not null then
    insert into public.audit_log (actor_id, actor_name, action, detail) values (auth.uid(), coalesce(v_name, 'Server'), p_action, p_detail);
  end if;
  return v_version;
end $$;
revoke all on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb) from public, anon;
grant execute on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb) to authenticated, service_role;

-- Mirrors addTeam() in lib/tournament.mjs.
create or replace function public.register_team(p_name text, p_parish text, p_players jsonb, p_primary int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_teams jsonb;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_parish text := left(btrim(coalesce(p_parish, '')), 80);
  v_players jsonb := '[]'::jsonb;
  v_player jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_team jsonb;
  v_version bigint;
begin
  select state into v_state from public.tournament where id = 'main' for update;
  if v_state is null then raise exception 'Registration is closed for this draw.' using errcode = 'PT400'; end if;
  if coalesce((v_state->>'demo')::boolean, false) then raise exception 'Registration will open soon. Please check back.' using errcode = 'PT400'; end if;
  if not coalesce((v_state->'event'->>'registrationOpen')::boolean, false) or jsonb_array_length(coalesce(v_state->'matches', '[]'::jsonb)) > 0 then
    raise exception 'Registration is closed for this draw.' using errcode = 'PT400';
  end if;
  if v_name = '' or v_parish = '' then raise exception 'Enter a team name and parish.' using errcode = 'PT400'; end if;
  if jsonb_typeof(p_players) is distinct from 'array' or jsonb_array_length(p_players) <> 2 then
    raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
  end if;
  for v_player in select value from jsonb_array_elements(p_players) loop
    if left(btrim(coalesce(v_player->>'name', '')), 80) = '' or left(btrim(coalesce(v_player->>'mobile', '')), 20) !~ '^\\+?[0-9 ()-]{7,20}$' then
      raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
    end if;
    v_players := v_players || jsonb_build_array(jsonb_build_object('name', left(btrim(v_player->>'name'), 80), 'mobile', left(btrim(v_player->>'mobile'), 20)));
  end loop;
  v_teams := coalesce(v_state->'teams', '[]'::jsonb);
  if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
    raise exception 'That team name is already registered.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(v_teams) >= 128 then raise exception 'This version supports up to 128 teams.' using errcode = 'PT400'; end if;

  v_team := jsonb_build_object('id', 'CAR-' || lpad((jsonb_array_length(v_teams) + 1)::text, 3, '0'), 'name', v_name, 'parish', v_parish,
    'players', v_players, 'primaryContact', case when p_primary = 1 then 1 else 0 end, 'checkedIn', false, 'registeredAt', v_now, 'checkinToken', gen_random_uuid());
  v_state := jsonb_set(v_state, '{teams}', v_teams || jsonb_build_array(v_team));
  v_state := jsonb_set(v_state, '{activity}', (
    select coalesce(jsonb_agg(x.a order by x.n), '[]'::jsonb)
    from jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'message', v_name || ' registered', 'at', v_now)) || coalesce(v_state->'activity', '[]'::jsonb)) with ordinality as x(a, n)
    where x.n <= 80));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = 'main' returning version into v_version;
  update public.tournament_public set version = v_version, updated_at = now(), state = jsonb_set(state, '{teams}', coalesce(state->'teams', '[]'::jsonb)
    || jsonb_build_array((v_team - 'checkinToken') || jsonb_build_object('players', (select jsonb_agg(jsonb_build_object('name', p->>'name')) from jsonb_array_elements(v_players) p))))
    where id = 'main';
  insert into public.audit_log (actor_name, action, detail) values ('Public registration', 'register', jsonb_build_object('team', v_team->>'id', 'name', v_name));
  return jsonb_build_object('team', v_team);
end $$;
revoke all on function public.register_team(text, text, jsonb, int) from public;
grant execute on function public.register_team(text, text, jsonb, int) to anon, authenticated;

-- Sample tournament (fictional teams) so the site is live straight away.
-- Clear it before the real event: Tournament desk -> Settings -> Start a fresh event.
-- An existing event is never overwritten, and its private data is never copied to the public table.
do $$
begin
  insert into public.tournament (id, version, state) values ('main', 1, ${json(sample)}) on conflict (id) do nothing;
  if found then
    insert into public.tournament_public (id, version, state) values ('main', 1, ${json(publicState(sample))}) on conflict (id) do nothing;
  end if;
end $$;
`;
writeFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '20260929010000_carromia_live.sql'), sql);
console.log('Wrote supabase/migrations/20260929010000_carromia_live.sql');
