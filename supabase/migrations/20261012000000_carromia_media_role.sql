-- Media managers run streams for assigned boards and share the common gallery; global switches stay admin-only.
-- Run after 20261011000000_carromia_media.sql, then redeploy the officials Edge Function.
alter table public.officials drop constraint if exists officials_role_check;
alter table public.officials add constraint officials_role_check
  check (role in ('admin', 'official', 'checkin', 'lunch', 'umpire', 'media'));
alter table public.officials drop constraint if exists officials_boards_check;
alter table public.officials add constraint officials_boards_check check (
  (role in ('umpire', 'media') and cardinality(boards) > 0 and boards <@ array[1, 2, 3, 4])
  or (role not in ('umpire', 'media') and cardinality(boards) = 0));

-- A match stream follows the match's assigned board, never a boardId supplied by the caller.
create or replace function public.media_stream_board(p_stream jsonb, p_matches jsonb) returns int
language sql immutable as $$
  select case when coalesce(p_stream->>'matchId', '') <> '' then (
    select (m->>'board')::int from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) as m
    where m->>'id' = p_stream->>'matchId' limit 1
  ) else (p_stream->>'boardId')::int end
$$;

-- Compare streams outside the manager's boards; the gallery is shared by all media staff.
create or replace function public.media_streams_outside_boards(p_items jsonb, p_matches jsonb, p_boards int[]) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(x.v order by x.n), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, n)
  where not coalesce(public.media_stream_board(x.v, p_matches) = any(p_boards), false)
$$;

-- This trigger guards the whole write, independent of p_action and browser validation.
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

