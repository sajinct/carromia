-- CARROMIA: screens hear about changes instead of asking every few seconds.
-- * Whenever an event's public copy changes, a trigger sends a Realtime broadcast "changed" with
--   { version, practiceOff } on the public channel 'tournament:<event id>' ('tournament:main',
--   'tournament:practice'). Screens that receive it fetch the event once; while their connection is
--   down they fall back to a version check every 10 seconds.
-- * The message carries only what anyone can already read from public.tournament_public.
-- * A failed broadcast never blocks a save or a registration.
-- Needs Realtime's public channels (Project Settings -> Realtime: "Allow public access" on, the default).
-- Run after 20261007000000_carromia_group_registration.sql. Safe to re-run.

create or replace function public.announce_tournament_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('version', new.version, 'practiceOff', coalesce((new.state->'event'->>'practiceOff')::boolean, false)),
      'changed', 'tournament:' || new.id, false);
  exception when others then
    raise warning 'Realtime announcement failed: %', sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.announce_tournament_change() from public, anon, authenticated;

drop trigger if exists announce_change on public.tournament_public;
create trigger announce_change after insert or update on public.tournament_public
  for each row execute function public.announce_tournament_change();
