-- CARROMIA: several teams from one parish in one registration, with one payment.
-- * register_teams() registers 1 to 8 teams from the same parish or centre at once. A group of two
--   or more names a parish coordinator (name and mobile). Each team keeps its own ID, check-in QR
--   and place in the draw, and carries group = { id, size, coordinator } (id: the first team's ID)
--   and the same payment ({ amount: teams × entry fee, txnRef, screenshot, teams }).
-- * The payment screenshot is one file, in the first team's folder; each team in the group has a
--   payment_proofs row pointing at it, so removing one team leaves the others' proof in place.
-- * register_team() is now register_teams() with one team, so an Edge Function deployed before
--   this migration keeps working.
-- * team_form() also accepts the parish coordinator's mobile; group_form() gives the coordinator
--   every team in the group, for one PDF of all their forms.
-- * public_copy() leaves out the coordinator, as it does payment references.
-- Run after 20261006000000_carromia_storage_cleanup.sql (or 20261005000000_carromia_storage.sql).
-- Safe to re-run.

-- Mirrors addTeams(), playerPhotos(), paymentProof(), registrationStatus() and nextTeamId() in
-- lib/tournament.mjs. Photos and the screenshot arrive as paths of files the Edge Function has
-- already uploaded; each must exist. The forane / parish pair is checked against the register in
-- the browser. p_teams: [{ name, players: [{ name, mobile, idType, idLast4, photo }] ×2, primaryContact, lunch }].
create or replace function public.register_teams(p_event text, p_forane text, p_parish text, p_centre_type text, p_teams jsonb, p_adults boolean default false, p_coordinator jsonb default null, p_payment jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_teams jsonb;
  v_parish text := left(btrim(coalesce(p_parish, '')), 80);
  v_forane text := left(btrim(coalesce(p_forane, '')), 80);
  v_type text := coalesce(p_centre_type, '');
  v_count int;
  v_entry jsonb;
  v_name text;
  v_names text[] := '{}';
  v_players jsonb;
  v_all_players jsonb := '[]'::jsonb;
  v_photos text[] := '{}';
  v_team_photos jsonb := '[]'::jsonb;
  v_player jsonb;
  v_photo text;
  v_id_type text;
  v_id_last4 text;
  v_coordinator jsonb;
  v_txn text := upper(regexp_replace(left(btrim(coalesce(p_payment->>'txnRef', '')), 30), '\s+', '', 'g'));
  v_shot text := coalesce(p_payment->>'screenshot', '');
  v_pending boolean;
  v_payment jsonb;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_max int;
  v_per_parish int;
  v_already int;
  v_deadline text;
  v_seq int;
  v_team jsonb;
  v_new jsonb := '[]'::jsonb;
  v_group_id text;
  v_version bigint;
  i int;
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
  v_pending := coalesce((v_state->'event'->>'paymentRequired')::boolean, false);
  if p_event = 'main' and v_deadline ~ '^\d{4}-\d{2}-\d{2}$' and now() >= ((v_deadline::date + 1)::timestamp at time zone 'Asia/Kolkata') then
    raise exception 'Registration closed on %.', to_char(v_deadline::date, 'FMDD FMMonth YYYY') using errcode = 'PT400';
  end if;
  if jsonb_array_length(v_teams) >= v_max then raise exception 'All % team slots are taken. Registration is full.', v_max using errcode = 'PT400'; end if;

  if jsonb_typeof(p_teams) is distinct from 'array' or jsonb_array_length(p_teams) = 0 then raise exception 'Add at least one team.' using errcode = 'PT400'; end if;
  v_count := jsonb_array_length(p_teams);
  if v_count > 8 then raise exception 'Register up to 8 teams at a time.' using errcode = 'PT400'; end if;
  for v_entry in select value from jsonb_array_elements(p_teams) loop
    if left(btrim(coalesce(v_entry->>'name', '')), 80) = '' then raise exception 'Enter a team name.' using errcode = 'PT400'; end if;
  end loop;
  if v_forane = '' or v_parish = '' or v_type not in ('Parish', 'Mass Centre', 'Mission Centre') then
    raise exception 'Choose your forane or zone, then your parish or centre from the list.' using errcode = 'PT400';
  end if;

  -- Each team's players, checked and cleaned; photos must be distinct files that exist.
  for v_entry in select value from jsonb_array_elements(p_teams) loop
    if jsonb_typeof(v_entry->'players') is distinct from 'array' or jsonb_array_length(v_entry->'players') <> 2 then
      raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
    end if;
    v_players := '[]'::jsonb;
    for v_player in select value from jsonb_array_elements(v_entry->'players') loop
      if left(btrim(coalesce(v_player->>'name', '')), 80) = '' or left(btrim(coalesce(v_player->>'mobile', '')), 20) !~ '^\+?[0-9 ()-]{7,20}$' then
        raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
      end if;
      v_id_type := coalesce(v_player->>'idType', '');
      v_id_last4 := upper(left(btrim(coalesce(v_player->>'idLast4', '')), 4));
      if v_id_type not in ('Aadhaar', 'Voter ID', 'Driving Licence', 'Passport', 'Other') or v_id_last4 !~ '^[A-Z0-9]{4}$' then
        raise exception 'Choose each player’s ID proof and enter the last 4 letters or digits of its number.' using errcode = 'PT400';
      end if;
      v_photo := coalesce(v_player->>'photo', '');
      if v_photo !~ ('^' || p_event || '/[0-9a-f-]{36}/player-[12]\.jpg$') or v_photo = any(v_photos)
        or not exists (select 1 from storage.objects o where o.bucket_id = 'team-files' and o.name = v_photo) then
        raise exception 'Add a photo of each player (a JPEG under 4 MB).' using errcode = 'PT400';
      end if;
      v_players := v_players || jsonb_build_array(jsonb_build_object('name', left(btrim(v_player->>'name'), 80), 'mobile', left(btrim(v_player->>'mobile'), 20), 'idType', v_id_type, 'idLast4', v_id_last4));
      v_photos := v_photos || v_photo;
    end loop;
    v_all_players := v_all_players || jsonb_build_array(v_players);
  end loop;

  -- Team names: unique among registered teams and within this registration.
  for v_entry in select value from jsonb_array_elements(p_teams) loop
    v_name := left(btrim(v_entry->>'name'), 80);
    if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
      if v_count > 1 then raise exception 'The team name “%” is already registered.', v_name using errcode = 'PT400'; end if;
      raise exception 'That team name is already registered.' using errcode = 'PT400';
    end if;
    if lower(v_name) = any(v_names) then raise exception 'Give each team a different name: “%” is used twice.', v_name using errcode = 'PT400'; end if;
    v_names := v_names || lower(v_name);
  end loop;
  if not coalesce(p_adults, false) then
    raise exception '%', case when v_count > 1 then 'Confirm that all players are 18 or older.' else 'Confirm that both players are 18 or older.' end using errcode = 'PT400';
  end if;
  if v_count > v_max - jsonb_array_length(v_teams) then
    raise exception 'Only % team slot% left.', v_max - jsonb_array_length(v_teams), case when v_max - jsonb_array_length(v_teams) = 1 then ' is' else 's are' end using errcode = 'PT400';
  end if;
  v_already := (select count(*) from jsonb_array_elements(v_teams) t where public.parish_key(t->>'parish') = public.parish_key(v_parish));
  if v_already >= v_per_parish then
    raise exception '% already has % teams registered, the most allowed for one parish.', v_parish, v_per_parish using errcode = 'PT400';
  end if;
  if v_already + v_count > v_per_parish then
    raise exception '% can register % more team% (up to % for one parish).', v_parish, v_per_parish - v_already, case when v_per_parish - v_already = 1 then '' else 's' end, v_per_parish using errcode = 'PT400';
  end if;
  if v_count > 1 then
    v_coordinator := jsonb_build_object('name', left(btrim(coalesce(p_coordinator->>'name', '')), 80), 'mobile', left(btrim(coalesce(p_coordinator->>'mobile', '')), 20));
    if v_coordinator->>'name' = '' or v_coordinator->>'mobile' !~ '^\+?[0-9 ()-]{7,20}$' then
      raise exception 'Enter the parish coordinator’s name and a valid mobile number.' using errcode = 'PT400';
    end if;
  end if;
  if v_pending then
    if v_shot <> '' and (v_shot !~ ('^' || p_event || '/[0-9a-f-]{36}/payment\.jpg$')
      or not exists (select 1 from storage.objects o where o.bucket_id = 'team-files' and o.name = v_shot)) then
      raise exception 'Add the payment screenshot as a picture under 4 MB.' using errcode = 'PT400';
    end if;
    if v_txn <> '' and v_txn !~ '^[A-Z0-9]{6,30}$' then
      raise exception 'Enter the UPI transaction number (UTR) as shown in your payment app: 6 to 30 letters or digits.' using errcode = 'PT400';
    end if;
    if v_txn = '' and v_shot = '' then raise exception 'Enter the UPI transaction number or add a payment screenshot.' using errcode = 'PT400'; end if;
    v_payment := jsonb_build_object('amount', coalesce((v_state->'event'->>'entryFee')::int, 500) * v_count, 'txnRef', v_txn, 'screenshot', v_shot <> '')
      || case when v_count > 1 then jsonb_build_object('teams', v_count) else '{}'::jsonb end;
  end if;

  v_seq := greatest(coalesce((v_state->>'teamSeq')::int, 0),
    coalesce((select max(nullif(regexp_replace(t->>'id', '\D', '', 'g'), '')::int) from jsonb_array_elements(v_teams) t), 0));
  v_group_id := 'CAR-' || lpad((v_seq + 1)::text, 3, '0');
  for i in 0 .. v_count - 1 loop
    v_entry := p_teams->i;
    v_seq := v_seq + 1;
    v_team := jsonb_build_object('id', 'CAR-' || lpad(v_seq::text, 3, '0'), 'name', left(btrim(v_entry->>'name'), 80), 'forane', v_forane, 'parish', v_parish, 'centreType', v_type,
      'players', v_all_players->i, 'primaryContact', case when (v_entry->>'primaryContact') = '1' then 1 else 0 end,
      'lunch', least(2, greatest(0, coalesce(floor((v_entry->>'lunch')::numeric)::int, 0))),
      'checkedIn', false, 'registeredAt', v_now, 'checkinToken', gen_random_uuid(), 'status', case when v_pending then 'pending' else 'confirmed' end);
    if v_pending then v_team := v_team || jsonb_build_object('payment', v_payment); end if;
    if v_count > 1 then v_team := v_team || jsonb_build_object('group', jsonb_build_object('id', v_group_id, 'size', v_count, 'coordinator', v_coordinator)); end if;
    v_new := v_new || jsonb_build_array(v_team);
    v_team_photos := v_team_photos || jsonb_build_array(jsonb_build_array(v_photos[i * 2 + 1], v_photos[i * 2 + 2]));
  end loop;

  v_state := jsonb_set(v_state, '{teams}', v_teams || v_new);
  v_state := jsonb_set(v_state, '{teamSeq}', to_jsonb(v_seq));
  v_state := jsonb_set(v_state, '{activity}', (
    select coalesce(jsonb_agg(x.a order by x.n), '[]'::jsonb)
    from jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'message',
      case when v_count > 1 then v_parish || ' registered ' || v_count || ' teams (' || (select string_agg(t->>'name', ', ' order by n) from jsonb_array_elements(v_new) with ordinality as y(t, n)) || ')'
        else v_new->0->>'name' || ' registered' end
      || case when v_pending then ' (payment to be confirmed)' else '' end, 'at', v_now)) || coalesce(v_state->'activity', '[]'::jsonb)) with ordinality as x(a, n)
    where x.n <= 80));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = p_event returning version into v_version;
  insert into public.player_photos (event, team_id, player, path)
  select p_event, t.value->>'id', p.n - 1, p.path
  from jsonb_array_elements(v_new) with ordinality as t(value, n), jsonb_array_elements_text(v_team_photos->(t.n::int - 1)) with ordinality as p(path, n)
  on conflict (event, team_id, player) do update set path = excluded.path, created_at = now();
  if v_pending and v_shot <> '' then
    insert into public.payment_proofs (event, team_id, path)
    select p_event, t->>'id', v_shot from jsonb_array_elements(v_new) t
    on conflict (event, team_id) do update set path = excluded.path, created_at = now();
  end if;
  insert into public.tournament_public (id, version, state) values (p_event, v_version, public.public_copy(v_state))
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  insert into public.audit_log (actor_name, action, detail)
  select 'Public registration', case when p_event = 'practice' then 'practice:register' else 'register' end, jsonb_build_object('team', t->>'id', 'name', t->>'name') || case when v_count > 1 then jsonb_build_object('group', v_group_id) else '{}'::jsonb end
  from jsonb_array_elements(v_new) t;
  return jsonb_build_object('teams', v_new);
end $$;
revoke all on function public.register_teams(text, text, text, text, jsonb, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.register_teams(text, text, text, text, jsonb, boolean, jsonb, jsonb) to service_role;

-- One team, for an Edge Function deployed before group registration.
create or replace function public.register_team(p_name text, p_parish text, p_players jsonb, p_primary int default 0, p_event text default 'main', p_lunch int default 0, p_adults boolean default false, p_forane text default null, p_centre_type text default null, p_payment jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object('team', public.register_teams(p_event, p_forane, p_parish, p_centre_type,
    jsonb_build_array(jsonb_build_object('name', p_name, 'players', p_players, 'primaryContact', p_primary, 'lunch', p_lunch)), p_adults, null, p_payment)->'teams'->0);
end $$;
revoke all on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) to service_role;

-- Mirrors teamForm() in lib/tournament.mjs: the primary player's or the parish coordinator's mobile.
create or replace function public.team_form(p_event text, p_team_id text, p_mobile text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := upper(btrim(coalesce(p_team_id, '')));
  v_key text := right(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), 10);
  v_team jsonb;
begin
  if p_event not in ('main', 'practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  delete from public.form_attempts where at < now() - interval '1 hour';
  if (select count(*) from public.form_attempts where event = p_event and team_id = v_id) >= 10 then
    raise exception 'Too many tries for this team. Try again in an hour.' using errcode = 'PT429';
  end if;
  select t.value into v_team from public.tournament, jsonb_array_elements(coalesce(state->'teams', '[]'::jsonb)) t where id = p_event and t.value->>'id' = v_id;
  if v_team is null then raise exception 'Team not found.' using errcode = 'PT404'; end if;
  if v_team->>'status' = 'pending' then
    raise exception 'This team’s payment is still being verified. The form can be downloaded once the desk confirms it.' using errcode = 'PT400';
  end if;
  if length(v_key) < 10 or v_key not in (
    right(regexp_replace(coalesce(v_team->'players'->coalesce((v_team->>'primaryContact')::int, 0)->>'mobile', ''), '\D', '', 'g'), 10),
    right(regexp_replace(coalesce(v_team->'group'->'coordinator'->>'mobile', ''), '\D', '', 'g'), 10)) then
    insert into public.form_attempts (event, team_id) values (p_event, v_id);
    return jsonb_build_object('error', 'That mobile number doesn’t match this team’s primary contact or parish coordinator.');
  end if;
  return jsonb_build_object('team', v_team - 'confirmedBy', 'photos', (
    select coalesce(jsonb_agg(path order by player), '[]'::jsonb) from public.player_photos where event = p_event and team_id = v_id and path is not null));
end $$;
revoke all on function public.team_form(text, text, text) from public, anon, authenticated;
grant execute on function public.team_form(text, text, text) to service_role;

-- Mirrors groupForm() in lib/tournament.mjs: every team in a group, with its photo paths, for the
-- parish coordinator. Wrong numbers count against the group's ID, as team_form() does.
create or replace function public.group_form(p_event text, p_group_id text, p_mobile text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := upper(btrim(coalesce(p_group_id, '')));
  v_key text := right(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), 10);
  v_teams jsonb;
begin
  if p_event not in ('main', 'practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  delete from public.form_attempts where at < now() - interval '1 hour';
  if (select count(*) from public.form_attempts where event = p_event and team_id = v_id) >= 10 then
    raise exception 'Too many tries for this group. Try again in an hour.' using errcode = 'PT429';
  end if;
  select jsonb_agg(t.value order by t.n) into v_teams
  from public.tournament, jsonb_array_elements(coalesce(state->'teams', '[]'::jsonb)) with ordinality as t(value, n)
  where id = p_event and t.value->'group'->>'id' = v_id;
  if v_teams is null then raise exception 'Group registration not found.' using errcode = 'PT404'; end if;
  if exists (select 1 from jsonb_array_elements(v_teams) t where t->>'status' = 'pending') then
    raise exception 'This group’s payment is still being verified. The forms can be downloaded once the desk confirms it.' using errcode = 'PT400';
  end if;
  if length(v_key) < 10 or v_key <> right(regexp_replace(coalesce(v_teams->0->'group'->'coordinator'->>'mobile', ''), '\D', '', 'g'), 10) then
    insert into public.form_attempts (event, team_id) values (p_event, v_id);
    return jsonb_build_object('error', 'That mobile number doesn’t match the parish coordinator’s.');
  end if;
  return jsonb_build_object('teams', (
    select jsonb_agg(jsonb_build_object('team', t.value - 'confirmedBy', 'photos', (
      select coalesce(jsonb_agg(p.path order by p.player), '[]'::jsonb) from public.player_photos p where p.event = p_event and p.team_id = t.value->>'id' and p.path is not null)) order by t.n)
    from jsonb_array_elements(v_teams) with ordinality as t(value, n)));
end $$;
revoke all on function public.group_form(text, text, text) from public, anon, authenticated;
grant execute on function public.group_form(text, text, text) to service_role;

-- Mirrors publicState() in lib/tournament.mjs: a group shows only its reference and size.
create or replace function public.public_copy(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(p_state, '{activity}', '[]'::jsonb), '{teams}', (
    select coalesce(jsonb_agg((x.t - 'checkinToken' - 'payment' - 'confirmedBy' - 'group')
      || case when x.t ? 'group' then jsonb_build_object('group', jsonb_build_object('id', x.t->'group'->'id', 'size', x.t->'group'->'size')) else '{}'::jsonb end
      || jsonb_build_object('players', (
      select coalesce(jsonb_agg(jsonb_build_object('name', p.v->>'name') order by p.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(x.t->'players', '[]'::jsonb)) with ordinality as p(v, n))) order by x.n), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_state->'teams', '[]'::jsonb)) with ordinality as x(t, n)))
$$;

insert into public.tournament_public (id, version, state)
select id, version, public.public_copy(state) from public.tournament
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
