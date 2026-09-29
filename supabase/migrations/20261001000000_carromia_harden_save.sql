-- CARROMIA: harden save_tournament.
-- * The public copy is now derived in the database from the saved event (no mobile numbers,
--   check-in tokens or desk activity) instead of trusting the copy the browser sends.
-- * On the real event, officials who are not admins cannot change event settings, create the draw,
--   start a fresh event, or add/remove teams: the database compares the new event with the saved
--   one, whatever action name the client claims. Corrections and walkovers are refused by action
--   name (they look like ordinary results in the data, so that check is best effort and audited).
-- * The saved event must have the expected shape.
-- Run after 20260930010000_carromia_practice_devices.sql. Safe to re-run.

create or replace function public.public_copy(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(p_state, '{activity}', '[]'::jsonb), '{teams}', (
    select coalesce(jsonb_agg((x.t - 'checkinToken') || jsonb_build_object('players', (
      select coalesce(jsonb_agg(jsonb_build_object('name', p.v->>'name') order by p.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(x.t->'players', '[]'::jsonb)) with ordinality as p(v, n))) order by x.n), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_state->'teams', '[]'::jsonb)) with ordinality as x(t, n)))
$$;

create or replace function public.team_ids(p_state jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(t->>'id', ',' order by t->>'id'), '') from jsonb_array_elements(coalesce(p_state->'teams', '[]'::jsonb)) t
$$;

create or replace function public.save_tournament(p_expected bigint, p_state jsonb, p_public jsonb default null, p_action text default null, p_detail jsonb default null, p_id text default 'main')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_name text;
  v_role text;
  v_old jsonb;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    v_role := 'admin';
  else
    select name, role into v_name, v_role from public.officials where user_id = auth.uid();
    if v_name is null then raise exception 'Sign in as a tournament official.' using errcode = 'PT403'; end if;
  end if;
  if p_id not in ('main', 'practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  if jsonb_typeof(p_state->'event') is distinct from 'object' or jsonb_typeof(p_state->'teams') is distinct from 'array'
     or jsonb_typeof(p_state->'matches') is distinct from 'array' or jsonb_typeof(p_state->'boards') is distinct from 'array' then
    raise exception 'Invalid event data.' using errcode = 'PT400';
  end if;

  select state into v_old from public.tournament where id = p_id for update;
  if p_id = 'main' and v_role <> 'admin' then
    if p_action in ('draw', 'settings', 'reset', 'demo', 'remove-team', 'correct-result', 'walkover', 'undo-walkover') then
      raise exception 'Only an event admin can do this.' using errcode = 'PT403';
    end if;
    if v_old is not null then
      if p_state->'event' is distinct from v_old->'event' then raise exception 'Only an event admin can change event settings.' using errcode = 'PT403'; end if;
      if jsonb_array_length(p_state->'matches') <> jsonb_array_length(coalesce(v_old->'matches', '[]'::jsonb)) then raise exception 'Only an event admin can create the draw or start a fresh event.' using errcode = 'PT403'; end if;
      if public.team_ids(p_state) <> public.team_ids(v_old) then raise exception 'Only an event admin can add or remove teams.' using errcode = 'PT403'; end if;
    end if;
  end if;

  if p_expected = 0 then
    insert into public.tournament (id, version, state) values (p_id, 1, p_state) on conflict (id) do nothing returning version into v_version;
  else
    update public.tournament set state = p_state, version = version + 1, updated_at = now() where id = p_id and version = p_expected returning version into v_version;
  end if;
  if v_version is null then raise exception 'The event was changed from another session. Please try again.' using errcode = 'PT409'; end if;
  insert into public.tournament_public (id, version, state) values (p_id, v_version, public.public_copy(p_state))
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  if p_action is not null then
    insert into public.audit_log (actor_id, actor_name, action, detail)
    values (auth.uid(), coalesce(v_name, 'Server'), case when p_id = 'practice' then 'practice:' || p_action else p_action end, p_detail);
  end if;
  return v_version;
end $$;
revoke all on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb, text) from public, anon;
grant execute on function public.save_tournament(bigint, jsonb, jsonb, text, jsonb, text) to authenticated, service_role;

-- Refresh both public copies from the saved events, in case a browser ever sent a bad copy.
insert into public.tournament_public (id, version, state)
select id, version, public.public_copy(state) from public.tournament
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
