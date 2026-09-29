-- CARROMIA: tournament rules and registration limits from the published poster.
-- * register_team() now enforces the total team slots (64), the most teams per parish (4) and the
--   registration deadline (10 Nov 2026, end of day in India; real event only), records the lunch
--   pre-booking and requires the 18+ confirmation. The limits are event settings an admin can
--   change in the desk; events saved before this use the defaults below.
-- * Matches are the best of three games in 30 minutes, so an event still on the earlier
--   10-minute default moves to 30. Matches already started keep their own end time.
-- Run after 20261001000000_carromia_harden_save.sql. Safe to re-run.

-- Mirrors parishKey() in lib/tournament.mjs: "St. Thomas" and "st thomas church" are one parish.
create or replace function public.parish_key(p_name text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'), '\m(church|parish)\M', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- Mirrors addTeam(), registrationStatus() and nextTeamId() in lib/tournament.mjs.
drop function if exists public.register_team(text, text, jsonb, int, text);
create or replace function public.register_team(p_name text, p_parish text, p_players jsonb, p_primary int default 0, p_event text default 'main', p_lunch int default 0, p_adults boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_teams jsonb;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_parish text := left(btrim(coalesce(p_parish, '')), 80);
  v_players jsonb := '[]'::jsonb;
  v_player jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_max int;
  v_per_parish int;
  v_deadline text;
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
  v_teams := coalesce(v_state->'teams', '[]'::jsonb);
  v_max := coalesce((v_state->'event'->>'maxTeams')::int, 64);
  v_per_parish := coalesce((v_state->'event'->>'maxTeamsPerParish')::int, 4);
  v_deadline := coalesce(v_state->'event'->>'registrationDeadline', '2026-11-10');
  if p_event = 'main' and v_deadline ~ '^\d{4}-\d{2}-\d{2}$' and now() >= ((v_deadline::date + 1)::timestamp at time zone 'Asia/Kolkata') then
    raise exception 'Registration closed on %.', to_char(v_deadline::date, 'FMDD FMMonth YYYY') using errcode = 'PT400';
  end if;
  if jsonb_array_length(v_teams) >= v_max then raise exception 'All % team slots are taken. Registration is full.', v_max using errcode = 'PT400'; end if;

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
  if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
    raise exception 'That team name is already registered.' using errcode = 'PT400';
  end if;
  if not coalesce(p_adults, false) then raise exception 'Confirm that both players are 18 or older.' using errcode = 'PT400'; end if;
  if (select count(*) from jsonb_array_elements(v_teams) t where public.parish_key(t->>'parish') = public.parish_key(v_parish)) >= v_per_parish then
    raise exception '% already has % teams registered, the most allowed for one parish.', v_parish, v_per_parish using errcode = 'PT400';
  end if;

  v_seq := greatest(coalesce((v_state->>'teamSeq')::int, 0),
    coalesce((select max(nullif(regexp_replace(t->>'id', '\D', '', 'g'), '')::int) from jsonb_array_elements(v_teams) t), 0)) + 1;
  v_team := jsonb_build_object('id', 'CAR-' || lpad(v_seq::text, 3, '0'), 'name', v_name, 'parish', v_parish,
    'players', v_players, 'primaryContact', case when p_primary = 1 then 1 else 0 end, 'lunch', least(2, greatest(0, coalesce(p_lunch, 0))),
    'checkedIn', false, 'registeredAt', v_now, 'checkinToken', gen_random_uuid());
  v_state := jsonb_set(v_state, '{teams}', v_teams || jsonb_build_array(v_team));
  v_state := jsonb_set(v_state, '{teamSeq}', to_jsonb(v_seq));
  v_state := jsonb_set(v_state, '{activity}', (
    select coalesce(jsonb_agg(x.a order by x.n), '[]'::jsonb)
    from jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'message', v_name || ' registered', 'at', v_now)) || coalesce(v_state->'activity', '[]'::jsonb)) with ordinality as x(a, n)
    where x.n <= 80));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = p_event returning version into v_version;
  insert into public.tournament_public (id, version, state) values (p_event, v_version, public.public_copy(v_state))
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  insert into public.audit_log (actor_name, action, detail)
  values ('Public registration', case when p_event = 'practice' then 'practice:register' else 'register' end, jsonb_build_object('team', v_team->>'id', 'name', v_name));
  return jsonb_build_object('team', v_team);
end $$;
revoke all on function public.register_team(text, text, jsonb, int, text, int, boolean) from public;
grant execute on function public.register_team(text, text, jsonb, int, text, int, boolean) to anon, authenticated;

-- Best of three games in 30 minutes: move events still on the earlier 10-minute default.
update public.tournament set state = jsonb_set(state, '{event,durationMinutes}', '30'::jsonb), version = version + 1, updated_at = now()
where state->'event'->>'durationMinutes' = '10';
insert into public.tournament_public (id, version, state)
select id, version, public.public_copy(state) from public.tournament
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
