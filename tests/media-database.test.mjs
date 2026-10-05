import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { seedDemo, updateMedia, publicState } from '../lib/tournament.mjs';

const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const mediaId = '00000000-0000-0000-0000-000000000001', adminId = '00000000-0000-0000-0000-000000000002';

test('PostgreSQL enforces assigned-board media rights even for crafted save requests', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.officials (user_id uuid primary key, name text, role text, boards int[] not null default '{}',
      constraint officials_role_check check (role in ('admin','official','checkin','lunch','umpire')),
      constraint officials_boards_check check ((role = 'umpire' and cardinality(boards) > 0 and boards <@ array[1,2,3,4]) or (role <> 'umpire' and cardinality(boards) = 0)));
    create table public.tournament (id text primary key, version bigint, state jsonb, updated_at timestamptz default now());
    create table public.tournament_public (id text primary key, version bigint, state jsonb, updated_at timestamptz default now());
    create table public.audit_log (actor_id uuid, actor_name text, action text, detail jsonb);
    create function public.official_role() returns text language sql as $$ select role from public.officials where user_id = auth.uid() $$;
    create function public.team_ids(p_state jsonb) returns jsonb language sql as $$ select coalesce(jsonb_agg(t->'id' order by t->>'id'), '[]') from jsonb_array_elements(p_state->'teams') t $$;
    create function public.teams_without(p_teams jsonb, p_keys text[]) returns jsonb language sql as $$
      select coalesce(jsonb_agg(t - p_keys), '[]') from jsonb_array_elements(p_teams) t $$;
  `);
  // Use the actual existing save RPC, then run both real media migrations.
  const staff = migration('20261010000000_carromia_staff_roles.sql');
  await db.exec(staff.slice(staff.indexOf('create or replace function public.save_tournament')));
  await db.exec(migration('20261011000000_carromia_media.sql'));
  const roleMigration = migration('20261012000000_carromia_media_role.sql');
  await db.exec(roleMigration); await db.exec(roleMigration); // Re-running remains safe.
  await db.query('insert into public.officials (user_id,name,role,boards) values ($1,$2,$3,$4)', [mediaId, 'Media', 'media', [1]]);
  await db.query('insert into public.officials (user_id,name,role,boards) values ($1,$2,$3,$4)', [adminId, 'Admin', 'admin', []]);
  await assert.rejects(db.query('insert into public.officials (user_id,name,role,boards) values ($1,$2,$3,$4)', ['00000000-0000-0000-0000-000000000003', 'No boards', 'media', []]), /officials_boards_check/);
  const as = async (id, role = 'authenticated') => { await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [id, role]); };
  await as(adminId);
  const seed = seedDemo();
  updateMedia(seed, { operation: 'settings', streamsEnabled: true, galleryEnabled: true });
  for (const boardId of [1, 2]) {
    updateMedia(seed, { operation: 'stream', boardId, enabled: true, url: 'https://youtu.be/M7lc1UVf-VE' });
    updateMedia(seed, { operation: 'add', boardId, title: `Board ${boardId}`, kind: 'photo', url: `https://instagram.com/p/BOARD${boardId}/` });
  }
  updateMedia(seed, { operation: 'add', title: 'Event-wide', kind: 'photo', url: 'https://instagram.com/p/EVENT/' });
  await db.query('insert into public.tournament (id,version,state) values ($1,1,$2)', ['main', seed]);
  await db.query('insert into public.tournament (id,version,state) values ($1,1,$2)', ['practice', seed]);
  const current = async (event = 'main') => (await db.query('select version,state from public.tournament where id=$1', [event])).rows[0];
  const save = async (edit, event = 'main', action = 'media') => {
    const row = await current(event), next = structuredClone(row.state); edit(next);
    return db.query('select public.save_tournament($1,$2,null,$3,null,$4)', [row.version, next, action, event]);
  };
  await as(mediaId);
  await save(s => updateMedia(s, { operation: 'stream', boardId: 1, enabled: false, url: 'https://youtu.be/M7lc1UVf-VE' }));
  await save(s => updateMedia(s, { operation: 'stream', matchId: 'M01', enabled: true, url: 'https://youtu.be/M7lc1UVf-VE' }));
  await save(s => updateMedia(s, { operation: 'add', boardId: 1, title: 'New photo', kind: 'photo', url: 'https://instagram.com/p/NEW/' }));
  await save(s => updateMedia(s, { operation: 'review', id: s.media.gallery.find(g => g.title === 'New photo').id, status: 'approved' }));
  // Gallery items from any contributor can be approved and removed by another media manager.
  await save(s => updateMedia(s, { operation: 'review', id: s.media.gallery.find(g => g.title === 'Board 2').id, status: 'approved' }));
  await save(s => updateMedia(s, { operation: 'remove', id: s.media.gallery.find(g => g.title === 'Event-wide').id }));
  const row = await current();
  const publicRow = (await db.query('select state from public.tournament_public where id=$1', ['main'])).rows[0];
  assert.deepEqual(publicRow.state, publicState(row.state), 'SQL and JS public copies agree, including shared-gallery approvals and pending filtering');

  const unowned = [
    s => updateMedia(s, { operation: 'stream', boardId: 2, enabled: false, url: 'https://youtu.be/M7lc1UVf-VE' }),
    s => updateMedia(s, { operation: 'stream', boardId: 2, remove: true }),
    s => updateMedia(s, { operation: 'stream', matchId: 'M02', boardId: 1, enabled: true, url: 'https://youtu.be/M7lc1UVf-VE' }),
    s => updateMedia(s, { operation: 'stream', matchId: 'M05', boardId: 1, enabled: true, url: 'https://youtu.be/M7lc1UVf-VE' }),
    s => { s.media = { ...s.media, streams: [] }; }
  ];
  for (const edit of unowned) await assert.rejects(save(edit), /assigned to you/);
  await assert.rejects(save(s => { s.media.streamsEnabled = false; }), /Only an event admin/);
  await assert.rejects(save(s => { s.media.galleryEnabled = false; }, 'practice'), /Only an event admin/);
  for (const edit of [s => { s.teams[0].checkedIn = false; }, s => { s.matches[0].status = 'playing'; }, s => { s.boards[0].availableAt = 999; }]) {
    await assert.rejects(save(edit, 'main', 'start'), /only change streams and gallery/);
    await assert.rejects(save(edit, 'practice', 'start'), /only change streams and gallery/);
  }
  // Reassignment applies even if the browser keeps its previous profile.
  await db.query('update public.officials set boards=$1 where user_id=$2', [[2], mediaId]);
  await assert.rejects(save(s => updateMedia(s, { operation: 'stream', boardId: 1, remove: true })), /assigned to you/);
  await save(s => updateMedia(s, { operation: 'stream', boardId: 2, remove: true }));
  await save(s => updateMedia(s, { operation: 'review', id: s.media.gallery.find(g => g.title === 'New photo').id, status: 'pending' }));
  await as(adminId);
  await save(s => updateMedia(s, { operation: 'settings', streamsEnabled: false, galleryEnabled: false }));
  await db.query('update public.officials set role=$1,boards=$2 where user_id=$3', ['official', [], mediaId]);
  await as(mediaId);
  await assert.rejects(save(s => updateMedia(s, { operation: 'stream', boardId: 1, remove: true })), /admin or an assigned media manager/);
  await save(s => updateMedia(s, { operation: 'stream', boardId: 2, remove: true }), 'practice');
});
