import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Edge Function is plain JavaScript in a .ts file (so it pastes into the Supabase editor).
const source = readFileSync(join(import.meta.dirname, '..', 'supabase', 'functions', 'officials', 'index.ts'), 'utf8');
const { handle } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

// A stand-in for Supabase Auth (admin API) and PostgREST, holding users, officials and the audit log.
function fakeSupabase() {
  const db = {
    users: [{ id: 'u1', email: 'asha@example.org', password: 'admin-pass', last_sign_in_at: '2026-09-30T10:00:00Z' }, { id: 'u2', email: 'omar@example.org', password: 'official-pass' }],
    officials: [{ user_id: 'u1', name: 'Asha Admin', role: 'admin', created_at: '1' }, { user_id: 'u2', name: 'Omar Official', role: 'official', created_at: '2' }],
    audit: [], seq: 3
  };
  const tokens = { 'token-u1': 'u1', 'token-u2': 'u2' };
  const reply = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status });
  db.fetch = async (href, init) => {
    const url = new URL(href), body = init.body ? JSON.parse(init.body) : null, eq = key => url.searchParams.get(key)?.replace('eq.', '');
    assert.equal(init.headers.apikey, 'sb_secret_test'); // every call uses the service key
    if (url.pathname === '/auth/v1/user') { const id = tokens[init.headers.Authorization?.replace('Bearer ', '')]; return id ? reply(200, { id }) : reply(401, { msg: 'invalid JWT' }); }
    if (init.headers.Authorization) return reply(500, { msg: 'service key must not be sent as a bearer token' });
    if (url.pathname === '/auth/v1/admin/users' && init.method === 'GET') return reply(200, { users: db.users });
    if (url.pathname === '/auth/v1/admin/users' && init.method === 'POST') { const u = { id: `u${db.seq++}`, email: body.email, password: body.password }; db.users.push(u); return reply(200, u); }
    const userId = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/)?.[1];
    if (userId && init.method === 'PUT') { db.users.find(u => u.id === userId).password = body.password; return reply(200, {}); }
    if (userId && init.method === 'DELETE') { db.users = db.users.filter(u => u.id !== userId); db.officials = db.officials.filter(o => o.user_id !== userId); return reply(200, {}); }
    if (url.pathname === '/rest/v1/officials' && init.method === 'GET') return reply(200, eq('user_id') ? db.officials.filter(o => o.user_id === eq('user_id')) : db.officials);
    if (url.pathname === '/rest/v1/officials' && init.method === 'POST') { db.officials = db.officials.filter(o => o.user_id !== body.user_id).concat({ ...body, created_at: String(db.seq) }); return reply(201); }
    if (url.pathname === '/rest/v1/officials' && init.method === 'PATCH') { Object.assign(db.officials.find(o => o.user_id === eq('user_id')), body); return reply(204); }
    if (url.pathname === '/rest/v1/audit_log') { db.audit.push(body); return reply(201); }
    return reply(404, { message: 'not mocked' });
  };
  return db;
}

test('officials function: admins manage officials; everyone else is refused; no self lock-out', async () => {
  const db = fakeSupabase();
  const call = async (token, body, method = 'POST') => {
    const res = await handle(new Request('https://x/functions/v1/officials', { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body: method === 'POST' ? JSON.stringify(body) : undefined }), { url: 'https://example.supabase.co', key: 'sb_secret_test' }, db.fetch);
    return { status: res.status, body: res.status === 204 ? null : await res.json(), cors: res.headers.get('Access-Control-Allow-Origin') };
  };

  assert.equal((await call(null, null, 'OPTIONS')).status, 204, 'CORS preflight');
  assert.equal((await call(null, { action: 'list' })).status, 401);
  assert.equal((await call('forged', { action: 'list' })).status, 401);
  const refused = await call('token-u2', { action: 'list' });
  assert.equal(refused.status, 403); assert.match(refused.body.message, /Only an event admin/); assert.equal(refused.cors, '*');

  let res = await call('token-u1', { action: 'list' });
  assert.deepEqual(res.body.officials.map(o => `${o.email}:${o.role}:${o.you}`), ['asha@example.org:admin:true', 'omar@example.org:official:false']);
  assert.equal(res.body.officials[0].lastSignIn, '2026-09-30T10:00:00Z');

  // Add a new person: an account is created with a generated password, shown once.
  res = await call('token-u1', { action: 'add', email: ' Priya@Example.org ', name: 'Priya Desk', role: 'official' });
  assert.equal(res.status, 200); assert.equal(res.body.official.email, 'priya@example.org'); assert.ok(res.body.password.length >= 10);
  const priya = db.users.find(u => u.email === 'priya@example.org'); assert.equal(priya.password, res.body.password);
  assert.deepEqual(db.officials.find(o => o.user_id === priya.id), { user_id: priya.id, name: 'Priya Desk', role: 'official', boards: [], created_at: '4' });

  // Adding an existing account keeps its password unless a new one is given.
  res = await call('token-u1', { action: 'add', email: 'omar@example.org', name: 'Omar O.', role: 'admin' });
  assert.equal(res.body.password, null); assert.equal(db.users.find(u => u.id === 'u2').password, 'official-pass'); assert.equal(db.officials.find(o => o.user_id === 'u2').role, 'admin');

  for (const [body, message] of [[{ action: 'add', email: 'bad', name: 'X', role: 'official' }, /valid email/], [{ action: 'add', email: 'x@y.org', name: ' ', role: 'official' }, /name/], [{ action: 'add', email: 'x@y.org', name: 'X', role: 'owner' }, /Choose a role/], [{ action: 'add', email: 'x@y.org', name: 'X', role: 'umpire' }, /umpire’s boards/], [{ action: 'add', email: 'x@y.org', name: 'X', role: 'umpire', boards: [5] }, /umpire’s boards/], [{ action: 'add', email: 'x@y.org', name: 'X', role: 'official', password: 'short' }, /8 characters/], [{ action: 'nope' }, /Unknown action/]]) {
    res = await call('token-u1', body); assert.equal(res.status, 400); assert.match(res.body.message, message);
  }

  res = await call('token-u1', { action: 'update', id: priya.id, role: 'admin', name: 'Priya D' });
  assert.equal(res.status, 200); assert.deepEqual({ ...db.officials.find(o => o.user_id === priya.id), created_at: undefined }, { user_id: priya.id, name: 'Priya D', role: 'admin', boards: [], created_at: undefined });
  // An umpire runs the boards chosen for them; changing their role clears the boards.
  res = await call('token-u1', { action: 'update', id: priya.id, role: 'umpire', boards: [3, '1', 3] });
  assert.equal(res.status, 200); assert.deepEqual(db.officials.find(o => o.user_id === priya.id).boards, [1, 3]);
  res = await call('token-u1', { action: 'list' }); assert.deepEqual(res.body.officials.find(o => o.id === priya.id).boards, [1, 3]);
  res = await call('token-u1', { action: 'update', id: priya.id, name: 'Priya Umpire' }); assert.deepEqual(db.officials.find(o => o.user_id === priya.id).boards, [1, 3], 'a new name keeps the boards');
  res = await call('token-u1', { action: 'update', id: priya.id, role: 'lunch', boards: [2] }); assert.deepEqual(db.officials.find(o => o.user_id === priya.id).boards, []);
  res = await call('token-u1', { action: 'add', email: 'uma@example.org', name: 'Uma', role: 'umpire', boards: [2] });
  assert.equal(res.status, 200); assert.deepEqual(res.body.official.boards, [2]); assert.equal(db.officials.find(o => o.user_id === res.body.official.id).role, 'umpire');
  res = await call('token-u1', { action: 'update', id: 'u1', role: 'official' }); assert.equal(res.status, 400); assert.match(res.body.message, /own admin role/);

  res = await call('token-u1', { action: 'reset-password', id: priya.id });
  assert.equal(db.users.find(u => u.id === priya.id).password, res.body.password);
  res = await call('token-u1', { action: 'reset-password', id: priya.id, password: 'chosen-pass-1' }); assert.equal(res.body.password, 'chosen-pass-1');

  res = await call('token-u1', { action: 'remove', id: 'u1' }); assert.equal(res.status, 400); assert.match(res.body.message, /remove yourself/);
  res = await call('token-u1', { action: 'remove', id: priya.id });
  assert.equal(res.status, 200); assert.ok(!db.users.some(u => u.id === priya.id)); assert.ok(!db.officials.some(o => o.user_id === priya.id));
  res = await call('token-u1', { action: 'remove', id: priya.id }); assert.equal(res.status, 404);

  assert.deepEqual(db.audit.map(a => `${a.actor_name}:${a.action}`), ['Asha Admin:officials:add', 'Asha Admin:officials:add', 'Asha Admin:officials:update', 'Asha Admin:officials:update', 'Asha Admin:officials:update', 'Asha Admin:officials:update', 'Asha Admin:officials:add', 'Asha Admin:officials:reset-password', 'Asha Admin:officials:reset-password', 'Asha Admin:officials:remove']);
  assert.ok(!JSON.stringify(db.audit).includes('chosen-pass-1'), 'passwords never reach the audit log');
});


test('officials function creates media managers with mandatory assigned boards', async () => {
  const db = fakeSupabase();
  const call = async body => {
    const res = await handle(new Request('https://x/functions/v1/officials', { method: 'POST', headers: { Authorization: 'Bearer token-u1' }, body: JSON.stringify(body) }), { url: 'https://example.supabase.co', key: 'sb_secret_test' }, db.fetch);
    return { status: res.status, body: await res.json() };
  };
  for (const boards of [[], [0], [5]]) assert.equal((await call({ action: 'add', email: 'media@example.org', name: 'Media', role: 'media', boards })).status, 400);
  const added = await call({ action: 'add', email: 'media@example.org', name: 'Media', role: 'media', boards: [3, '1', 3] });
  assert.equal(added.status, 200); assert.deepEqual(added.body.official.boards, [1, 3]);
  const id = added.body.official.id;
  assert.equal((await call({ action: 'update', id, role: 'media', boards: [] })).status, 400);
  assert.equal((await call({ action: 'update', id, name: 'Media Manager' })).status, 200);
  assert.deepEqual(db.officials.find(o => o.user_id === id).boards, [1, 3]);
  await call({ action: 'update', id, role: 'official' });
  assert.deepEqual(db.officials.find(o => o.user_id === id).boards, []);
});
