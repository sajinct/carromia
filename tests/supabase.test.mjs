import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { centre, player, photo } from './registration-fixture.mjs';

// A minimal stand-in for the Supabase REST and Auth endpoints the server uses.
function mockSupabase() {
  const db = { row: null, public: null, audit: [], photos: [], badKeyHeaders: 0 };
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass' }, 'omar@example.org': { id: 'u2', password: 'official-pass' }, 'guest@example.org': { id: 'u3', password: 'guest-pass' } };
  const officials = { u1: { name: 'Asha Admin', role: 'admin' }, u2: { name: 'Omar Official', role: 'official' } };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null, url = new URL(req.url, 'http://x'), q = k => url.searchParams.get(k)?.replace(/^eq\./, '');
    if (req.headers.apikey !== 'sb_secret_test' || req.headers.authorization) db.badKeyHeaders++;
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (url.pathname === '/rest/v1/tournament' && req.method === 'GET') return reply(200, db.row ? [structuredClone(db.row)] : []);
    if (url.pathname === '/rest/v1/rpc/save_tournament') {
      const current = db.row?.version ?? 0; if (body.p_expected !== current) return reply(409, { message: 'The event was changed from another session. Please try again.' });
      db.row = { version: current + 1, state: body.p_state }; db.public = body.p_public; return reply(200, db.row.version);
    }
    if (url.pathname === '/rest/v1/audit_log' && req.method === 'POST') { db.audit.push(body); return reply(201); }
    if (url.pathname === '/rest/v1/player_photos' && req.method === 'POST') { db.photos.push(...body); return reply(201); }
    if (url.pathname === '/rest/v1/player_photos' && req.method === 'GET') return reply(200, db.photos.filter(p => p.event === q('event')));
    if (url.pathname === '/rest/v1/officials') return reply(200, officials[q('user_id')] ? [officials[q('user_id')]] : []);
    if (url.pathname === '/auth/v1/token') { const u = users[body.email]; return u?.password === body.password ? reply(200, { access_token: 'jwt', user: { id: u.id, email: body.email } }) : reply(400, { error_description: 'Invalid login credentials' }); }
    const account = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(url.pathname)?.[1];
    if (account && req.method === 'PUT') { Object.values(users).find(u => u.id === account).password = body.password; return reply(200, {}); }
    reply(404, { message: 'not mocked' });
  });
  return { db, server };
}

test('Supabase mode: named officials, roles, audit trail, and conflict-safe saves', async t => {
  const { db, server: mock } = mockSupabase();
  await new Promise(resolve => mock.listen(3110, '127.0.0.1', resolve)); t.after(() => mock.close());
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: '3111', SUPABASE_URL: 'http://127.0.0.1:3110/', SUPABASE_SECRET_KEY: 'sb_secret_test', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  const base = 'http://localhost:3111';
  const post = (path, body, cookie = '') => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const state = async (cookie = '') => (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json();
  const login = async (email, password) => { const res = await post('login', { email, password }); assert.equal(res.status, 200, `${email} should sign in`); return res.headers.get('set-cookie').split(';')[0]; };

  assert.equal((await state()).authMode, 'supabase');
  // The registration deadline is removed so this test passes on any date.
  assert.equal((await post('settings', { durationMinutes: 30, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '' }, await login('asha@example.org', 'admin-pass'))).status, 200);
  const players = [player('A One', '9111111111'), player('B Two', '9222222222')];
  for (let i = 1; i <= 4; i++) assert.equal((await post('register', { name: `Team ${i}`, ...centre(0), adults: true, players })).status, 201);
  assert.equal((await post('register', { name: 'Team 5', ...centre(0), adults: true, players })).status, 400, 'at most four teams per parish');
  assert.equal(db.photos.length, 8); assert.ok(!JSON.stringify(db.row.state).includes('base64'), 'photos are stored apart from the event');
  assert.equal(db.row.version, 5); assert.equal(db.row.state.teams.length, 4);

  assert.equal((await post('login', { email: 'asha@example.org', password: 'wrong' })).status, 401);
  assert.equal((await post('login', { email: 'guest@example.org', password: 'guest-pass' })).status, 401, 'non-officials cannot sign in');
  const official = await login('omar@example.org', 'official-pass'), admin = await login('ASHA@example.org ', 'admin-pass');
  assert.deepEqual((await state(official)).user, { name: 'Omar Official', role: 'official' });
  assert.deepEqual((await (await fetch(`${base}/api/photos`, { headers: { Cookie: official } })).json())['CAR-001'], [photo, photo]);

  for (const t of db.row.state.teams) assert.equal((await post('checkin', { id: t.id }, official)).status, 200);
  assert.equal((await post('draw', {}, official)).status, 403, 'officials cannot create the draw');
  assert.equal((await fetch(`${base}/api/backup`, { headers: { Cookie: official } })).status, 403);
  assert.equal((await post('draw', {}, admin)).status, 200);

  // Another server instance saves in between: this save must be rejected and the view reloaded.
  db.row = { version: db.row.version + 1, state: { ...db.row.state, event: { ...db.row.state.event, venue: 'Changed elsewhere' } } };
  const ready = (await state(official)).matches.find(m => m.status === 'ready');
  assert.equal((await post('assign', { id: ready.id, board: 1 }, official)).status, 409);
  assert.equal((await state()).event.venue, 'Changed elsewhere');
  assert.equal((await post('assign', { id: ready.id, board: 1 }, official)).status, 200);
  assert.equal(db.row.state.matches.find(m => m.id === ready.id).status, 'called');
  assert.equal(db.row.state.event.venue, 'Changed elsewhere', 'the retry builds on the other instance’s change');

  // An official changes their own password; the current one must be right.
  assert.equal((await post('change-password', { current: 'official-pass', password: 'new-secret-1' })).status, 401, 'signed-out visitors cannot change a password');
  assert.equal((await post('change-password', { current: 'wrong', password: 'new-secret-1' }, official)).status, 401);
  assert.equal((await post('change-password', { current: 'official-pass', password: 'short' }, official)).status, 400);
  assert.equal((await post('change-password', { current: 'official-pass', password: 'new-secret-1' }, official)).status, 200);
  assert.equal((await post('login', { email: 'omar@example.org', password: 'official-pass' })).status, 401, 'the old password stops working');
  await login('omar@example.org', 'new-secret-1');
  assert.deepEqual((await state(official)).user, { name: 'Omar Official', role: 'official' }, 'they stay signed in');

  await new Promise(resolve => setTimeout(resolve, 100));
  const actions = db.audit.map(a => `${a.actor_name}:${a.action}`);
  assert.ok(actions.includes('Public registration:register')); assert.ok(actions.includes('Omar Official:checkin')); assert.ok(actions.includes('Asha Admin:draw')); assert.ok(actions.includes('Omar Official:assign')); assert.ok(actions.includes('Omar Official:change-password'));
  for (const secret of ['admin-pass', 'official-pass', 'new-secret-1', 'wrong']) assert.ok(!JSON.stringify(db.audit).includes(secret), 'passwords never reach the audit log');
  assert.equal(db.public.teams.length, 4); assert.ok(!JSON.stringify(db.public).includes('9111111111'), 'the public copy has no mobile numbers'); assert.ok(!JSON.stringify(db.public).includes('checkinToken'));
  assert.equal(db.badKeyHeaders, 0, 'sb_secret keys are sent only in the apikey header');
});
