-- CARROMIA: practice mode on any device (TV, phones) for full-flow rehearsals.
-- * The practice event gets its own public copy (id 'practice' in tournament_public, without
--   mobile numbers or check-in tokens), so devices opened with ?practice=1 can follow it
--   without signing in.
-- * register_team() can register into the practice event, so phones can rehearse registration.
-- The real event is unaffected. Run after 20260930000000_carromia_practice.sql. Safe to re-run.

create or replace function public.save_tournament(p_expected bigint, p_state jsonb, p_public jsonb, p_action text default null, p_detail jsonb default null, p_id text default 'main')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select name into v_name from public.officials where user_id = auth.uid();
    if v_name is null then raise exception 'Sign in as a tournament official.' using errcode = 'PT403'; end if;
  end if;
  if p_id not in ('main', 'practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  if p_expected = 0 then
    insert into public.tournament (id, version, state) values (p_id, 1, p_state) on conflict (id) do nothing returning version into v_version;
  else
    update public.tournament set state = p_state, version = version + 1, updated_at = now() where id = p_id and version = p_expected returning version into v_version;
  end if;
  if v_version is null then raise exception 'The event was changed from another session. Please try again.' using errcode = 'PT409'; end if;
  insert into public.tournament_public (id, version, state) values (p_id, v_version, p_public)
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  if p_action is not null then
    insert into public.audit_log (actor_id, actor_name, action, detail)
    values (auth.uid(), coalesce(v_name, 'Server'), case when p_id = 'practice' then 'practice:' || p_action else p_action end, p_detail);
  end if;
  return v_version;
end $$;
revoke all on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb, text) from public, anon;
grant execute on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb, text) to authenticated, service_role;

-- Mirrors addTeam() and nextTeamId() in lib/tournament.mjs; p_event chooses the real or practice event.
drop function if exists public.register_team(text, text, jsonb, int);
create or replace function public.register_team(p_name text, p_parish text, p_players jsonb, p_primary int default 0, p_event text default 'main')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_teams jsonb;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_parish text := left(btrim(coalesce(p_parish, '')), 80);
  v_players jsonb := '[]'::jsonb;
  v_player jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_seq int;
  v_team jsonb;
  v_version bigint;
begin
  if p_event not in ('main', 'practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  select state into v_state from public.tournament where id = p_event for update;
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
    if left(btrim(coalesce(v_player->>'name', '')), 80) = '' or left(btrim(coalesce(v_player->>'mobile', '')), 20) !~ '^\+?[0-9 ()-]{7,20}$' then
      raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
    end if;
    v_players := v_players || jsonb_build_array(jsonb_build_object('name', left(btrim(v_player->>'name'), 80), 'mobile', left(btrim(v_player->>'mobile'), 20)));
  end loop;
  v_teams := coalesce(v_state->'teams', '[]'::jsonb);
  if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
    raise exception 'That team name is already registered.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(v_teams) >= 128 then raise exception 'This version supports up to 128 teams.' using errcode = 'PT400'; end if;

  v_seq := greatest(coalesce((v_state->>'teamSeq')::int, 0),
    coalesce((select max(nullif(regexp_replace(t->>'id', '\D', '', 'g'), '')::int) from jsonb_array_elements(v_teams) t), 0)) + 1;
  v_team := jsonb_build_object('id', 'CAR-' || lpad(v_seq::text, 3, '0'), 'name', v_name, 'parish', v_parish,
    'players', v_players, 'primaryContact', case when p_primary = 1 then 1 else 0 end, 'checkedIn', false, 'registeredAt', v_now, 'checkinToken', gen_random_uuid());
  v_state := jsonb_set(v_state, '{teams}', v_teams || jsonb_build_array(v_team));
  v_state := jsonb_set(v_state, '{teamSeq}', to_jsonb(v_seq));
  v_state := jsonb_set(v_state, '{activity}', (
    select coalesce(jsonb_agg(x.a order by x.n), '[]'::jsonb)
    from jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'message', v_name || ' registered', 'at', v_now)) || coalesce(v_state->'activity', '[]'::jsonb)) with ordinality as x(a, n)
    where x.n <= 80));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = p_event returning version into v_version;
  update public.tournament_public set version = v_version, updated_at = now(), state = jsonb_set(jsonb_set(state, '{teamSeq}', to_jsonb(v_seq)), '{teams}', coalesce(state->'teams', '[]'::jsonb)
    || jsonb_build_array((v_team - 'checkinToken') || jsonb_build_object('players', (select jsonb_agg(jsonb_build_object('name', p->>'name')) from jsonb_array_elements(v_players) p))))
    where id = p_event;
  insert into public.audit_log (actor_name, action, detail)
  values ('Public registration', case when p_event = 'practice' then 'practice:register' else 'register' end, jsonb_build_object('team', v_team->>'id', 'name', v_name));
  return jsonb_build_object('team', v_team);
end $$;
revoke all on function public.register_team(text, text, jsonb, int, text) from public;
grant execute on function public.register_team(text, text, jsonb, int, text) to anon, authenticated;

-- Public copy of the existing practice event: no mobile numbers, check-in tokens or activity.
insert into public.tournament_public (id, version, state)
select 'practice', version, jsonb_set(jsonb_set(state, '{activity}', '[]'::jsonb), '{teams}', (
  select coalesce(jsonb_agg((x.t - 'checkinToken') || jsonb_build_object('players', (select coalesce(jsonb_agg(jsonb_build_object('name', p.v->>'name') order by p.n), '[]'::jsonb) from jsonb_array_elements(x.t->'players') with ordinality as p(v, n))) order by x.n), '[]'::jsonb)
  from jsonb_array_elements(coalesce(state->'teams', '[]'::jsonb)) with ordinality as x(t, n)))
from public.tournament where id = 'practice'
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
