import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function serve(t, port, env = {}) {
  const data = mkdtempSync(join(tmpdir(), 'carromia-test-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PASSWORD: 'test-password', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); rmSync(data, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  const base = `http://localhost:${port}`;
  const post = (path, body, cookie = '') => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const login = async () => (await post('login', { password: 'test-password' })).headers.get('set-cookie').split(';')[0];
  // The registration deadline is removed so these tests pass on any date.
  assert.equal((await post('settings', { durationMinutes: 30, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '' }, await login())).status, 200);
  return { base, data, post, login };
}
const entry = i => ({ name: `Team ${i}`, parish: `Parish ${i}`, adults: true, players: [{ name: 'Player One', mobile: '9111111111' }, { name: 'Player Two', mobile: '9222222222' }] });

test('API protects the desk, persists registration, produces QR, and omits private data publicly', async t => {
  const { base, data, post } = await serve(t, 3097);
  assert.equal((await post('draw', {})).status, 401);
  assert.equal((await post('register', { name: 'Minors', parish: 'Test Parish', players: entry(1).players })).status, 400, 'the 18+ confirmation is required');
  const reg = await post('register', { name: 'Test Team', parish: 'Test Parish', lunch: 2, adults: true, players: [{ name: 'Player One', mobile: '9111111111' }, { name: 'Player Two', mobile: '9222222222' }] });
  assert.equal(reg.status, 201); const { team } = await reg.json(); assert.equal(team.id, 'CAR-001');
  const publicState = await (await fetch(`${base}/api/state`)).json(); assert.equal(publicState.teams[0].players[0].mobile, undefined); assert.equal(publicState.teams[0].checkinToken, undefined);
  const qr = await (await fetch(`${base}/api/qr?token=${team.checkinToken}`)).json(); assert.match(qr.qr, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(readFileSync(join(data, 'tournament.json'), 'utf8')).teams.length, 1);
  const login = await post('login', { password: 'test-password' }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('checkin', { token: team.checkinToken }, cookie)).status, 200);
  const adminState = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json(); assert.equal(adminState.teams[0].checkedIn, true); assert.equal(adminState.teams[0].players[0].mobile, '9111111111'); assert.equal(adminState.teams[0].lunch, 2);
  assert.deepEqual(adminState.registration, { open: true, reason: '', slotsLeft: 63, maxTeams: 64 }); assert.equal(adminState.event.entryFee, 500);
  assert.equal((await post('change-password', { current: 'test-password', password: 'another-password' }, cookie)).status, 400, 'the shared desk password is not changed from the app');
  assert.equal((await fetch(`${base}/api/backup`)).status, 401);
  const backup = await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).json(); assert.equal(backup.teams[0].checkinToken, team.checkinToken);
});
test('registration is rate limited per connection', async t => {
  const { post } = await serve(t, 3098);
  assert.equal((await post('register', { ...entry(0), parish: 'parish 1.' })).status, 201);
  for (let i = 1; i <= 29; i++) assert.equal((await post('register', entry(i))).status, 201);
  assert.equal((await post('register', entry(31))).status, 429);
});
test('loading the sample tournament keeps event details and timings', async t => {
  const { base, post, login } = await serve(t, 3099); const cookie = await login();
  assert.equal((await post('settings', { name: 'Parish Cup', year: '2027', venue: 'Hall B', date: '2027-01-10', durationMinutes: 12, resetMinutes: 3, restMinutes: 5, registrationOpen: true }, cookie)).status, 200);
  assert.equal((await post('demo', {}, cookie)).status, 200);
  const state = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json();
  assert.equal(state.teams.length, 16); assert.equal(state.event.name, 'Parish Cup'); assert.equal(state.event.venue, 'Hall B'); assert.equal(state.event.durationMinutes, 12); assert.equal(state.event.registrationOpen, false);
});
test('live connections are capped', async t => {
  const { base } = await serve(t, 3100, { MAX_STREAMS: '1' }); const controller = new AbortController(); t.after(() => controller.abort());
  assert.equal((await fetch(`${base}/api/events`, { signal: controller.signal })).status, 200);
  assert.equal((await fetch(`${base}/api/events`)).status, 503);
});
