import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo, publicState } from '../lib/tournament.mjs';
const root = join(import.meta.dirname, '..');
test('Pages build is portable to a repository subpath and contains only static assets', () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: root });
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  assert.ok(html.includes('src="./app.js"')); assert.ok(!/(href|src)="\//.test(html));
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, 'dist', icon.src)));
  assert.ok(!readFileSync(join(root, 'dist/tournament-browser.js'), 'utf8').includes('node:crypto'));
  assert.ok(!readdirSync(join(root, 'dist')).includes('data'));
});
// An in-memory stand-in for the Supabase endpoints the live site calls, including the database rules.
function fakeSupabase() {
  const sample = seedDemo();
  const db = { row: { version: 1, state: sample }, public: { version: 1, state: publicState(sample) }, saves: [], raceOnce: false };
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass', official: { name: 'Asha Admin', role: 'admin' } }, 'omar@example.org': { id: 'u2', password: 'official-pass', official: { name: 'Omar Official', role: 'official' } } };
  const byToken = token => Object.values(users).find(u => `token-${u.id}` === token);
  const reply = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  db.fetch = async (href, init = {}) => {
    const url = new URL(href), body = init.body ? JSON.parse(init.body) : null, caller = byToken(init.headers?.Authorization?.replace('Bearer ', ''));
    assert.equal(init.headers.apikey, 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro');
    switch (url.pathname) {
      case '/rest/v1/rpc/server_time': return reply(200, Date.now());
      case '/rest/v1/tournament_public': return reply(200, [structuredClone(db.public)]);
      case '/rest/v1/tournament': return reply(200, caller?.official ? [structuredClone(db.row)] : []);
      case '/rest/v1/officials': return reply(200, caller ? [caller.official] : []);
      case '/auth/v1/token': { const u = users[body.email]; return u?.password === body.password ? reply(200, { access_token: `token-${u.id}`, refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: u.id } }) : reply(400, { error_description: 'Invalid login credentials' }); }
      case '/auth/v1/logout': return reply(204);
      case '/rest/v1/rpc/register_team': return db.row.state.demo ? reply(400, { message: 'Registration will open soon. Please check back.' }) : reply(200, { team: { id: 'CAR-001' } });
      case '/rest/v1/rpc/save_tournament': {
        if (!caller?.official) return reply(403, { message: 'Sign in as a tournament official.' });
        if (db.raceOnce) { db.raceOnce = false; db.row = { version: db.row.version + 1, state: { ...db.row.state, event: { ...db.row.state.event, venue: 'Changed elsewhere' } } }; }
        if (body.p_expected !== db.row.version) return reply(409, { message: 'The event was changed from another session. Please try again.' });
        db.row = { version: db.row.version + 1, state: body.p_state }; db.public = { version: db.row.version, state: body.p_public };
        db.saves.push({ by: caller.official.name, action: body.p_action }); return reply(200, db.row.version);
      }
      default: return reply(404, { message: 'not mocked' });
    }
  };
  return db;
}

test('live Pages runtime: public view, official sign-in, roles, conflict retry, and clearing sample data', async t => {
  const db = fakeSupabase(), memory = new Map(), realFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  globalThis.fetch = db.fetch;
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; });
  const { remoteApi } = await import('../dist/runtime.js');

  let state = await remoteApi('state');
  assert.equal(state.isAdmin, false); assert.equal(state.demo, true); assert.equal(state.teams.length, 16); assert.equal(state.teams[0].players[0].mobile, undefined);
  await assert.rejects(remoteApi('register', { name: 'Real team', parish: 'P', players: [] }), /open soon/);
  await assert.rejects(remoteApi('assign', { id: 'M05', board: 1 }), /Sign in/);
  await assert.rejects(remoteApi('login', { email: 'omar@example.org', password: 'wrong' }), /Incorrect email or password/);

  await remoteApi('login', { email: 'Omar@example.org ', password: 'official-pass' });
  state = await remoteApi('state');
  assert.equal(state.isAdmin, true); assert.deepEqual(state.user, { name: 'Omar Official', role: 'official' }); assert.equal(state.teams[0].players[0].mobile, '9000000000'); assert.equal(state.teams[0].checkinToken, undefined);
  await remoteApi('unassign', { id: 'M01' }); await remoteApi('assign', { id: 'M05', board: 1 }); await remoteApi('start', { id: 'M05' });
  assert.equal(db.row.state.matches.find(m => m.id === 'M05').status, 'playing');
  assert.equal(db.public.state.matches.find(m => m.id === 'M05').status, 'playing'); assert.ok(!JSON.stringify(db.public).includes('9000000000'), 'public copy has no mobiles');
  await assert.rejects(remoteApi('reset', { confirm: 'RESET' }), /Only an event admin/);

  db.raceOnce = true; await remoteApi('checkin', { id: 'CAR-001', checkedIn: true });
  assert.equal(db.row.state.event.venue, 'Changed elsewhere', 'the retry builds on the other official’s save');

  await remoteApi('logout'); await remoteApi('login', { email: 'asha@example.org', password: 'admin-pass' });
  await assert.rejects(remoteApi('reset', { confirm: 'nope' }), /Type RESET/);
  await remoteApi('reset', { confirm: 'RESET' });
  state = await remoteApi('state');
  assert.equal(state.teams.length, 0); assert.equal(state.matches.length, 0); assert.equal(state.demo, false); assert.equal(state.event.registrationOpen, true); assert.equal(state.event.date, '2026-11-15');
  assert.deepEqual(db.saves.map(s => `${s.by}:${s.action}`), ['Omar Official:unassign', 'Omar Official:assign', 'Omar Official:start', 'Omar Official:checkin', 'Asha Admin:reset']);
  await remoteApi('logout'); assert.equal((await remoteApi('state')).isAdmin, false);
});
