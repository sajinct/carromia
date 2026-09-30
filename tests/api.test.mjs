import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centre, player, photo } from './registration-fixture.mjs';

async function serve(t, port, env = {}) {
  const data = mkdtempSync(join(tmpdir(), 'carromia-test-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PASSWORD: 'test-password', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); rmSync(data, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  const base = `http://localhost:${port}`;
  const post = (path, body, cookie = '') => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const login = async () => (await post('login', { password: 'test-password' })).headers.get('set-cookie').split(';')[0];
  // The registration deadline is removed so these tests pass on any date.
  assert.equal((await post('settings', { gamesPerMatch: 3, gameMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '' }, await login())).status, 200);
  return { base, data, post, login };
}
// A team from the i-th parish or centre of the diocese register, with ID proofs and photos.
const entry = i => ({ name: `Team ${i}`, ...centre(i), adults: true, players: [player('Player One', '9111111111'), player('Player Two', '9222222222')] });

test('API protects the desk, persists registration, produces QR, and omits private data publicly', async t => {
  const { base, data, post } = await serve(t, 3097);
  assert.equal((await post('draw', {})).status, 401);
  assert.equal((await post('register', { ...entry(1), name: 'Minors', adults: false })).status, 400, 'the 18+ confirmation is required');
  assert.equal((await post('register', { ...entry(1), players: [player('A', '9111111111'), player('B', '9222222222', false)] })).status, 400, 'both photos are required');
  assert.equal((await post('register', { ...entry(1), parish: 'Not In The Register' })).status, 400, 'the parish comes from the register');
  const reg = await post('register', { ...entry(1), name: 'Test Team', lunch: 2 });
  assert.equal(reg.status, 201); const { team } = await reg.json(); assert.equal(team.id, 'CAR-001');
  const publicState = await (await fetch(`${base}/api/state`)).json(); assert.equal(publicState.teams[0].players[0].mobile, undefined); assert.equal(publicState.teams[0].players[0].idLast4, undefined); assert.equal(publicState.teams[0].checkinToken, undefined);
  assert.equal(publicState.teams[0].forane, centre(1).forane);
  // Photos are files kept apart from the event, and only the desk can see them.
  assert.ok(!readFileSync(join(data, 'tournament.json'), 'utf8').includes('base64')); assert.ok(existsSync(join(data, 'photos', 'CAR-001.json')));
  const [full] = JSON.parse(readFileSync(join(data, 'photos', 'CAR-001.json'), 'utf8'));
  assert.match(full, /^main\/[0-9a-f-]{36}\/player-1\.jpg$/); assert.ok(existsSync(join(data, 'uploads', 'team-files', full))); assert.ok(existsSync(join(data, 'uploads', 'team-files', full.replace('.jpg', '-thumb.jpg'))));
  assert.equal((await fetch(`${base}/api/photos`)).status, 401);
  assert.equal((await fetch(`${base}/api/files/team-files/${full}`)).status, 401);
  const qr = await (await fetch(`${base}/api/qr?token=${team.checkinToken}`)).json(); assert.match(qr.qr, /^data:image\/png;base64,/);
  const results = await (await fetch(`${base}/api/link-qr?route=/results`)).json(); assert.match(results.qr, /^data:image\/png;base64,/); assert.match(results.url, /\/results$/);
  assert.equal((await fetch(`${base}/api/link-qr?route=/admin`)).status, 404, 'only public pages get a QR code');
  assert.equal(JSON.parse(readFileSync(join(data, 'tournament.json'), 'utf8')).teams.length, 1);
  const login = await post('login', { password: 'test-password' }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('checkin', { token: team.checkinToken }, cookie)).status, 200);
  const adminState = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json(); assert.equal(adminState.teams[0].checkedIn, true); assert.equal(adminState.teams[0].players[0].mobile, '9111111111'); assert.equal(adminState.teams[0].lunch, 2);
  assert.equal(adminState.teams[0].players[0].idType, 'Aadhaar'); assert.equal(adminState.teams[0].checkinToken, team.checkinToken, 'the desk can print a team’s form again');
  const thumbs = (await (await fetch(`${base}/api/photos`, { headers: { Cookie: cookie } })).json())['CAR-001'];
  assert.deepEqual(thumbs, [1, 2].map(n => `/api/files/team-files/${full.replace('player-1.jpg', `player-${n}-thumb.jpg`)}`), 'lists get thumbnails');
  const picture = await fetch(base + thumbs[0], { headers: { Cookie: cookie } });
  assert.equal(picture.headers.get('content-type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await picture.arrayBuffer()), Buffer.from(photo.split(',')[1], 'base64'));
  assert.deepEqual(await (await fetch(`${base}/api/photo-full?team=CAR-001&player=0`, { headers: { Cookie: cookie } })).json(), { url: `/api/files/team-files/${full}` });
  assert.equal((await fetch(`${base}/api/files/team-files/../tournament.json`, { headers: { Cookie: cookie } })).status, 404, 'only team files can be read');
  assert.deepEqual(adminState.registration, { open: true, reason: '', slotsLeft: 63, maxTeams: 64 }); assert.equal(adminState.event.entryFee, 500);
  assert.equal((await post('change-password', { current: 'test-password', password: 'another-password' }, cookie)).status, 400, 'the shared desk password is not changed from the app');
  assert.equal((await fetch(`${base}/api/backup`)).status, 401);
  const backup = await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).json(); assert.equal(backup.teams[0].checkinToken, team.checkinToken);
});
test('registration is rate limited per connection', async t => {
  const { post } = await serve(t, 3098);
  assert.equal((await post('register', entry(0))).status, 201);
  for (let i = 1; i <= 29; i++) assert.equal((await post('register', entry(i))).status, 201);
  assert.equal((await post('register', entry(31))).status, 429);
});
test('payment at registration: pending until an official confirms it; the form needs the primary mobile', async t => {
  const { base, data, post, login } = await serve(t, 3102); const cookie = await login(), qr = photo.replace('jpeg', 'png');
  assert.equal((await post('settings', { gamesPerMatch: 3, gameMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '', paymentRequired: true, upiQr: qr, contacts: [{ name: 'Fr. Joseph', phone: '9876543210' }] }, cookie)).status, 200);
  const before = await (await fetch(`${base}/api/state`)).json(); assert.equal(before.event.upiQr, qr, 'a QR code saved in the event still works'); assert.deepEqual(before.event.contacts, [{ name: 'Fr. Joseph', phone: '9876543210' }]);
  // The QR code is uploaded as a public file and the settings keep its address.
  assert.equal((await post('upi-qr', { image: qr })).status, 401);
  assert.equal((await post('upi-qr', { image: photo }, cookie)).status, 400, 'the QR code is a PNG');
  const { url } = await (await post('upi-qr', { image: qr }, cookie)).json(); assert.match(url, /^\/api\/assets\/main\/upi-qr-[0-9a-f-]{36}\.png$/);
  const asset = await fetch(base + url); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal((await post('settings', { gamesPerMatch: 3, gameMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadline: '', paymentRequired: true, upiQr: url }, cookie)).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).event.upiQr, url);
  assert.equal((await post('register', entry(1))).status, 400, 'a UTR or a screenshot is needed');
  const reg = await post('register', { ...entry(1), payment: { txnRef: '412356789012', screenshot: photo } });
  assert.equal(reg.status, 201); const { team } = await reg.json(); assert.equal(team.status, 'pending');
  const after = await (await fetch(`${base}/api/state`)).json(); assert.equal(after.teams[0].payment, undefined, 'the UTR is not public');
  const shot = JSON.parse(readFileSync(join(data, 'payments', 'CAR-001.json'), 'utf8')); assert.match(shot, /\/payment\.jpg$/);
  assert.equal((await fetch(`${base}/api/payment-proofs`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/payment-proofs`, { headers: { Cookie: cookie } })).json(), { 'CAR-001': `/api/files/team-files/${shot}` });
  const form = (id, mobile) => post('team-form', { id, mobile });
  assert.match((await (await form('CAR-001', '9111111111')).json()).error, /still being verified/);
  assert.equal((await post('checkin', { id: 'CAR-001' }, cookie)).status, 400, 'pending teams can’t check in');
  assert.equal((await post('confirm-payment', { id: 'CAR-001' }, cookie)).status, 200);
  assert.match((await (await form('CAR-001', '9222222222')).json()).error, /doesn’t match/, 'only the primary player’s number opens the form');
  const ok = await (await form('car-001', '+91 91111 11111')).json();
  assert.equal(ok.team.id, 'CAR-001'); assert.equal(ok.team.status, 'confirmed'); assert.equal(ok.team.players[0].idLast4, '1234'); assert.equal(ok.team.checkinToken, undefined);
  assert.match(ok.qr, /^data:image\/png;base64,/); assert.deepEqual(ok.photos, [photo, photo]);
  for (let i = 0; i < 7; i++) await form('CAR-001', '9000000000');
  assert.equal((await form('CAR-001', '9111111111')).status, 429, 'wrong numbers are rate limited');
});
test('removing a team or starting a fresh event deletes player photos', async t => {
  const { base, data, post, login } = await serve(t, 3101); const cookie = await login();
  for (const i of [1, 2]) assert.equal((await post('register', entry(i))).status, 201);
  const [first] = JSON.parse(readFileSync(join(data, 'photos', 'CAR-001.json'), 'utf8'));
  assert.equal((await post('remove-team', { id: 'CAR-001' }, cookie)).status, 200);
  assert.deepEqual(Object.keys(await (await fetch(`${base}/api/photos`, { headers: { Cookie: cookie } })).json()), ['CAR-002']);
  assert.ok(!existsSync(join(data, 'uploads', 'team-files', first)), 'the removed team’s files are deleted');
  assert.equal((await post('reset', { confirm: 'RESET' }, cookie)).status, 200);
  assert.ok(!existsSync(join(data, 'photos'))); assert.ok(!existsSync(join(data, 'uploads', 'team-files')));
});
test('loading the sample tournament keeps event details and timings', async t => {
  const { base, post, login } = await serve(t, 3099); const cookie = await login();
  assert.equal((await post('settings', { name: 'Parish Cup', year: '2027', venue: 'Hall B', date: '2027-01-10', gameMinutes: 12, resetMinutes: 3, restMinutes: 5, registrationOpen: true }, cookie)).status, 200);
  assert.equal((await post('demo', {}, cookie)).status, 200);
  const state = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json();
  assert.equal(state.teams.length, 16); assert.equal(state.event.name, 'Parish Cup'); assert.equal(state.event.venue, 'Hall B'); assert.equal(state.event.gameMinutes, 12); assert.equal(state.event.registrationOpen, false);
});
test('live connections are capped', async t => {
  const { base } = await serve(t, 3100, { MAX_STREAMS: '1' }); const controller = new AbortController(); t.after(() => controller.abort());
  assert.equal((await fetch(`${base}/api/events`, { signal: controller.signal })).status, 200);
  assert.equal((await fetch(`${base}/api/events`)).status, 503);
});
