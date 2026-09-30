-- CARROMIA: player photos, payment screenshots and the UPI QR code as files in Supabase Storage.
-- * "team-files" (private): one folder per registration, <event>/<uuid>/, holding player-1.jpg and
--   player-2.jpg (high quality, up to 2000px), their -thumb.jpg thumbnails (320px, for lists and the
--   registration form) and payment.jpg. Only officials can read it; they get signed links.
-- * "event-assets" (public): the UPI QR code, <event>/upi-qr-<uuid>.png (.jpg for one moved from the
--   database). event.upiQr holds its address.
-- * Files are written by the "registration" Edge Function (supabase/functions/registration), which
--   holds the service key: register_team() and team_form() are no longer callable from browsers.
-- * player_photos and payment_proofs keep a file's path. Their old image column stays until
--   scripts/move-images-to-storage.mjs has moved existing pictures; then run
--   20261006000000_carromia_storage_cleanup.sql.
-- Run after 20261004000000_carromia_payments.sql. Safe to re-run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('team-files', 'team-files', false, 5242880, array['image/jpeg']),
  ('event-assets', 'event-assets', true, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Officials read team files (to make signed links). Admins upload the UPI QR code; in practice
-- mode every official may, as with every other practice action.
drop policy if exists "Officials read team files" on storage.objects;
create policy "Officials read team files" on storage.objects for select to authenticated
  using (bucket_id = 'team-files' and public.official_role() is not null);
drop policy if exists "Officials upload the UPI QR code" on storage.objects;
create policy "Officials upload the UPI QR code" on storage.objects for insert to authenticated
  with check (bucket_id = 'event-assets' and name ~ '^(main|practice)/upi-qr-[0-9a-f-]{36}\.png$'
    and (public.official_role() = 'admin' or (name like 'practice/%' and public.official_role() is not null)));

alter table public.player_photos add column if not exists path text;
alter table public.player_photos alter column image drop not null;
alter table public.player_photos drop constraint if exists player_photos_path_check;
alter table public.player_photos add constraint player_photos_path_check check (path is null or path ~ '^(main|practice)/[0-9a-f-]{36}/player-[12]\.jpg$');
alter table public.payment_proofs add column if not exists path text;
alter table public.payment_proofs alter column image drop not null;
alter table public.payment_proofs drop constraint if exists payment_proofs_path_check;
alter table public.payment_proofs add constraint payment_proofs_path_check check (path is null or path ~ '^(main|practice)/[0-9a-f-]{36}/payment\.jpg$');

-- Mirrors addTeam(), playerPhotos(), paymentProof(), registrationStatus() and nextTeamId() in
-- lib/tournament.mjs. Photos and the screenshot arrive as paths of files the Edge Function has
-- already uploaded; each must exist. The forane / parish pair is checked against the register in
-- the browser.
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
  v_photo text;
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
    v_photo := coalesce(v_player->>'photo', '');
    if v_photo !~ ('^' || p_event || '/[0-9a-f-]{36}/player-[12]\.jpg$') or v_photo = any(v_photos)
      or not exists (select 1 from storage.objects o where o.bucket_id = 'team-files' and o.name = v_photo) then
      raise exception 'Add a photo of each player (a JPEG under 4 MB).' using errcode = 'PT400';
    end if;
    v_players := v_players || jsonb_build_array(jsonb_build_object('name', left(btrim(v_player->>'name'), 80), 'mobile', left(btrim(v_player->>'mobile'), 20), 'idType', v_id_type, 'idLast4', v_id_last4));
    v_photos := v_photos || v_photo;
  end loop;
  if exists (select 1 from jsonb_array_elements(v_teams) t where lower(t->>'name') = lower(v_name)) then
    raise exception 'That team name is already registered.' using errcode = 'PT400';
  end if;
  if not coalesce(p_adults, false) then raise exception 'Confirm that both players are 18 or older.' using errcode = 'PT400'; end if;
  if (select count(*) from jsonb_array_elements(v_teams) t where public.parish_key(t->>'parish') = public.parish_key(v_parish)) >= v_per_parish then
    raise exception '% already has % teams registered, the most allowed for one parish.', v_parish, v_per_parish using errcode = 'PT400';
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
  insert into public.player_photos (event, team_id, player, path)
  select p_event, v_team->>'id', i - 1, v_photos[i] from generate_subscripts(v_photos, 1) i
  on conflict (event, team_id, player) do update set path = excluded.path, created_at = now();
  if v_pending and v_shot <> '' then
    insert into public.payment_proofs (event, team_id, path) values (p_event, v_team->>'id', v_shot)
    on conflict (event, team_id) do update set path = excluded.path, created_at = now();
  end if;
  insert into public.tournament_public (id, version, state) values (p_event, v_version, public.public_copy(v_state))
    on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  insert into public.audit_log (actor_name, action, detail)
  values ('Public registration', case when p_event = 'practice' then 'practice:register' else 'register' end, jsonb_build_object('team', v_team->>'id', 'name', v_name));
  return jsonb_build_object('team', v_team);
end $$;
revoke all on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_team(text, text, jsonb, int, text, int, boolean, text, text, jsonb) to service_role;

-- Mirrors teamForm() in lib/tournament.mjs. Returns the paths of the players' photos; the Edge
-- Function turns their thumbnails into short-lived links. A wrong number is returned as { error }
-- rather than raised, so the attempt it records is kept.
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
    select coalesce(jsonb_agg(path order by player), '[]'::jsonb) from public.player_photos where event = p_event and team_id = v_id and path is not null));
end $$;
revoke all on function public.team_form(text, text, text) from public, anon, authenticated;
grant execute on function public.team_form(text, text, text) to service_role;

-- Files nothing points at any more, for the Edge Function (and the Node server) to delete: a removed
-- team's, a fresh event's, a registration that failed, or a replaced UPI QR code. Recent files are
-- left alone so a registration or a settings change in progress is never cut short.
create or replace function public.unreferenced_files() returns table (bucket text, name text)
language sql stable security definer set search_path = '' as $$
  select o.bucket_id, o.name from storage.objects o
  where o.bucket_id = 'team-files' and o.created_at < now() - interval '1 hour'
    and not exists (select 1 from public.player_photos p where o.name in (p.path, regexp_replace(p.path, '\.jpg$', '-thumb.jpg')))
    and not exists (select 1 from public.payment_proofs p where p.path = o.name)
  union all
  select o.bucket_id, o.name from storage.objects o
  where o.bucket_id = 'event-assets' and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.tournament t where (t.state->'event'->>'upiQr') like ('%/' || o.name))
$$;
revoke all on function public.unreferenced_files() from public, anon, authenticated;
grant execute on function public.unreferenced_files() to service_role;
