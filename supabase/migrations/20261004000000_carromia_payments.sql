-- CARROMIA: payment at registration and the public registration-form download.
-- * When the event collects payment at registration (event.paymentRequired, set in Event settings
--   with the UPI QR code), a team gives the UPI transaction number (UTR) and/or a payment
--   screenshot and stays 'pending' until a desk official confirms the payment. The screenshot is
--   kept in payment_proofs, apart from the event; only officials can read it.
-- * The public copy never shows a team's payment reference or who confirmed it.
-- * team_form() gives a confirmed team's full details (for its registration form) to anyone who
--   knows the primary player's mobile number, and refuses after 10 wrong numbers in an hour.
-- Run after 20261003000000_carromia_registration_details.sql. Safe to re-run.

create table if not exists public.payment_proofs (
  event text not null check (event in ('main', 'practice')),
  team_id text not null,
  image text not null check (image ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' and length(image) <= 400000),
  created_at timestamptz not null default now(),
  primary key (event, team_id)
);
alter table public.payment_proofs enable row level security;
drop policy if exists "Officials read payment proofs" on public.payment_proofs;
create policy "Officials read payment proofs" on public.payment_proofs for select to authenticated using (public.official_role() is not null);

-- Wrong mobile numbers given for a team's form; nobody reads this table directly.
create table if not exists public.form_attempts (
  event text not null,
  team_id text not null,
  at timestamptz not null default now()
);
create index if not exists form_attempts_team on public.form_attempts (event, team_id, at);
alter table public.form_attempts enable row level security;

-- A removed team's photos and payment screenshot go with it, however the event is saved.
create or replace function public.drop_orphan_photos() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.player_photos p where p.event = new.id
    and not exists (select 1 from jsonb_array_elements(coalesce(new.state->'teams', '[]'::jsonb)) t where t->>'id' = p.team_id);
  delete from public.payment_proofs p where p.event = new.id
    and not exists (select 1 from jsonb_array_elements(coalesce(new.state->'teams', '[]'::jsonb)) t where t->>'id' = p.team_id);
  return null;
end $$;

-- Mirrors publicState() in lib/tournament.mjs.
create or replace function public.public_copy(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(p_state, '{activity}', '[]'::jsonb), '{teams}', (
    select coalesce(jsonb_agg((x.t - 'checkinToken' - 'payment' - 'confirmedBy') || jsonb_build_object('players', (
      select coalesce(jsonb_agg(jsonb_build_object('name', p.v->>'name') order by p.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(x.t->'players', '[]'::jsonb)) with ordinality as p(v, n))) order by x.n), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_state->'teams', '[]'::jsonb)) with ordinality as x(t, n)))
$$;

-- Mirrors addTeam(), playerPhotos(), paymentProof(), registrationStatus() and nextTeamId() in
-- lib/tournament.mjs. The forane / parish pair is checked against the register in the browser.
drop function if exists public.register_team(text, text, jsonb, int, text, int, boolean, text, text);
create or replace function public.register_team(p_name text, p_parish text, p_players jsonb, p_primary int default 0, p_event text default 'main', p_lunch int default 0, p_adults boolean default false, p_forane text default null, p_centre_type text default null, p_payment jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_teams jsonb;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_parish text := left(btrim(coalesce(p_parish, '')), 80);
  v_forane text := left(btrim(coalesce(p_forane, '')), 80);
  v_type text := coalesce(p_centre_type, '');
  v_players jsonb := '[]'::jsonb;
  v_photos text[] := '{}';
  v_player jsonb;
  v_id_type text;
  v_id_last4 text;
  v_txn text := upper(regexp_replace(left(btrim(coalesce(p_payment->>'txnRef', '')), 30), '\s+', '', 'g'));
  v_shot text := coalesce(p_payment->>'screenshot', '');
  v_pending boolean;
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
  v_pending := coalesce((v_state->'event'->>'paymentRequired')::boolean, false);
  if p_event = 'main' and v_deadline ~ '^\d{4}-\d{2}-\d{2}$' and now() >= ((v_deadline::date + 1)::timestamp at time zone 'Asia/Kolkata') then
    raise exception 'Registration closed on %.', to_char(v_deadline::date, 'FMDD FMMonth YYYY') using errcode = 'PT400';
  end if;
  if jsonb_array_length(v_teams) >= v_max then raise exception 'All % team slots are taken. Registration is full.', v_max using errcode = 'PT400'; end if;

  if v_name = '' then raise exception 'Enter a team name.' using errcode = 'PT400'; end if;
  if v_forane = '' or v_parish = '' or v_type not in ('Parish', 'Mass Centre', 'Mission Centre') then
    raise exception 'Choose your forane or zone, then your parish or centre from the list.' using errcode = 'PT400';
  end if;
  if jsonb_typeof(p_players) is distinct from 'array' or jsonb_array_length(p_players) <> 2 then
    raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
  end if;
  for v_player in select value from jsonb_array_elements(p_players) loop
    if left(btrim(coalesce(v_player->>'name', '')), 80) = '' or left(btrim(coalesce(v_player->>'mobile', '')), 20) !~ '^\+?[0-9 ()-]{7,20}$' then
      raise exception 'Enter exactly two players with valid mobile numbers.' using errcode = 'PT400';
    end if;
    v_id_type := coalesce(v_player->>'idType', '');
    v_id_last4 := upper(left(btrim(coalesce(v_player->>'idLast4', '')), 4));
    if v_id_type not in ('Aadhaar', 'Voter ID', 'Driving Licence', 'Passport', 'Other') or v_id_last4 !~ '^[A-Z0-9]{4}$' then
      raise exception 'Choose each player’s ID proof and enter the last 4 letters or digits of its number.' using errcode = 'PT400';
    end if;
    if coalesce(v_player->>'photo', '') !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or length(v_player->>'photo') > 200000 then
      raise exception 'Add a photo of each player (a JPEG under 150 KB).' using errcode = 'PT400';
    end if;
    v_players := v_players || jsonb_build_array(jsonb_build_object('name', left(btrim(v_player->>'name'), 80), 'mobile', left(btrim(v_player->>'mobile'), 20), 'idType', v_id_type, 'idLast4', v_id_last4));
    v_photos := v_photos || (v_player->>'photo');
  end loop;
  if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
    raise exception 'That team name is already registered.' using errcode = 'PT400';
  end if;
  if not coalesce(p_adults, false) then raise exception 'Confirm that both players are 18 or older.' using errcode = 'PT400'; end if;
  if (select count(*) from jsonb_array_elements(v_teams) t where public.parish_key(t->>'parish') = public.parish_key(v_parish)) >= v_per_parish then
    raise exception '% already has % teams registered, the most allowed for one parish.', v_parish, v_per_parish using errcode = 'PT400';
  end if;
  if v_pending then
    if v_shot <> '' and (v_shot !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or length(v_shot) > 400000) then
      raise exception 'Add the payment screenshot as a picture under 300 KB.' using errcode = 'PT400';
    end if;
    if v_txn <> '' and v_txn !~ '^[A-Z0-9]{6,30}$' then
      raise exception 'Enter the UPI transaction number (UTR) as shown in your payment app: 6 to 30 letters or digits.' using errcode = 'PT400';
    end if;
    if v_txn = '' and v_shot = '' then raise exception 'Enter the UPI transaction number or add a payment screenshot.' using errcode = 'PT400'; end if;
  end if;

  v_seq := greatest(coalesce((v_state->>'teamSeq')::int, 0),
    coalesce((select max(nullif(regexp_replace(t->>'id', '\D', '', 'g'), '')::int) from jsonb_array_elements(v_teams) t), 0)) + 1;
  v_team := jsonb_build_object('id', 'CAR-' || lpad(v_seq::text, 3, '0'), 'name', v_name, 'forane', v_forane, 'parish', v_parish, 'centreType', v_type,
    'players', v_players, 'primaryContact', case when p_primary = 1 then 1 else 0 end, 'lunch', least(2, greatest(0, coalesce(p_lunch, 0))),
    'checkedIn', false, 'registeredAt', v_now, 'checkinToken', gen_random_uuid(), 'status', case when v_pending then 'pending' else 'confirmed' end);
  if v_pending then
    v_team := v_team || jsonb_build_object('payment', jsonb_build_object('amount', coalesce((v_state->'event'->>'entryFee')::int, 500), 'txnRef', v_txn, 'screenshot', v_shot <> ''));
  end if;
  v_state := jsonb_set(v_state, '{teams}', v_teams || jsonb_build_array(v_team));
  v_state := jsonb_set(v_state, '{teamSeq}', to_jsonb(v_seq));
  v_state := jsonb_set(v_state, '{activity}', (
    select coalesce(jsonb_agg(x.a order by x.n), '[]'::jsonb)
    from jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'message', v_name || ' registered' || case when v_pending then ' (payment to be confirmed)' else '' end, 'at', v_now)) || coalesce(v_state->'activity', '[]'::jsonb)) with ordinality as x(a, n)
    where x.n <= 80));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = p_event returning version into v_version;
  insert into public.player_photos (event, team_id, player, image)
  select p_event, v_team->>'id', i - 1, v_photos[i] from generate_subscripts(v_photos, 1) i
  on conflict (event, team_id, player) do update set image = excluded.image, created_at = now();
  if v_pending and v_shot <> '' then
    insert into public.payment_proofs (event, team_id, image) values (p_event, v_team->>'id', v_shot)
    on conflict (event, team_id) do update set image = excluded.image, created_at = now();
  end if;
  insert into public.tournament_public (id, version, state) values (p_event, v_version, public.public_copy(v_state))
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  insert into public.audit_log (actor_name, action, detail)
  values ('Public registration', case when p_event = 'practice' then 'practice:register' else 'register' end, jsonb_build_object('team', v_team->>'id', 'name', v_name));
  return jsonb_build_object('team', v_team);
end $$;
revoke all on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) from public;
grant execute on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) to anon, authenticated;

-- Mirrors teamForm() in lib/tournament.mjs. A wrong number is returned as { error } rather than
-- raised, so the attempt it records is kept.
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
  if length(v_key) < 10 or v_key <> right(regexp_replace(coalesce(v_team->'players'->coalesce((v_team->>'primaryContact')::int, 0)->>'mobile', ''), '\D', '', 'g'), 10) then
    insert into public.form_attempts (event, team_id) values (p_event, v_id);
    return jsonb_build_object('error', 'That mobile number doesn’t match this team’s primary contact.');
  end if;
  return jsonb_build_object('team', v_team - 'confirmedBy', 'photos', (
    select coalesce(jsonb_agg(image order by player), '[]'::jsonb) from public.player_photos where event = p_event and team_id = v_id));
end $$;
revoke all on function public.team_form(text, text, text) from public;
grant execute on function public.team_form(text, text, text) to anon, authenticated;

-- Refresh both public copies so no payment reference is ever public.
insert into public.tournament_public (id, version, state)
select id, version, public.public_copy(state) from public.tournament
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
