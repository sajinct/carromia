-- CARROMIA: keep registration-alert recipients out of the visitor copy.
-- Run before publishing the registration-alert settings UI. Safe to re-run.
-- save_tournament() already restricts changes to real-event settings to admins.

create or replace function public.public_copy(p_state jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(jsonb_set(
    case when p_state ? 'media' then jsonb_set(p_state, '{media}', public.media_public_copy(p_state->'media')) else p_state end,
    '{event}', coalesce(p_state->'event', '{}'::jsonb) - 'registrationAlerts'),
    '{activity}', '[]'::jsonb), '{teams}', (
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
