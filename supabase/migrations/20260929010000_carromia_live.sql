-- CARROMIA live site: the GitHub Pages app talks to Supabase directly.
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
  insert into public.tournament (id, version, state) values ('main', 1, $seed${"version":1,"event":{"name":"CARROMIA","year":"2026","venue":"Mary Matha Church, Vijayanagar","date":"2026-11-15","startTime":"09:00","durationMinutes":10,"resetMinutes":5,"restMinutes":0,"registrationOpen":false},"teams":[{"id":"CAR-001","name":"Baseline Brothers","parish":"Mary Matha","players":[{"name":"Arun Demo","mobile":"9000000000"},{"name":"Paul Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084945,"checkinToken":"936505bf-56ca-4110-b21e-c8fb86f14796"},{"id":"CAR-002","name":"The Strikers","parish":"St. Thomas","players":[{"name":"Joel Demo","mobile":"9000000000"},{"name":"Joseph Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"5dce33de-d3cb-46f7-a5c3-1980c08e06b1"},{"id":"CAR-003","name":"Pocket Aces","parish":"St. Joseph","players":[{"name":"Mathew Demo","mobile":"9000000000"},{"name":"Kevin Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"25554851-5375-494b-91f8-ea81d55b207d"},{"id":"CAR-004","name":"Royal Knights","parish":"Holy Family","players":[{"name":"Paul Demo","mobile":"9000000000"},{"name":"Thomas Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"94603d4d-951b-47ec-96d8-bb2663aebf04"},{"id":"CAR-005","name":"Corner Kings","parish":"Mary Matha","players":[{"name":"Joseph Demo","mobile":"9000000000"},{"name":"Mark Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"d96dd70d-164a-4a9c-a93f-8cc0342c626b"},{"id":"CAR-006","name":"White Knights","parish":"St. Thomas","players":[{"name":"Kevin Demo","mobile":"9000000000"},{"name":"Arun Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"1ae1fece-ff35-478d-859b-7b5b9d5d5327"},{"id":"CAR-007","name":"Queen’s Guard","parish":"St. Joseph","players":[{"name":"Thomas Demo","mobile":"9000000000"},{"name":"Joel Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"f60bb9fd-ff8a-416e-80d7-3e5313126029"},{"id":"CAR-008","name":"Black & Bold","parish":"Holy Family","players":[{"name":"Mark Demo","mobile":"9000000000"},{"name":"Mathew Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"60232268-33bc-4c32-8b65-316064ea85a9"},{"id":"CAR-009","name":"Double Trouble","parish":"Mary Matha","players":[{"name":"Arun Demo","mobile":"9000000000"},{"name":"Paul Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"769a2830-f929-4bcd-bdae-5c6c1c05cd8a"},{"id":"CAR-010","name":"The Challengers","parish":"St. Thomas","players":[{"name":"Joel Demo","mobile":"9000000000"},{"name":"Joseph Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"3a94cf11-a46f-4fad-a89a-2cff3588e73b"},{"id":"CAR-011","name":"Strike Force","parish":"St. Joseph","players":[{"name":"Mathew Demo","mobile":"9000000000"},{"name":"Kevin Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"c57eac7a-0e3f-4a41-83b7-8a834267cc6f"},{"id":"CAR-012","name":"Last Coin","parish":"Holy Family","players":[{"name":"Paul Demo","mobile":"9000000000"},{"name":"Thomas Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"8563de7e-473a-49cc-b90a-5eeaa58bd4e5"},{"id":"CAR-013","name":"Board Brothers","parish":"Mary Matha","players":[{"name":"Joseph Demo","mobile":"9000000000"},{"name":"Mark Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"8fa6ecf4-0d70-41b7-9f28-6efbce91b3f5"},{"id":"CAR-014","name":"Perfect Pocket","parish":"St. Thomas","players":[{"name":"Kevin Demo","mobile":"9000000000"},{"name":"Arun Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"0f2119df-2271-41e5-a70f-d08abd1e261e"},{"id":"CAR-015","name":"The Finishers","parish":"St. Joseph","players":[{"name":"Thomas Demo","mobile":"9000000000"},{"name":"Joel Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"b7ecd53f-6f1c-4507-9e34-cbde8444b3fd"},{"id":"CAR-016","name":"Carrom Collective","parish":"Holy Family","players":[{"name":"Mark Demo","mobile":"9000000000"},{"name":"Mathew Demo","mobile":"9000000000"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946,"checkinToken":"dd286a12-a38a-4c45-973a-e1e51cefd372"}],"matches":[{"id":"M01","round":1,"roundName":"Round of 16","teamA":"CAR-001","teamB":"CAR-016","sources":[],"status":"called","board":1,"winner":null},{"id":"M02","round":1,"roundName":"Round of 16","teamA":"CAR-008","teamB":"CAR-009","sources":[],"status":"called","board":2,"winner":null},{"id":"M03","round":1,"roundName":"Round of 16","teamA":"CAR-004","teamB":"CAR-013","sources":[],"status":"called","board":3,"winner":null},{"id":"M04","round":1,"roundName":"Round of 16","teamA":"CAR-005","teamB":"CAR-012","sources":[],"status":"called","board":4,"winner":null},{"id":"M05","round":1,"roundName":"Round of 16","teamA":"CAR-002","teamB":"CAR-015","sources":[],"status":"ready","board":null,"winner":null},{"id":"M06","round":1,"roundName":"Round of 16","teamA":"CAR-007","teamB":"CAR-010","sources":[],"status":"ready","board":null,"winner":null},{"id":"M07","round":1,"roundName":"Round of 16","teamA":"CAR-003","teamB":"CAR-014","sources":[],"status":"ready","board":null,"winner":null},{"id":"M08","round":1,"roundName":"Round of 16","teamA":"CAR-006","teamB":"CAR-011","sources":[],"status":"ready","board":null,"winner":null},{"id":"M09","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M01","M02"],"status":"waiting","board":null,"winner":null},{"id":"M10","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M03","M04"],"status":"waiting","board":null,"winner":null},{"id":"M11","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M05","M06"],"status":"waiting","board":null,"winner":null},{"id":"M12","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M07","M08"],"status":"waiting","board":null,"winner":null},{"id":"M13","round":3,"roundName":"Semifinals","teamA":null,"teamB":null,"sources":["M09","M10"],"status":"waiting","board":null,"winner":null},{"id":"M14","round":3,"roundName":"Semifinals","teamA":null,"teamB":null,"sources":["M11","M12"],"status":"waiting","board":null,"winner":null},{"id":"M15","round":4,"roundName":"Final","teamA":null,"teamB":null,"sources":["M13","M14"],"status":"waiting","board":null,"winner":null}],"boards":[{"id":1,"availableAt":0},{"id":2,"availableAt":0},{"id":3,"availableAt":0},{"id":4,"availableAt":0}],"activity":[{"id":"49823964-de03-4ccf-b47b-9bc64812e910","message":"Sample tournament loaded — all teams are fictional","at":1790649084947},{"id":"5159f414-13c7-4b06-bb8f-8f8d33d38e8f","message":"M04 called to Board 4","at":1790649084947},{"id":"079aa7fa-612a-4d82-b74a-423c33e0f64a","message":"M03 called to Board 3","at":1790649084947},{"id":"89aff378-14cc-4e2f-a10c-1cef2cd0bd81","message":"M02 called to Board 2","at":1790649084947},{"id":"81a142a8-c9cf-41dc-9f9e-735c5ce7aa6e","message":"M01 called to Board 1","at":1790649084946},{"id":"7c12f90a-6f64-49d1-a461-627f24542246","message":"Knockout draw created for 16 teams","at":1790649084946},{"id":"8e419a14-2e01-4f09-8e79-65ba011ce390","message":"Carrom Collective registered","at":1790649084946},{"id":"74fe63c2-73a2-4912-a6ba-2b24c8ee2362","message":"The Finishers registered","at":1790649084946},{"id":"2273aea8-5881-48d2-ac27-f7ec143161c8","message":"Perfect Pocket registered","at":1790649084946},{"id":"231af091-4bda-4da1-bf1a-ffb6817b0eaa","message":"Board Brothers registered","at":1790649084946},{"id":"840564c5-166e-4de9-aceb-0c6c4f5f35ee","message":"Last Coin registered","at":1790649084946},{"id":"64aa6351-876b-46ce-aeef-494316bb25c1","message":"Strike Force registered","at":1790649084946},{"id":"15f2801d-86be-48be-951d-cd4df4326893","message":"The Challengers registered","at":1790649084946},{"id":"44733e1e-7a0e-4839-b11d-687652c99eff","message":"Double Trouble registered","at":1790649084946},{"id":"6269ae43-7914-4dbb-b08e-da5f74e50350","message":"Black & Bold registered","at":1790649084946},{"id":"66634c5b-c91f-4b09-9ab6-9f85ee0d4098","message":"Queen’s Guard registered","at":1790649084946},{"id":"364aa8af-f747-4c46-8251-342ed56de3cd","message":"White Knights registered","at":1790649084946},{"id":"d34ad148-9be5-4ac1-95f5-e36bd07683ba","message":"Corner Kings registered","at":1790649084946},{"id":"8be4aef8-268b-43b7-b258-a648c536b227","message":"Royal Knights registered","at":1790649084946},{"id":"902f6e52-ff9d-476b-9439-be7b8121081b","message":"Pocket Aces registered","at":1790649084946},{"id":"57bb3af6-395b-4103-a9f8-80d9e6c9385d","message":"The Strikers registered","at":1790649084946},{"id":"70463f65-6738-42e7-b1cf-3532f86dfa06","message":"Baseline Brothers registered","at":1790649084946}],"demo":true}$seed$::jsonb) on conflict (id) do nothing;
  if found then
    insert into public.tournament_public (id, version, state) values ('main', 1, $seed${"version":1,"event":{"name":"CARROMIA","year":"2026","venue":"Mary Matha Church, Vijayanagar","date":"2026-11-15","startTime":"09:00","durationMinutes":10,"resetMinutes":5,"restMinutes":0,"registrationOpen":false},"teams":[{"id":"CAR-001","name":"Baseline Brothers","parish":"Mary Matha","players":[{"name":"Arun Demo"},{"name":"Paul Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084945},{"id":"CAR-002","name":"The Strikers","parish":"St. Thomas","players":[{"name":"Joel Demo"},{"name":"Joseph Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-003","name":"Pocket Aces","parish":"St. Joseph","players":[{"name":"Mathew Demo"},{"name":"Kevin Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-004","name":"Royal Knights","parish":"Holy Family","players":[{"name":"Paul Demo"},{"name":"Thomas Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-005","name":"Corner Kings","parish":"Mary Matha","players":[{"name":"Joseph Demo"},{"name":"Mark Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-006","name":"White Knights","parish":"St. Thomas","players":[{"name":"Kevin Demo"},{"name":"Arun Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-007","name":"Queen’s Guard","parish":"St. Joseph","players":[{"name":"Thomas Demo"},{"name":"Joel Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-008","name":"Black & Bold","parish":"Holy Family","players":[{"name":"Mark Demo"},{"name":"Mathew Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-009","name":"Double Trouble","parish":"Mary Matha","players":[{"name":"Arun Demo"},{"name":"Paul Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-010","name":"The Challengers","parish":"St. Thomas","players":[{"name":"Joel Demo"},{"name":"Joseph Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-011","name":"Strike Force","parish":"St. Joseph","players":[{"name":"Mathew Demo"},{"name":"Kevin Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-012","name":"Last Coin","parish":"Holy Family","players":[{"name":"Paul Demo"},{"name":"Thomas Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-013","name":"Board Brothers","parish":"Mary Matha","players":[{"name":"Joseph Demo"},{"name":"Mark Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-014","name":"Perfect Pocket","parish":"St. Thomas","players":[{"name":"Kevin Demo"},{"name":"Arun Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-015","name":"The Finishers","parish":"St. Joseph","players":[{"name":"Thomas Demo"},{"name":"Joel Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946},{"id":"CAR-016","name":"Carrom Collective","parish":"Holy Family","players":[{"name":"Mark Demo"},{"name":"Mathew Demo"}],"primaryContact":0,"checkedIn":true,"registeredAt":1790649084946}],"matches":[{"id":"M01","round":1,"roundName":"Round of 16","teamA":"CAR-001","teamB":"CAR-016","sources":[],"status":"called","board":1,"winner":null},{"id":"M02","round":1,"roundName":"Round of 16","teamA":"CAR-008","teamB":"CAR-009","sources":[],"status":"called","board":2,"winner":null},{"id":"M03","round":1,"roundName":"Round of 16","teamA":"CAR-004","teamB":"CAR-013","sources":[],"status":"called","board":3,"winner":null},{"id":"M04","round":1,"roundName":"Round of 16","teamA":"CAR-005","teamB":"CAR-012","sources":[],"status":"called","board":4,"winner":null},{"id":"M05","round":1,"roundName":"Round of 16","teamA":"CAR-002","teamB":"CAR-015","sources":[],"status":"ready","board":null,"winner":null},{"id":"M06","round":1,"roundName":"Round of 16","teamA":"CAR-007","teamB":"CAR-010","sources":[],"status":"ready","board":null,"winner":null},{"id":"M07","round":1,"roundName":"Round of 16","teamA":"CAR-003","teamB":"CAR-014","sources":[],"status":"ready","board":null,"winner":null},{"id":"M08","round":1,"roundName":"Round of 16","teamA":"CAR-006","teamB":"CAR-011","sources":[],"status":"ready","board":null,"winner":null},{"id":"M09","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M01","M02"],"status":"waiting","board":null,"winner":null},{"id":"M10","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M03","M04"],"status":"waiting","board":null,"winner":null},{"id":"M11","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M05","M06"],"status":"waiting","board":null,"winner":null},{"id":"M12","round":2,"roundName":"Quarterfinals","teamA":null,"teamB":null,"sources":["M07","M08"],"status":"waiting","board":null,"winner":null},{"id":"M13","round":3,"roundName":"Semifinals","teamA":null,"teamB":null,"sources":["M09","M10"],"status":"waiting","board":null,"winner":null},{"id":"M14","round":3,"roundName":"Semifinals","teamA":null,"teamB":null,"sources":["M11","M12"],"status":"waiting","board":null,"winner":null},{"id":"M15","round":4,"roundName":"Final","teamA":null,"teamB":null,"sources":["M13","M14"],"status":"waiting","board":null,"winner":null}],"boards":[{"id":1,"availableAt":0},{"id":2,"availableAt":0},{"id":3,"availableAt":0},{"id":4,"availableAt":0}],"activity":[],"demo":true}$seed$::jsonb) on conflict (id) do nothing;
  end if;
end $$;
