-- CARROMIA: drop the pictures kept in the database before Supabase Storage was used.
-- Run only after scripts/move-images-to-storage.mjs reports nothing left to move, after
-- 20261005000000_carromia_storage.sql. Safe to re-run.

delete from public.player_photos where path is null;
delete from public.payment_proofs where path is null;
alter table public.player_photos drop column if exists image;
alter table public.payment_proofs drop column if exists image;
alter table public.player_photos alter column path set not null;
alter table public.payment_proofs alter column path set not null;

