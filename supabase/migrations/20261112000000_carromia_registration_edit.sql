-- Registration edits and replacement-file references commit together. Run after the alerts migration.
-- Existing registrations, file paths, payment confirmations and fixtures are preserved. Safe to rerun.
create or replace function public.save_registration(p_expected bigint, p_state jsonb, p_team_id text,
  p_photos jsonb default '{}'::jsonb, p_payment text default '', p_detail jsonb default '{}'::jsonb, p_id text default 'main')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_team jsonb; v_target jsonb; v_before jsonb; v_after jsonb; v_player jsonb;
  v_group text; v_shared boolean; v_changed boolean; v_path text; v_key text; v_value jsonb;
  v_version bigint; v_result bigint; v_count int; v_ids text[] := '{}';
begin
  if coalesce(auth.role(), '') <> 'service_role' and not coalesce(public.official_role() in ('admin','official'), false) then
    raise exception 'Only event admins and officials can edit registrations.' using errcode = 'PT403';
  end if;
  if p_id is null or p_id not in ('main','practice') then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  if p_id = 'practice' and exists(select 1 from public.tournament where id='main' and state->'event'->'practiceOff'='true'::jsonb) then
    raise exception 'Practice mode is turned off.' using errcode = 'PT400';
  end if;
  select state, version into v_old, v_version from public.tournament where id=p_id for update;
  if v_old is null then raise exception 'Team not found.' using errcode = 'PT404'; end if;
  if p_expected is distinct from v_version then raise exception 'The event was changed from another session. Please try again.' using errcode = 'PT409'; end if;
  select t into v_team from jsonb_array_elements(v_old->'teams') t where t->>'id'=p_team_id;
  if v_team is null then raise exception 'Team not found.' using errcode = 'PT404'; end if;
  if coalesce((p_detail->>'expectedVersion')::bigint, -1) <> coalesce((v_team->>'registrationVersion')::bigint, 0) then
    raise exception 'This registration changed while you were editing. Close the editor and reopen it.' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_state->'teams') is distinct from 'array' or jsonb_array_length(p_state->'teams') <> jsonb_array_length(v_old->'teams')
    or (p_state-'teams'-'activity') is distinct from (v_old-'teams'-'activity') then
    raise exception 'A registration edit cannot change the event, check-in, draw or results.' using errcode = 'PT400';
  end if;
  if jsonb_typeof(p_photos) is distinct from 'object' or p_payment is null then raise exception 'Invalid replacement files.' using errcode = 'PT400'; end if;
  v_group := v_team->'group'->>'id';
  select t into v_target from jsonb_array_elements(p_state->'teams') t where t->>'id'=p_team_id;
  if v_target is null then raise exception 'Team not found.' using errcode = 'PT400'; end if;

  for v_before, v_after in select o.t,n.t from jsonb_array_elements(v_old->'teams') with ordinality o(t,i)
    join jsonb_array_elements(p_state->'teams') with ordinality n(t,i) using(i) loop
    if v_before->'id' is distinct from v_after->'id' then raise exception 'Team IDs and order cannot change.' using errcode='PT400'; end if;
    v_shared := v_before->>'id'=p_team_id or coalesce(v_group is not null and v_before->'group'->>'id'=v_group,false);
    if not v_shared then
      if v_after is distinct from v_before then raise exception 'Only this registration can be edited.' using errcode='PT400'; end if;
      continue;
    end if;
    v_ids := array_append(v_ids,v_before->>'id');
    if (v_before-array['name','players','primaryContact','lunch','forane','parish','centreType','group','payment','registrationVersion'])
      is distinct from (v_after-array['name','players','primaryContact','lunch','forane','parish','centreType','group','payment','registrationVersion']) then
      raise exception 'Payment status, check-in, QR codes and results cannot change in a registration edit.' using errcode='PT400';
    end if;
    if v_before->>'id'<>p_team_id and (v_before-array['forane','parish','centreType','group','payment','registrationVersion'])
      is distinct from (v_after-array['forane','parish','centreType','group','payment','registrationVersion']) then
      raise exception 'Edit each team’s player details separately.' using errcode='PT400';
    end if;
    if ((v_after->'group')-'coordinator') is distinct from ((v_before->'group')-'coordinator')
      or ((v_after->'payment')-array['txnRef','screenshot']) is distinct from ((v_before->'payment')-array['txnRef','screenshot'])
      or (v_before->'payment' is null and v_after->'payment' is distinct from v_before->'payment') then
      raise exception 'Group membership and payment amount or confirmation cannot change.' using errcode='PT400';
    end if;
    if nullif(btrim(v_after->>'name'),'') is null or length(v_after->>'name')>80
      or exists(select 1 from jsonb_array_elements(p_state->'teams') t where t->>'id'<>v_after->>'id' and lower(t->>'name')=lower(v_after->>'name')) then
      raise exception 'Enter a unique team name of up to 80 characters.' using errcode='PT400';
    end if;
    if nullif(btrim(v_after->>'forane'),'') is null or length(v_after->>'forane')>80 or nullif(btrim(v_after->>'parish'),'') is null or length(v_after->>'parish')>80
      or not coalesce(v_after->>'centreType' in ('Parish','Mass Centre','Mission Centre'),false) then
      raise exception 'Choose a valid parish or centre.' using errcode='PT400';
    end if;
    if v_after->'forane' is distinct from v_target->'forane' or v_after->'parish' is distinct from v_target->'parish' or v_after->'centreType' is distinct from v_target->'centreType'
      or v_after->'group'->'coordinator' is distinct from v_target->'group'->'coordinator'
      or v_after->'payment'->'txnRef' is distinct from v_target->'payment'->'txnRef' then
      raise exception 'Parish, coordinator and UTR must stay shared across the registration.' using errcode='PT400';
    end if;
    if v_group is not null and (nullif(btrim(v_after->'group'->'coordinator'->>'name'),'') is null
      or length(v_after->'group'->'coordinator'->>'name')>80 or not coalesce(v_after->'group'->'coordinator'->>'mobile' ~ '^\+?[0-9 ()-]{7,20}$',false)) then
      raise exception 'Enter a valid parish coordinator and mobile number.' using errcode='PT400';
    end if;
    if jsonb_typeof(v_after->'players') is distinct from 'array' or jsonb_array_length(v_after->'players')<>2 then
      raise exception 'Enter exactly two players.' using errcode='PT400';
    end if;
    for v_player in select * from jsonb_array_elements(v_after->'players') loop
      if jsonb_typeof(v_player) is distinct from 'object' or v_player-array['name','mobile','idType','idLast4']<>'{}'::jsonb
        or nullif(btrim(v_player->>'name'),'') is null or length(v_player->>'name')>80
        or not coalesce(v_player->>'mobile' ~ '^\+?[0-9 ()-]{7,20}$',false)
        or not coalesce(v_player->>'idType' in ('Aadhaar','Voter ID','Driving Licence','Passport','Other'),false)
        or not coalesce(v_player->>'idLast4' ~ '^[A-Z0-9]{4}$',false) then
        raise exception 'Enter valid player names, mobile numbers and ID details.' using errcode='PT400';
      end if;
    end loop;
    if not coalesce(v_after->'primaryContact' in ('0'::jsonb,'1'::jsonb),false)
      or not coalesce(v_after->'lunch' in ('0'::jsonb,'1'::jsonb,'2'::jsonb),false)
      or (v_after->>'lunch')::int<coalesce((v_before->>'lunchServed')::int,0) then
      raise exception 'Choose a primary contact and valid lunch bookings, keeping lunches already served.' using errcode='PT400';
    end if;
    if v_before->'payment' is not null then
      if not coalesce(v_after->'payment'->>'txnRef' ~ '^([A-Z0-9]{6,30})?$',false)
        or (coalesce(v_after->'payment'->>'txnRef','')='' and v_after->'payment'->'screenshot' is distinct from 'true'::jsonb)
        or v_after->'payment'->'screenshot' is distinct from (case when p_payment<>'' then 'true'::jsonb else v_before->'payment'->'screenshot' end) then
        raise exception 'Enter a valid UTR or keep a payment screenshot.' using errcode='PT400';
      end if;
    elsif p_payment<>'' then raise exception 'This registration has no payment record to update.' using errcode='PT400';
    end if;
    v_changed := v_before->>'id'=p_team_id or (v_after-'registrationVersion') is distinct from (v_before-'registrationVersion') or p_payment<>'';
    if coalesce((v_after->>'registrationVersion')::bigint,0) <> coalesce((v_before->>'registrationVersion')::bigint,0)+(case when v_changed then 1 else 0 end) then
      raise exception 'Invalid registration revision.' using errcode='PT400';
    end if;
  end loop;
  if public.parish_key(v_team->>'parish')<>public.parish_key(v_target->>'parish') then
    select count(*) into v_count from jsonb_array_elements(p_state->'teams') t where public.parish_key(t->>'parish')=public.parish_key(v_target->>'parish');
    if v_count>coalesce((v_old->'event'->>'maxTeamsPerParish')::int,4) then raise exception 'The selected parish would exceed its team limit.' using errcode='PT400'; end if;
  end if;
  for v_key,v_value in select * from jsonb_each(p_photos) loop
    v_path := v_value#>>'{}';
    if v_key not in ('0','1') or jsonb_typeof(v_value)<>'string' then raise exception 'Invalid player photo.' using errcode='PT400'; end if;
    if v_path !~ ('^'||p_id||'/[0-9a-f-]{36}/player-'||((v_key::int)+1)||'\.jpg$')
      or not exists(select 1 from storage.objects where bucket_id='team-files' and name=v_path)
      or not exists(select 1 from storage.objects where bucket_id='team-files' and name=regexp_replace(v_path,'\.jpg$','-thumb.jpg')) then
      raise exception 'Upload a full photo and thumbnail for each replacement.' using errcode='PT400';
    end if;
  end loop;
  if p_payment<>'' and (p_payment !~ ('^'||p_id||'/[0-9a-f-]{36}/payment\.jpg$') or not exists(select 1 from storage.objects where bucket_id='team-files' and name=p_payment)) then
    raise exception 'Upload the replacement payment screenshot.' using errcode='PT400';
  end if;
  v_result := public.save_tournament(p_expected,p_state,null,'update-registration',p_detail,p_id);
  for v_key,v_value in select * from jsonb_each(p_photos) loop
    insert into public.player_photos(event,team_id,player,path) values(p_id,p_team_id,v_key::int,v_value#>>'{}')
      on conflict(event,team_id,player) do update set path=excluded.path;
  end loop;
  if p_payment<>'' then
    insert into public.payment_proofs(event,team_id,path) select p_id,t,p_payment from unnest(v_ids) t
      on conflict(event,team_id) do update set path=excluded.path;
  end if;
  return v_result;
end $$;
revoke all on function public.save_registration(bigint,jsonb,text,jsonb,text,jsonb,text) from public,anon;
grant execute on function public.save_registration(bigint,jsonb,text,jsonb,text,jsonb,text) to authenticated,service_role;
