import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { photo } from './registration-fixture.mjs';

// The Edge Function is plain JavaScript in a .ts file (so it pastes into the Supabase editor).
const source = readFileSync(join(import.meta.dirname, '..', 'supabase', 'functions', 'registration', 'index.ts'), 'utf8');
const { handle } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

// A stand-in for Storage, the two RPCs the function calls, Auth and the officials table.
function fakeSupabase() {
  const db = { files: new Map(), rpc: [], registerError: null, unreferenced: [] };
  const reply = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status });
  db.fetch = async (href, init) => {
    const url = new URL(href), body = /json/.test(init.headers['Content-Type']) && init.body ? JSON.parse(init.body) : null;
    assert.equal(init.headers.apikey, 'sb_secret_test'); // every call uses the service key
    const object = /^\/storage\/v1\/object\/team-files\/(.+)$/.exec(url.pathname)?.[1];
    if (object && init.method === 'POST') { db.files.set(object, init.headers['Content-Type']); return reply(200, { Key: object }); }
    if (/^\/storage\/v1\/object\/[\w-]+$/.test(url.pathname) && init.method === 'DELETE') { for (const name of body.prefixes) db.files.delete(name); return reply(200, []); }
    if (url.pathname === '/rest/v1/rpc/register_teams') { db.rpc.push(body); return db.registerError ? reply(400, { message: db.registerError }) : reply(200, { teams: body.p_teams.map((t, i) => ({ id: `CAR-00${i + 1}`, name: t.name, status: body.p_payment ? 'pending' : 'confirmed' })) }); }
    if (url.pathname === '/rest/v1/rpc/group_form') { db.rpc.push(body); return reply(200, body.p_mobile === '9000000000' ? { teams: [{ team: { id: 'CAR-001' }, photos: ['main/a/player-1.jpg', 'main/a/player-2.jpg'] }, { team: { id: 'CAR-002' }, photos: ['main/b/player-1.jpg', 'main/b/player-2.jpg'] }] } : { error: 'That mobile number doesn’t match the parish coordinator’s.' }); }
    if (url.pathname === '/storage/v1/object/sign/team-files') return reply(200, body.paths.map(path => ({ path, signedURL: `/object/sign/team-files/${path}?token=t` })));
    if (url.pathname === '/rest/v1/rpc/unreferenced_files') return reply(200, db.unreferenced);
    if (url.pathname === '/auth/v1/user') return { 'token-official': reply(200, { id: 'u1' }), 'token-guest': reply(200, { id: 'u9' }) }[init.headers.Authorization?.replace('Bearer ', '')] ?? reply(401, { msg: 'invalid JWT' });
    if (url.pathname === '/rest/v1/officials') return reply(200, url.searchParams.get('user_id') === 'eq.u1' ? [{ role: 'official' }] : []);
    return reply(404, { message: 'not mocked' });
  };
  return db;
}

test('registration function: uploads checked pictures, cleans up after a refused registration, sweeps only for officials', async () => {
  const db = fakeSupabase();
  const call = async (body, token) => {
    const res = await handle(new Request('https://x/functions/v1/registration', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }), { url: 'https://example.supabase.co', key: 'sb_secret_test' }, db.fetch);
    return { status: res.status, body: await res.json() };
  };
  const players = [{ name: 'A', mobile: '9111111111', idType: 'Aadhaar', idLast4: '1234', photo, thumb: photo }, { name: 'B', mobile: '9222222222', idType: 'Aadhaar', idLast4: '1234', photo, thumb: photo }];
  const entry = { action: 'register', p_name: 'Team', p_event: 'practice', p_players: players };

  assert.equal((await handle(new Request('https://x', { method: 'OPTIONS' }), { url: 'https://x', key: 'sb_secret_test' }, db.fetch)).status, 204, 'CORS preflight');
  // Pictures are checked before anything is uploaded.
  for (const bad of [{ ...players[1], photo: 'data:image/png;base64,iVBORw0KGgo=' }, { ...players[1], thumb: undefined }, { ...players[1], photo: 'data:image/jpeg;base64,AAAA' }]) {
    const res = await call({ ...entry, p_players: [players[0], bad] });
    assert.equal(res.status, 400); assert.match(res.body.message, /photo of each player/); assert.equal(db.files.size, 0);
  }
  assert.match((await call({ ...entry, p_payment: { screenshot: 'data:image/gif;base64,R0lG' } })).body.message, /payment screenshot/);

  // A good registration: five files in one folder, and register_teams gets only their paths.
  let res = await call({ ...entry, p_payment: { txnRef: '412356789012', screenshot: photo } });
  assert.equal(res.status, 200); assert.equal(res.body.team.status, 'pending');
  const folder = [...db.files.keys()][0].split('/').slice(0, 2).join('/');
  assert.match(folder, /^practice\/[0-9a-f-]{36}$/);
  assert.deepEqual([...db.files.keys()].sort(), ['payment.jpg', 'player-1-thumb.jpg', 'player-1.jpg', 'player-2-thumb.jpg', 'player-2.jpg'].map(f => `${folder}/${f}`));
  assert.ok([...db.files.values()].every(type => type === 'image/jpeg'));
  const sent = db.rpc.at(-1);
  assert.equal(res.body.team.id, 'CAR-001', 'a single-team registration still answers with its team');
  assert.deepEqual(sent.p_teams.map(t => t.name), ['Team']); assert.deepEqual(sent.p_teams[0].players.map(p => p.photo), [`${folder}/player-1.jpg`, `${folder}/player-2.jpg`]); assert.deepEqual(sent.p_payment, { txnRef: '412356789012', screenshot: `${folder}/payment.jpg` });
  assert.ok(!JSON.stringify(sent).includes('base64'), 'no pictures reach the database'); assert.equal(sent.p_event, 'practice');

  // A parish's teams in one registration: a folder per team, the screenshot once in the first.
  db.files.clear();
  res = await call({ action: 'register', p_event: 'main', p_coordinator: { name: 'Fr. Coord', mobile: '9000000000' }, p_teams: [{ name: 'One', players, primaryContact: 1, lunch: 2 }, { name: 'Two', players }, { name: 'Three', players }], p_payment: { txnRef: '412356789012', screenshot: photo } });
  assert.equal(res.status, 200); assert.deepEqual(res.body.teams.map(t => t.id), ['CAR-001', 'CAR-002', 'CAR-003']); assert.equal(res.body.team.id, 'CAR-001');
  const group = db.rpc.at(-1), folders = group.p_teams.map(t => t.players[0].photo.split('/').slice(0, 2).join('/'));
  assert.equal(new Set(folders).size, 3); assert.equal(db.files.size, 3 * 4 + 1);
  assert.deepEqual(group.p_payment, { txnRef: '412356789012', screenshot: `${folders[0]}/payment.jpg` }); assert.deepEqual(group.p_coordinator, { name: 'Fr. Coord', mobile: '9000000000' });
  assert.deepEqual([group.p_teams[0].primaryContact, group.p_teams[0].lunch], [1, 2]);
  const tooMany = await call({ action: 'register', p_teams: Array.from({ length: 9 }, (_, i) => ({ name: `T${i}`, players })) });
  assert.equal(tooMany.status, 400); assert.match(tooMany.body.message, /up to 8 teams/);
  // One bad picture in any team: nothing is uploaded.
  db.files.clear();
  res = await call({ action: 'register', p_teams: [{ name: 'One', players }, { name: 'Two', players: [players[0], { ...players[1], thumb: undefined }] }] });
  assert.equal(res.status, 400); assert.equal(db.files.size, 0);
  // A refused group leaves no files behind either.
  db.registerError = 'Give each team a different name: “One” is used twice.';
  res = await call({ action: 'register', p_teams: [{ name: 'One', players }, { name: 'One', players }] });
  assert.equal(res.status, 400); assert.match(res.body.message, /used twice/); assert.equal(db.files.size, 0);
  db.registerError = null;

  // The coordinator's forms: each team's details with links to its own thumbnails.
  res = await call({ action: 'group-form', event: 'main', id: 'CAR-001', mobile: '9000000000' });
  assert.equal(res.status, 200); assert.deepEqual(res.body.teams.map(t => t.team.id), ['CAR-001', 'CAR-002']);
  assert.deepEqual(res.body.teams[1].photos, ['main/b/player-1-thumb.jpg', 'main/b/player-2-thumb.jpg'].map(p => `https://example.supabase.co/storage/v1/object/sign/team-files/${p}?token=t`));
  assert.match((await call({ action: 'group-form', event: 'main', id: 'CAR-001', mobile: '9111111111' })).body.error, /coordinator/);

  // A registration the database refuses leaves no files behind.
  db.files.clear(); db.registerError = 'That team name is already registered.';
  res = await call(entry);
  assert.equal(res.status, 400); assert.equal(res.body.message, 'That team name is already registered.'); assert.equal(db.files.size, 0);

  // Sweeping is for signed-in officials.
  db.unreferenced = [{ bucket: 'team-files', name: 'main/old/player-1.jpg' }]; db.files.set('main/old/player-1.jpg', 'image/jpeg');
  assert.equal((await call({ action: 'sweep' })).status, 401);
  assert.equal((await call({ action: 'sweep' }, 'forged')).status, 401);
  assert.equal((await call({ action: 'sweep' }, 'token-guest')).status, 403);
  assert.equal(db.files.size, 1);
  res = await call({ action: 'sweep' }, 'token-official');
  assert.deepEqual([res.status, res.body.deleted, db.files.size], [200, 1, 0]);
  assert.equal((await call({ action: 'nope' })).status, 400);
});
