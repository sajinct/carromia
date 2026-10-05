-- Public social links enter the existing common gallery as pending; no public approval path.
-- Run after 20261012000000_carromia_media_role.sql. No Edge Function update is required.
create table if not exists public.gallery_submission_limits (
  event text not null references public.tournament(id) on delete cascade,
  client_id uuid not null,
  window_started timestamptz not null default now(),
  submissions int not null default 1,
  primary key (event, client_id)
);
alter table public.gallery_submission_limits enable row level security;
revoke all on public.gallery_submission_limits from public, anon, authenticated;

-- Normalize only recognised HTTPS social-media URLs; never receive HTML or embed code.
create or replace function public.normalize_gallery_link(p_url text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_url text := btrim(coalesce(p_url, '')); v_match text[]; v_id text;
begin
  if length(v_url) > 2000 or v_url ~ '[[:space:]<>"\\]' then
    raise exception 'Use a complete, secure social media post link.' using errcode = 'PT400';
  end if;
  if v_url ~ '^https://(?:www\.|m\.)?youtube\.com/watch\?' then
    v_match := regexp_match(v_url, '[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)');
    v_id := v_match[1];
  else
    v_match := regexp_match(v_url, '^https://youtu\.be/([A-Za-z0-9_-]{11})(?:[?#].*)?$');
    if v_match is null then
      v_match := regexp_match(v_url, '^https://(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com)/(?:live|shorts|embed)/([A-Za-z0-9_-]{11})/?(?:[?#].*)?$');
    end if;
    v_id := v_match[1];
  end if;
  if v_id is not null then return 'https://www.youtube.com/watch?v=' || v_id; end if;
  v_match := regexp_match(v_url, '^https://(?:www\.|m\.)?instagram\.com/(p|reel|tv)/([A-Za-z0-9_-]+)/?(?:[?#].*)?$');
  if v_match is not null then return 'https://www.instagram.com/' || v_match[1] || '/' || v_match[2] || '/'; end if;
  if v_url ~ '^https://(?:www\.|m\.|web\.)?facebook\.com/[^/?#]+' then
    return regexp_replace(split_part(v_url, '#', 1), '^https://(?:www\.|m\.|web\.)?facebook\.com/', 'https://www.facebook.com/');
  end if;
  if v_url ~ '^https://fb\.watch/[^/?#]+' then return split_part(v_url, '#', 1); end if;
  raise exception 'Use a YouTube, Facebook or Instagram photo or video post link.' using errcode = 'PT400';
end $$;

create or replace function public.guard_tournament_media() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_boards int[];
  v_old jsonb;
  v_new jsonb;
  v_default jsonb := '{"streamsEnabled":false,"galleryEnabled":false,"streams":[],"gallery":[]}'::jsonb;
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  -- This setting exists only during submit_gallery_link(); still verify the exact append.
  if current_setting('carromia.public_gallery_submission', true) = 'on' then
    if tg_op <> 'UPDATE' or (new.state - 'media') is distinct from (old.state - 'media') then
      raise exception 'A public submission can only add a pending gallery link.' using errcode = 'PT403';
    end if;
    v_old := old.state->'media'; v_new := new.state->'media';
    if (v_new - 'gallery') is distinct from (v_old - 'gallery')
       or jsonb_array_length(v_new->'gallery') <> jsonb_array_length(coalesce(v_old->'gallery', '[]'::jsonb)) + 1
       or ((v_new->'gallery') - 0) is distinct from coalesce(v_old->'gallery', '[]'::jsonb)
       or v_new->'gallery'->0->>'status' is distinct from 'pending'
       or v_new->'gallery'->0->>'source' is distinct from 'public' then
      raise exception 'A public submission can only add a pending gallery link.' using errcode = 'PT403';
    end if;
    return new;
  end if;

  select role, boards into v_role, v_boards from public.officials where user_id = auth.uid();
  if v_role = 'admin' then return new; end if;
  if v_role = 'media' then
    if tg_op <> 'UPDATE' then raise exception 'Only an event admin can create an event.' using errcode = 'PT403'; end if;
    if (new.state - 'media' - 'activity') is distinct from (old.state - 'media' - 'activity') then
      raise exception 'Media managers can only change streams and gallery.' using errcode = 'PT403';
    end if;
    v_old := coalesce(old.state->'media', v_default);
    v_new := coalesce(new.state->'media', v_default);
    if (v_new - 'streams' - 'gallery') is distinct from (v_old - 'streams' - 'gallery') then
      raise exception 'Only an event admin can change the media display settings.' using errcode = 'PT403';
    end if;
    if public.media_streams_outside_boards(v_new->'streams', old.state->'matches', v_boards)
       is distinct from public.media_streams_outside_boards(v_old->'streams', old.state->'matches', v_boards) then
      raise exception 'This board isn’t assigned to you.' using errcode = 'PT403';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.state->'media' is not distinct from old.state->'media' then return new; end if;
  if tg_op = 'INSERT' and not (new.state ? 'media') then return new; end if;
  if new.id = 'practice' and v_role = 'official' then return new; end if;
  raise exception 'Only an event admin or an assigned media manager can manage media.' using errcode = 'PT403';
end $$;


-- The endpoint accepts content fields only. Status, source, ID and timestamps are set here.
create or replace function public.submit_gallery_link(p_event text, p_url text, p_title text, p_kind text, p_client_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set carromia.public_gallery_submission = 'on' as $$
declare
  v_state jsonb;
  v_media jsonb;
  v_gallery jsonb;
  v_url text := public.normalize_gallery_link(p_url);
  v_title text := btrim(coalesce(p_title, ''));
  v_count int;
  v_version bigint;
begin
  if p_event not in ('main', 'practice') or p_event is null then raise exception 'Unknown event.' using errcode = 'PT400'; end if;
  if v_title = '' or length(v_title) > 120 then raise exception 'Add a caption of up to 120 characters.' using errcode = 'PT400'; end if;
  if p_kind is null or p_kind not in ('photo', 'video') then raise exception 'Choose photo or video.' using errcode = 'PT400'; end if;
  if p_client_id is null then raise exception 'Refresh the page and try again.' using errcode = 'PT400'; end if;
  if p_event = 'practice' and exists(select 1 from public.tournament where id = 'main' and state->'event'->'practiceOff' = 'true'::jsonb) then
    raise exception 'Practice mode is turned off.' using errcode = 'PT400';
  end if;
  select state into v_state from public.tournament where id = p_event for update;
  v_media := v_state->'media';
  if v_media is null or v_media->'galleryEnabled' is distinct from 'true'::jsonb then
    raise exception 'The photo & video wall is not accepting links right now.' using errcode = 'PT400';
  end if;
  v_gallery := coalesce(v_media->'gallery', '[]'::jsonb);
  if jsonb_array_length(v_gallery) >= 200 then raise exception 'The gallery is full. Please try again later.' using errcode = 'PT400'; end if;
  if exists(select 1 from jsonb_array_elements(v_gallery) as g where g->>'url' = v_url) then
    raise exception 'This link is already in the gallery or waiting for review.' using errcode = 'PT400';
  end if;
  -- A browser identifier limits accidental repeated submissions. It contains no contact details.
  delete from public.gallery_submission_limits where window_started < now() - interval '1 day';
  insert into public.gallery_submission_limits(event, client_id) values (p_event, p_client_id)
  on conflict (event, client_id) do update set
    window_started = case when gallery_submission_limits.window_started < now() - interval '10 minutes' then now() else gallery_submission_limits.window_started end,
    submissions = case when gallery_submission_limits.window_started < now() - interval '10 minutes' then 1 else gallery_submission_limits.submissions + 1 end
  returning submissions into v_count;
  if v_count > 8 then raise exception 'Too many links from this browser. Try again in 10 minutes.' using errcode = 'PT429'; end if;
  v_gallery := jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'url', v_url, 'title', v_title, 'kind', p_kind,
    'status', 'pending', 'source', 'public', 'addedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)) || v_gallery;
  v_state := jsonb_set(v_state, '{media}', jsonb_set(v_media, '{gallery}', v_gallery));
  update public.tournament set state = v_state, version = version + 1, updated_at = now() where id = p_event returning version into v_version;
  insert into public.tournament_public(id, version, state) values (p_event, v_version, public.public_copy(v_state))
  on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.submit_gallery_link(text, text, text, text, uuid) from public;
grant execute on function public.submit_gallery_link(text, text, text, text, uuid) to anon, authenticated, service_role;
