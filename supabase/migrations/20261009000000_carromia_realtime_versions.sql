-- CARROMIA: a screen that has just joined its Realtime channel asks tournament_versions() for the
-- events' current versions. The answer also says whether the database announces changes (the
-- announce_change trigger from 20261008000000_carromia_realtime.sql is in place and enabled), so
-- the screen can stop checking every 10 seconds straight away rather than after the first change.
-- Before this file is run the call fails, and screens keep checking as before.
-- Returns only what anyone can already read from public.tournament_public.
-- Run after 20261008000000_carromia_realtime.sql. Safe to re-run.

create or replace function public.tournament_versions(p_ids text[])
returns table (id text, version bigint, "practiceOff" boolean, announced boolean)
language sql stable set search_path = '' as $$
  select t.id, t.version, coalesce((t.state->'event'->>'practiceOff')::boolean, false),
    exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = 'public.tournament_public'::regclass and g.tgname = 'announce_change' and g.tgenabled <> 'D')
  from public.tournament_public t
  where t.id = any(p_ids)
$$;
grant execute on function public.tournament_versions(text[]) to anon, authenticated;
