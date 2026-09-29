import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('API protects the desk, persists registration, produces QR, and omits private data publicly', async t => {
  const data = mkdtempSync(join(tmpdir(), 'carromia-test-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: '3097', DATA_DIR: data, ADMIN_PASSWORD: 'test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); rmSync(data, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  const base = 'http://localhost:3097';
  const post = (path, body, cookie = '') => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await post('draw', {})).status, 401);
  const reg = await post('register', { name: 'Test Team', parish: 'Test Parish', players: [{ name: 'Player One', mobile: '9111111111' }, { name: 'Player Two', mobile: '9222222222' }] });
  assert.equal(reg.status, 201); const { team } = await reg.json(); assert.equal(team.id, 'CAR-001');
  const publicState = await (await fetch(`${base}/api/state`)).json(); assert.equal(publicState.teams[0].players[0].mobile, undefined); assert.equal(publicState.teams[0].checkinToken, undefined);
  const qr = await (await fetch(`${base}/api/qr?token=${team.checkinToken}`)).json(); assert.match(qr.qr, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(readFileSync(join(data, 'tournament.json'), 'utf8')).teams.length, 1);
  const login = await post('login', { password: 'test-password' }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('checkin', { token: team.checkinToken }, cookie)).status, 200);
  const adminState = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json(); assert.equal(adminState.teams[0].checkedIn, true); assert.equal(adminState.teams[0].players[0].mobile, '9111111111');
  assert.equal((await fetch(`${base}/api/backup`)).status, 401);
  const backup = await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).json(); assert.equal(backup.teams[0].checkinToken, team.checkinToken);
});
