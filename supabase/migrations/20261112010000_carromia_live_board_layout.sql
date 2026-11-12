-- Shared Live boards visibility and scorecard switches. Existing events default to all cards on.
-- Run after the registration-edit migration, before publishing the matching UI. Safe to rerun.
-- Existing media guards keep these global display settings admin-only.
create or replace function public.media_public_copy(p_media jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'streamsEnabled', coalesce(p_media->'streamsEnabled', 'false'::jsonb),
    'galleryEnabled', coalesce(p_media->'galleryEnabled', 'false'::jsonb),
    'boardLayout', (
      select coalesce(jsonb_agg(jsonb_build_object('boardId', l.v->'boardId',
        'visible', (l.v->'visible') is distinct from 'false'::jsonb,
        'showInfo', (l.v->'showInfo') is distinct from 'false'::jsonb) order by l.n), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(p_media->'boardLayout')='array' then p_media->'boardLayout' else '[]'::jsonb end) with ordinality l(v,n)
      where (l.v->'boardId') in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)
    ),
    'streams', case when p_media->'streamsEnabled' = 'true'::jsonb then (
      select coalesce(jsonb_agg(jsonb_build_object('boardId', s.v->'boardId', 'matchId', s.v->'matchId',
        'enabled', s.v->'enabled', 'url', case when s.v->'enabled' = 'true'::jsonb then s.v->'url' else '""'::jsonb end) order by s.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_media->'streams', '[]'::jsonb)) with ordinality s(v,n)
    ) else '[]'::jsonb end,
    'gallery', case when p_media->'galleryEnabled' = 'true'::jsonb then (
      select coalesce(jsonb_agg(jsonb_build_object('id', g.v->'id', 'url', g.v->'url', 'title', g.v->'title',
        'kind', g.v->'kind', 'status', g.v->'status') order by g.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_media->'gallery', '[]'::jsonb)) with ordinality g(v,n)
      where g.v->>'status' = 'approved'
    ) else '[]'::jsonb end)
$$;

-- Refresh only public copies; teams, fixtures, scoring, files and private event versions stay intact.
-- Match the normal parent-then-public lock order so a concurrent score cannot be overwritten by an older copy.
select id from public.tournament order by id for update;
update public.tournament_public p set state=public.public_copy(t.state), version=t.version
from public.tournament t where p.id=t.id;
