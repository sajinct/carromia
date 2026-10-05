import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { seedDemo, updateMedia, publicState } from '../lib/tournament.mjs';

const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const mediaId = '00000000-0000-0000-0000-000000000001', adminId = '00000000-0000-0000-0000-000000000002';

async function mediaDatabase(t, restricted = false) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create role sql_editor nosuperuser;
    create schema auth;
  `);
  if (restricted) await db.exec('alter schema public owner to sql_editor; alter schema auth owner to sql_editor; set role sql_editor');
  await db.exec(`
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
  const publicMigration = migration('20261013000000_carromia_public_gallery.sql');
  await db.exec(publicMigration); await db.exec(publicMigration);
  return db;
}

test('PostgreSQL enforces assigned-board media rights even for crafted save requests', async t => {
  const db = await mediaDatabase(t);
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


test('PostgreSQL public gallery submissions stay pending and preserve all other event data', async t => {
  const db = await mediaDatabase(t), clientId = '11111111-1111-1111-1111-111111111111';
  const as = async (role, id = '') => db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [id, role]);
  await as('service_role');
  const seed = seedDemo(); updateMedia(seed, { operation: 'settings', streamsEnabled: true, galleryEnabled: true });
  await db.query('insert into public.tournament(id,version,state) values ($1,1,$2)', ['main', seed]);
  await db.query('insert into public.tournament(id,version,state) values ($1,1,$2)', ['practice', seed]);
  await db.query('insert into public.officials(user_id,name,role,boards) values ($1,$2,$3,$4)', [mediaId, 'Media', 'media', [1]]);
  await as('anon');
  const submit = (url, title = 'A shared moment', kind = 'photo', event = 'main', client = clientId) => db.query('select public.submit_gallery_link($1,$2,$3,$4,$5)', [event, url, title, kind, client]);
  for (const url of ['javascript:alert(1)', 'https://evil.example/photo', 'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE', 'https://user:pass@www.youtube.com/watch?v=M7lc1UVf-VE', 'https://www.youtube.com:8080/watch?v=M7lc1UVf-VE', 'https://facebook.com/', 'https://instagram.com/profile/', 'https://facebook.com/\\evil.example']) await assert.rejects(submit(url));
  await assert.rejects(submit('https://instagram.com/p/ABC/', '', 'photo'), /caption/);
  await assert.rejects(submit('https://instagram.com/p/ABC/', 'Caption', 'approved'), /photo or video/);
  await assert.rejects(submit('https://instagram.com/p/ABC/', 'Caption', 'photo', 'unknown'), /Unknown event/);
  await assert.rejects(submit('https://instagram.com/p/ABC/', 'Caption', 'photo', 'main', null), /Refresh/);
  await submit('https://youtu.be/M7lc1UVf-VE', '<script>safe caption</script>', 'video');
  await assert.rejects(submit('https://www.youtube.com/watch?v=M7lc1UVf-VE'), /already/);
  let row = (await db.query('select version,state from public.tournament where id=$1', ['main'])).rows[0];
  assert.equal(row.version, 2); assert.equal(row.state.media.gallery.length, 1);
  assert.equal(row.state.media.gallery[0].status, 'pending'); assert.equal(row.state.media.gallery[0].source, 'public');
  assert.deepEqual(row.state.teams, seed.teams); assert.deepEqual(row.state.matches, seed.matches);
  assert.deepEqual(row.state.boards, seed.boards); assert.deepEqual(row.state.event, seed.event); assert.deepEqual(row.state.activity, seed.activity);
  const publicRow = (await db.query('select state from public.tournament_public where id=$1', ['main'])).rows[0];
  assert.deepEqual(publicRow.state.media.gallery, []);
  // Even a direct update cannot use a public item to approve content or alter event data.
  for (const edit of [
    s => { s.media.gallery[0].status = 'approved'; },
    s => { s.media.streamsEnabled = false; },
    s => { s.matches[0].status = 'playing'; }
  ]) {
    const forged = structuredClone(row.state);
    forged.media.gallery.unshift({ ...forged.media.gallery[0], id: 'forged', url: 'https://www.instagram.com/p/FORGED/' });
    edit(forged);
    await assert.rejects(db.query('update public.tournament set state=$1 where id=$2', [forged, 'main']), /Only an event admin/);
  }
  await assert.rejects(db.query('select public.save_tournament($1,$2,null,$3,null,$4)', [row.version, row.state, 'media', 'main']), /Sign in as a tournament official/);
  for (let i = 1; i <= 7; i++) await submit(`https://instagram.com/p/PHOTO${i}/`);
  await assert.rejects(submit('https://instagram.com/p/NINTH/'), /Too many links/);
  await db.query("update public.gallery_submission_limits set window_started = now() - interval '11 minutes' where event=$1", ['main']);
  await submit('https://instagram.com/p/NINTH/');
  // Practice submissions do not enter the real event's gallery.
  await submit('https://instagram.com/p/PRACTICE/', 'Practice moment', 'photo', 'practice');
  assert.equal((await db.query('select state from public.tournament where id=$1', ['practice'])).rows[0].state.media.gallery.length, 1);
  await as('authenticated', mediaId);
  row = (await db.query('select version,state from public.tournament where id=$1', ['main'])).rows[0];
  updateMedia(row.state, { operation: 'review', id: row.state.media.gallery.find(p => p.kind === 'video').id, status: 'approved' });
  await db.query('select public.save_tournament($1,$2,null,$3,null,$4)', [row.version, row.state, 'media', 'main']);
  assert.equal((await db.query('select state from public.tournament_public where id=$1', ['main'])).rows[0].state.media.gallery.length, 1);
  // Public-submission markers do not permit changes to global display settings.
  row = (await db.query('select version,state from public.tournament where id=$1', ['main'])).rows[0];
  row.state.media.streamsEnabled = false;
  await assert.rejects(db.query('select public.save_tournament($1,$2,null,$3,null,$4)', [row.version, row.state, 'media', 'main']), /Only an event admin/);
  await as('service_role');
  await db.query("update public.tournament set state=jsonb_set(state,'{media,galleryEnabled}','false') where id='main'");
  await as('anon'); await assert.rejects(submit('https://instagram.com/p/CLOSED/'), /not accepting links/);
  await as('service_role');
  await db.query("update public.tournament set state=jsonb_set(state,'{event,practiceOff}','true') where id='main'");
  await as('anon'); await assert.rejects(submit('https://instagram.com/p/OFF/', 'Practice', 'photo', 'practice'), /Practice mode is turned off/);
});


test('public gallery migration and endpoint work for a non-superuser SQL editor', async t => {
  const db = await mediaDatabase(t, true);
  assert.equal((await db.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper, false);
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  const seed = seedDemo(); updateMedia(seed, { operation: 'settings', galleryEnabled: true });
  await db.query('insert into public.tournament(id,version,state) values ($1,1,$2)', ['main', seed]);
  await db.query("select set_config('request.jwt.claim.role','anon',false)");
  await db.query('select public.submit_gallery_link($1,$2,$3,$4,$5)', ['main', 'https://instagram.com/p/RESTRICTED/', 'A visitor photo', 'photo', '11111111-1111-1111-1111-111111111111']);
  const row = (await db.query('select state from public.tournament where id=$1', ['main'])).rows[0];
  assert.equal(row.state.media.gallery[0].status, 'pending');
  assert.deepEqual((await db.query('select state from public.tournament_public where id=$1', ['main'])).rows[0].state.media.gallery, []);
});
