import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { centre, player, photo } from './registration-fixture.mjs';

// A minimal stand-in for the Supabase REST and Auth endpoints the server uses.
function mockSupabase() {
  const db = { row: null, public: null, audit: [], photos: [], files: new Map(), badKeyHeaders: 0 };
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass' }, 'omar@example.org': { id: 'u2', password: 'official-pass' }, 'guest@example.org': { id: 'u3', password: 'guest-pass' }, 'cara@example.org': { id: 'u4', password: 'checkin-pass' }, 'lena@example.org': { id: 'u5', password: 'lunch-pass' }, 'uma@example.org': { id: 'u6', password: 'umpire-pass' } };
  const officials = { u1: { name: 'Asha Admin', role: 'admin', boards: [] }, u2: { name: 'Omar Official', role: 'official', boards: [] }, u4: { name: 'Cara Checkin', role: 'checkin', boards: [] }, u5: { name: 'Lena Lunch', role: 'lunch', boards: [] }, u6: { name: 'Uma Umpire', role: 'umpire', boards: [1] } };
  users['media@example.org'] = { id: 'u7', password: 'media-pass' };
  officials.u7 = { name: 'Media Manager', role: 'media', boards: [1] };
  db.officials = officials;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks), json = /json/.test(req.headers['content-type'] || '') || !req.headers['content-type'];
    const body = raw.length && json ? JSON.parse(raw) : null, url = new URL(req.url, 'http://x'), q = k => url.searchParams.get(k)?.replace(/^eq\./, '');
    if (req.headers.apikey !== 'sb_secret_test' || req.headers.authorization) db.badKeyHeaders++;
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (url.pathname === '/rest/v1/tournament' && req.method === 'GET') return reply(200, db.row ? [structuredClone(db.row)] : []);
    if (url.pathname === '/rest/v1/rpc/save_tournament') {
      const current = db.row?.version ?? 0; if (body.p_expected !== current) return reply(409, { message: 'The event was changed from another session. Please try again.' });
      db.row = { version: current + 1, state: body.p_state }; db.public = body.p_public;
      db.photos = db.photos.filter(p => body.p_state.teams.some(t => t.id === p.team_id)); // drop_orphan_photos()
      return reply(200, db.row.version);
    }
    if (url.pathname === '/rest/v1/audit_log' && req.method === 'POST') { db.audit.push(body); return reply(201); }
    if (url.pathname === '/rest/v1/player_photos' && req.method === 'POST') { db.photos.push(...body); return reply(201); }
    if (url.pathname === '/rest/v1/player_photos' && req.method === 'GET') return reply(200, db.photos.filter(p => p.event === q('event')));
    // Storage: files by bucket and path; unreferenced_files() lists the ones no photo row points at.
    const object = /^\/storage\/v1\/object\/([\w-]+)\/(.+)$/.exec(url.pathname);
    if (object && req.method === 'POST') { db.files.set(`${object[1]}/${object[2]}`, { bytes: raw, type: req.headers['content-type'] }); return reply(200, { Key: object[2] }); }
    if (object && req.method === 'GET') { const file = db.files.get(`${object[1]}/${object[2]}`); if (!file) return reply(400, { statusCode: '404', error: 'not_found' }); res.writeHead(200, { 'Content-Type': file.type }); return res.end(file.bytes); }
    const bucket = /^\/storage\/v1\/object\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (bucket && req.method === 'DELETE') { for (const name of body.prefixes) db.files.delete(`${bucket}/${name}`); return reply(200, []); }
    if (url.pathname === '/rest/v1/rpc/unreferenced_files') {
      const used = new Set(db.photos.flatMap(p => [p.path, p.path.replace('.jpg', '-thumb.jpg')]));
      return reply(200, [...db.files.keys()].map(k => ({ bucket: k.split('/')[0], name: k.slice(k.indexOf('/') + 1) })).filter(f => f.bucket === 'team-files' && !used.has(f.name)));
    }
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
  assert.equal((await post('settings', { gamesPerMatch: 3, gameMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '' }, await login('asha@example.org', 'admin-pass'))).status, 200);
  const players = [player('A One', '9111111111'), player('B Two', '9222222222')];
  for (let i = 1; i <= 4; i++) assert.equal((await post('register', { name: `Team ${i}`, ...centre(0), adults: true, players })).status, 201);
  assert.equal((await post('register', { name: 'Team 5', ...centre(0), adults: true, players })).status, 400, 'at most four teams per parish');
  assert.equal(db.photos.length, 8); assert.ok(!JSON.stringify(db.row.state).includes('base64'), 'photos are stored apart from the event');
  assert.ok(db.photos.every(p => /^main\/[0-9a-f-]{36}\/player-[12]\.jpg$/.test(p.path) && !p.image), 'photo rows hold the path of a file');
  assert.equal(db.files.size, 16, 'each photo and its thumbnail are files in Storage'); assert.equal(db.files.get(`team-files/${db.photos[0].path}`).type, 'image/jpeg');
  assert.equal(db.row.version, 5); assert.equal(db.row.state.teams.length, 4);

  assert.equal((await post('login', { email: 'asha@example.org', password: 'wrong' })).status, 401);
  assert.equal((await post('login', { email: 'guest@example.org', password: 'guest-pass' })).status, 401, 'non-officials cannot sign in');
  const official = await login('omar@example.org', 'official-pass'), admin = await login('ASHA@example.org ', 'admin-pass');
  assert.deepEqual((await state(official)).user, { name: 'Omar Official', role: 'official', boards: [] });
  const thumbs = (await (await fetch(`${base}/api/photos`, { headers: { Cookie: official } })).json())['CAR-001'];
  assert.deepEqual(thumbs, db.photos.filter(p => p.team_id === 'CAR-001').map(p => `/api/files/team-files/${p.path.replace('.jpg', '-thumb.jpg')}`));
  assert.deepEqual(Buffer.from(await (await fetch(base + thumbs[0], { headers: { Cookie: official } })).arrayBuffer()), Buffer.from(photo.split(',')[1], 'base64'), 'the server passes files on from Storage');
  // A removed team's files are deleted from Storage.
  assert.equal((await post('register', { name: 'Team X', ...centre(1), adults: true, players })).status, 201);
  assert.equal((await post('remove-team', { id: 'CAR-005' }, admin)).status, 200);
  assert.equal(db.files.size, 16); assert.equal(db.photos.length, 8);

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

  // One-job roles: each does only its own job, sees only what it needs, and an umpire only runs their boards.
  const desk = await login('cara@example.org', 'checkin-pass'), counter = await login('lena@example.org', 'lunch-pass'), umpire = await login('uma@example.org', 'umpire-pass');
  const deskView = await state(desk), counterView = await state(counter);
  assert.deepEqual(deskView.user, { name: 'Cara Checkin', role: 'checkin', boards: [] }); assert.deepEqual((await state(umpire)).user, { name: 'Uma Umpire', role: 'umpire', boards: [1] });
  assert.equal(deskView.teams[0].players[0].mobile, undefined, 'no contact numbers'); assert.equal(deskView.teams[0].players[0].idType, 'Aadhaar', 'the check-in desk compares IDs'); assert.ok(deskView.teams[0].checkinToken, 'a scanned QR code finds its team');
  assert.equal(counterView.teams[0].players[0].idType, undefined); assert.ok(counterView.teams[0].checkinToken, 'a scanned coupon finds its team');
  assert.equal((await post('checkin', { id: 'CAR-001' }, desk)).status, 200);
  for (const [path, body, cookie] of [['assign', { id: ready.id, board: 2 }, desk], ['confirm-payment', { id: 'CAR-001' }, desk], ['checkin', { id: 'CAR-001' }, counter], ['serve-lunch', { id: 'CAR-001' }, desk], ['checkin', { id: 'CAR-001' }, umpire], ['unassign', { id: ready.id }, umpire], ['assign', { id: ready.id, board: 1 }, umpire], ['draw', {}, umpire]]) {
    assert.equal((await post(path, body, cookie)).status, 403, `${path} is not part of this role`);
  }
  assert.equal((await fetch(`${base}/api/photos`, { headers: { Cookie: desk } })).status, 200, 'the check-in desk sees player photos');
  assert.equal((await fetch(`${base}/api/payment-proofs`, { headers: { Cookie: desk } })).status, 403);
  for (const cookie of [counter, umpire]) {
    assert.equal((await fetch(`${base}/api/photos`, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(base + thumbs[0], { headers: { Cookie: cookie } })).status, 403);
  }
  const other = (await state(official)).matches.find(m => m.status === 'ready' && !m.blockedReason);
  assert.equal((await post('assign', { id: other.id, board: 2 }, official)).status, 200);
  const refused = await post('start', { id: other.id }, umpire);
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /isn’t assigned to you/);
  assert.equal((await post('start', { id: ready.id }, umpire)).status, 200, 'the umpire starts the match on their board');
  assert.equal(db.row.state.matches.find(m => m.id === ready.id).status, 'playing'); assert.equal(db.row.state.matches.find(m => m.id === other.id).status, 'called');

  // An official changes their own password; the current one must be right.
  assert.equal((await post('change-password', { current: 'official-pass', password: 'new-secret-1' })).status, 401, 'signed-out visitors cannot change a password');
  assert.equal((await post('change-password', { current: 'wrong', password: 'new-secret-1' }, official)).status, 401);
  assert.equal((await post('change-password', { current: 'official-pass', password: 'short' }, official)).status, 400);
  assert.equal((await post('change-password', { current: 'official-pass', password: 'new-secret-1' }, official)).status, 200);
  assert.equal((await post('login', { email: 'omar@example.org', password: 'official-pass' })).status, 401, 'the old password stops working');
  await login('omar@example.org', 'new-secret-1');
  assert.deepEqual((await state(official)).user, { name: 'Omar Official', role: 'official', boards: [] }, 'they stay signed in');

  await new Promise(resolve => setTimeout(resolve, 100));
  const actions = db.audit.map(a => `${a.actor_name}:${a.action}`);
  assert.ok(actions.includes('Public registration:register')); assert.ok(actions.includes('Omar Official:checkin')); assert.ok(actions.includes('Asha Admin:draw')); assert.ok(actions.includes('Omar Official:assign')); assert.ok(actions.includes('Omar Official:change-password'));
  for (const secret of ['admin-pass', 'official-pass', 'new-secret-1', 'wrong']) assert.ok(!JSON.stringify(db.audit).includes(secret), 'passwords never reach the audit log');
  assert.equal(db.public.teams.length, 4); assert.ok(!JSON.stringify(db.public).includes('9111111111'), 'the public copy has no mobile numbers'); assert.ok(!JSON.stringify(db.public).includes('checkinToken'));
  assert.equal(db.badKeyHeaders, 0, 'sb_secret keys are sent only in the apikey header');
});


test('server media sessions enforce board scope and common gallery, including reassignment', async t => {
  const { db, server: mock } = mockSupabase();
  await new Promise(resolve => mock.listen(3116, '127.0.0.1', resolve)); t.after(() => mock.close());
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: '3117', SUPABASE_URL: 'http://127.0.0.1:3116/', SUPABASE_SECRET_KEY: 'sb_secret_test', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  const base = 'http://localhost:3117';
  const post = (path, body, cookie = '') => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const login = async (email, password) => (await post('login', { email, password })).headers.get('set-cookie').split(';')[0];
  const admin = await login('asha@example.org', 'admin-pass'), media = await login('media@example.org', 'media-pass');
  assert.equal((await post('demo', {}, admin)).status, 200);
  assert.equal((await post('media', { operation: 'settings', streamsEnabled: true, galleryEnabled: true }, admin)).status, 200);
  assert.equal((await post('media', { operation: 'stream', boardId: 1, url: 'https://youtu.be/M7lc1UVf-VE', enabled: true }, media)).status, 200);
  assert.equal((await post('media', { operation: 'stream', matchId: 'M01', url: 'https://youtu.be/M7lc1UVf-VE', enabled: true }, media)).status, 200);
  assert.equal((await post('media', { operation: 'stream', boardId: 2, remove: true }, media)).status, 400);
  assert.equal((await post('media', { operation: 'settings', galleryEnabled: false }, media)).status, 400);
  assert.equal((await post('media', { operation: 'add', title: 'Shared gallery', url: 'https://instagram.com/p/SHARED/', kind: 'photo' }, admin)).status, 200);
  const id = db.row.state.media.gallery[0].id;
  assert.equal((await post('media', { operation: 'review', id, status: 'approved' }, media)).status, 200);
  assert.equal(db.public.media.gallery[0].id, id);
  assert.equal((await post('start', { id: 'M01' }, media)).status, 403);
  assert.equal((await fetch(`${base}/api/photos`, { headers: { Cookie: media } })).status, 403);
  db.officials.u7.boards = [2];
  assert.equal((await post('media', { operation: 'stream', boardId: 1, remove: true }, media)).status, 400);
  assert.equal((await post('media', { operation: 'stream', boardId: 2, url: 'https://youtu.be/M7lc1UVf-VE', enabled: true }, media)).status, 200);
  assert.equal((await post('media', { operation: 'remove', id }, media)).status, 200);
  delete db.officials.u7;
  assert.equal((await post('media', { operation: 'stream', boardId: 2, remove: true }, media)).status, 401);
});
