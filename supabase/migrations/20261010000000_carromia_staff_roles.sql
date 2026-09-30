-- CARROMIA: one-job desk roles for volunteers on the day, beside admins and officials.
-- * 'checkin': checks teams in (or takes a check-in back). Nothing else.
-- * 'lunch': serves booked lunches from the coupons (or undoes one). Nothing else.
-- * 'umpire': runs the matches on the boards an admin assigned to them (officials.boards): starts
--   a match, marks round winners, starts the next round, takes back a round and marks the board
--   ready. The desk still calls matches to boards.
-- On the real event save_tournament() compares the new event with the saved one and refuses any
-- change outside the role's job, whatever the browser sends. Practice is not checked, as before.
-- Private files: player photos are for admins, officials and the check-in desk; payment
-- screenshots for admins and officials only.
-- Run after 20261009000000_carromia_realtime_versions.sql. Safe to re-run.

alter table public.officials drop constraint if exists officials_role_check;
alter table public.officials add constraint officials_role_check check (role in ('admin', 'official', 'checkin', 'lunch', 'umpire'));
alter table public.officials add column if not exists boards int[] not null default '{}';
alter table public.officials drop constraint if exists officials_boards_check;
alter table public.officials add constraint officials_boards_check check (
  (role = 'umpire' and cardinality(boards) > 0 and boards <@ array[1, 2, 3, 4]) or (role <> 'umpire' and cardinality(boards) = 0));

drop policy if exists "Officials read player photos" on public.player_photos;
create policy "Officials read player photos" on public.player_photos for select to authenticated
  using (public.official_role() in ('admin', 'official', 'checkin'));
drop policy if exists "Officials read payment proofs" on public.payment_proofs;
create policy "Officials read payment proofs" on public.payment_proofs for select to authenticated
  using (public.official_role() in ('admin', 'official'));
drop policy if exists "Officials read team files" on storage.objects;
create policy "Officials read team files" on storage.objects for select to authenticated
  using (bucket_id = 'team-files' and (public.official_role() in ('admin', 'official')
    or (public.official_role() = 'checkin' and name !~ '/payment\.jpg$')));

-- The teams without the keys a role may change, to compare the new event with the saved one.
create or replace function public.teams_without(p_teams jsonb, p_keys text[]) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(x.t - p_keys order by x.n), '[]'::jsonb) from jsonb_array_elements(coalesce(p_teams, '[]'::jsonb)) with ordinality as x(t, n)
$$;

create or replace function public.save_tournament(p_expected bigint, p_state jsonb, p_public jsonb default null, p_action text default null, p_detail jsonb default null, p_id text default 'main')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_name text;
  v_role text;
  v_boards int[];
  v_old jsonb;
  v_keys text[];
begin
  if coalesce(auth.role(), '') = 'service_role' then
    v_role := 'admin';
  else
    select name, role, boards into v_name, v_role, v_boards from public.officials where user_id = auth.uid();
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

  -- The one-job roles: only their own action, and only the part of the event it changes.
  if p_id = 'main' and v_role in ('checkin', 'lunch', 'umpire') then
    if v_old is null or not coalesce(p_action = any (case v_role when 'checkin' then array['checkin'] when 'lunch' then array['serve-lunch']
        else array['start', 'round-winner', 'next-round', 'undo-round', 'board-ready'] end), false) then
      raise exception 'This isn’t part of your role on the desk.' using errcode = 'PT403';
    end if;
    if (p_state - 'activity' - 'teams' - 'matches' - 'boards') is distinct from (v_old - 'activity' - 'teams' - 'matches' - 'boards') then
      raise exception 'This isn’t part of your role on the desk.' using errcode = 'PT403';
    end if;
    if v_role in ('checkin', 'lunch') then
      v_keys := case v_role when 'checkin' then array['checkedIn'] else array['lunchServed', 'lunchServedAt'] end;
      if p_state->'matches' is distinct from v_old->'matches' or p_state->'boards' is distinct from v_old->'boards'
         or public.teams_without(p_state->'teams', v_keys) is distinct from public.teams_without(v_old->'teams', v_keys) then
        raise exception 'This isn’t part of your role on the desk.' using errcode = 'PT403';
      end if;
    else
      if p_state->'teams' is distinct from v_old->'teams' then raise exception 'Umpires can’t change teams.' using errcode = 'PT403'; end if;
      -- Only the umpire's own boards change (a board is reset after a match, or marked ready).
      if exists (select 1 from jsonb_array_elements(p_state->'boards') with ordinality as n(b, i)
          full join jsonb_array_elements(coalesce(v_old->'boards', '[]'::jsonb)) with ordinality as o(b, i) on n.i = o.i
          where n.b is distinct from o.b and not coalesce((o.b->>'id')::int = any (v_boards) and n.b->'id' = o.b->'id', false)) then
        raise exception 'This board isn’t assigned to you.' using errcode = 'PT403';
      end if;
      -- Only matches on the umpire's boards change, plus later-round matches that were waiting for
      -- a winner and are filled in when a match ends.
      if exists (select 1 from jsonb_array_elements(p_state->'matches') with ordinality as n(m, i)
          full join jsonb_array_elements(coalesce(v_old->'matches', '[]'::jsonb)) with ordinality as o(m, i) on n.i = o.i
          where n.m is distinct from o.m and not coalesce(n.m->'id' = o.m->'id' and (
            ((o.m->>'board')::int = any (v_boards) and n.m->'board' = o.m->'board')
            or (o.m->>'status' = 'waiting' and coalesce(n.m->>'board', '') = '')), false)) then
        raise exception 'This board isn’t assigned to you.' using errcode = 'PT403';
      end if;
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
