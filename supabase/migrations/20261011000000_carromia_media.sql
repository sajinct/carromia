-- Optional board / match streams and manually approved social media links.
-- Run after 20261010000000_carromia_staff_roles.sql, before deploying the updated app.
-- JSON state is backwards compatible: missing media means both features are off.

create or replace function public.media_public_copy(p_media jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'streamsEnabled', coalesce(p_media->'streamsEnabled', 'false'::jsonb),
    'galleryEnabled', coalesce(p_media->'galleryEnabled', 'false'::jsonb),
    'streams', case when p_media->'streamsEnabled' = 'true'::jsonb then (
      select coalesce(jsonb_agg(jsonb_build_object('boardId', s.v->'boardId', 'matchId', s.v->'matchId',
        'enabled', s.v->'enabled', 'url', case when s.v->'enabled' = 'true'::jsonb then s.v->'url' else '""'::jsonb end) order by s.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_media->'streams', '[]'::jsonb)) with ordinality as s(v, n)
    ) else '[]'::jsonb end,
    'gallery', case when p_media->'galleryEnabled' = 'true'::jsonb then (
      select coalesce(jsonb_agg(jsonb_build_object('id', g.v->'id', 'url', g.v->'url', 'title', g.v->'title',
        'kind', g.v->'kind', 'status', g.v->'status') order by g.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_media->'gallery', '[]'::jsonb)) with ordinality as g(v, n)
      where g.v->>'status' = 'approved'
    ) else '[]'::jsonb end)
$$;

create or replace function public.public_copy(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(
    case when p_state ? 'media' then jsonb_set(p_state, '{media}', public.media_public_copy(p_state->'media')) else p_state end,
    '{activity}', '[]'::jsonb), '{teams}', (
    select coalesce(jsonb_agg((x.t - 'checkinToken' - 'payment' - 'confirmedBy' - 'group')
      || case when x.t ? 'group' then jsonb_build_object('group', jsonb_build_object('id', x.t->'group'->'id', 'size', x.t->'group'->'size')) else '{}'::jsonb end
      || jsonb_build_object('players', (
        select coalesce(jsonb_agg(jsonb_build_object('name', p.v->>'name') order by p.n), '[]'::jsonb)
        from jsonb_array_elements(coalesce(x.t->'players', '[]'::jsonb)) with ordinality as p(v, n))) order by x.n), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_state->'teams', '[]'::jsonb)) with ordinality as x(t, n)))
$$;

-- Enforce permissions independently of p_action, so a crafted save cannot publish media.
create or replace function public.guard_tournament_media() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if tg_op = 'UPDATE' and new.state->'media' is not distinct from old.state->'media' then return new; end if;
  if tg_op = 'INSERT' and not (new.state ? 'media') then return new; end if;
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  v_role := public.official_role();
  if v_role = 'admin' or (new.id = 'practice' and v_role = 'official') then return new; end if;
  raise exception 'Only an event admin can manage streams and gallery links.' using errcode = 'PT403';
end $$;
drop trigger if exists guard_tournament_media on public.tournament;
create trigger guard_tournament_media before insert or update on public.tournament
for each row execute function public.guard_tournament_media();

insert into public.tournament_public (id, version, state)
select id, version, public.public_copy(state) from public.tournament
on conflict (id) do update set version = excluded.version, state = excluded.state, updated_at = now();
