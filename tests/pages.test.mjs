import test from 'node:test';
import QRCode from 'qrcode';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo, publicState, addTeams, teamForm, groupForm, thumbPath } from '../lib/tournament.mjs';
import { centre, player, photo } from './registration-fixture.mjs';
const root = join(import.meta.dirname, '..');
// The registration Edge Function runs against the same stand-in, with the service key.
const functionSource = readFileSync(join(root, 'supabase', 'functions', 'registration', 'index.ts'), 'utf8');
const { handle: registrationFunction } = await import(`data:text/javascript,${encodeURIComponent(functionSource)}`);
const SUPABASE = 'https://vzxcqpgwvknonkhjinuk.supabase.co', PUBLISHABLE = 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro', SERVICE = 'sb_secret_test';
test('Pages build is portable to a repository subpath and contains only static assets', async () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: root });
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  assert.ok(html.includes('src="./app.js"')); assert.ok(!/(href|src)="\//.test(html));
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, 'dist', icon.src)));
  assert.ok(!readFileSync(join(root, 'dist/tournament-browser.js'), 'utf8').includes('node:crypto'));
  assert.ok(!readdirSync(join(root, 'dist')).includes('data'));
  const { default: browserQr } = await import('../dist/vendor/qrcode.js');
  for (const amount of ['300.00', '900.00', '1250.50']) {
    const uri = `upi://pay?pa=parish@okaxis&pn=CARROMIA2026&am=${amount}&cu=INR`;
    assert.deepEqual(browserQr.create(uri).modules.data, QRCode.create(uri).modules.data, 'the packaged browser encoder preserves the exact payment payload');
  }
  assert.ok(!readFileSync(join(root, 'dist/runtime.js'), 'utf8').includes('cdn.jsdelivr.net/npm/qrcode'), 'QR generation uses the local asset');
});
// An in-memory stand-in for the Supabase endpoints the live site calls, including the database rules.
function fakeSupabase() {
  // The registration deadline is removed so this test passes on any date.
  const sample = seedDemo(); sample.event.registrationDeadline = '';
  const db = { rows: { main: { version: 1, state: sample } }, pub: { main: { version: 1, state: publicState(sample) } }, saves: [], photos: [], proofs: [], files: new Map(), raceOnce: false };
  Object.defineProperty(db, 'public', { get: () => db.pub.main });
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass', official: { name: 'Asha Admin', role: 'admin', boards: [] } }, 'omar@example.org': { id: 'u2', password: 'official-pass', official: { name: 'Omar Official', role: 'official', boards: [] } },
    'cara@example.org': { id: 'u4', password: 'checkin-pass', official: { name: 'Cara Checkin', role: 'checkin', boards: [] } }, 'lena@example.org': { id: 'u5', password: 'lunch-pass', official: { name: 'Lena Lunch', role: 'lunch', boards: [] } }, 'uma@example.org': { id: 'u6', password: 'umpire-pass', official: { name: 'Uma Umpire', role: 'umpire', boards: [1] } } };
  db.users = users;
  const byToken = token => Object.values(users).find(u => `token-${u.id}` === token);
  const reply = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  db.fetch = async (href, init = {}) => {
    const url = new URL(href), json = /json/.test(init.headers?.['Content-Type'] || 'json'), body = init.body && json ? JSON.parse(init.body) : null, caller = byToken(init.headers?.Authorization?.replace('Bearer ', ''));
    const id = url.searchParams.get('id')?.replace('eq.', ''), eq = key => url.searchParams.get(key)?.replace('eq.', '');
    assert.ok([PUBLISHABLE, SERVICE].includes(init.headers.apikey)); const service = init.headers.apikey === SERVICE;
    if (url.pathname === '/functions/v1/registration') return registrationFunction(new Request(href, init), { url: SUPABASE, key: SERVICE }, db.fetch);
    // Storage: team files only through the service key or an official's signed links; the UPI QR
    // code uploaded by an admin (any official in practice).
    const object = /^\/storage\/v1\/object\/(team-files|event-assets)\/(.+)$/.exec(url.pathname);
    if (object && init.method === 'POST') {
      const [, bucket, name] = object, role = caller?.official.role;
      if (!(service || (bucket === 'event-assets' && (role === 'admin' || (role && name.startsWith('practice/')))))) return reply(403, { message: 'new row violates row-level security policy' });
      db.files.set(`${bucket}/${name}`, { bytes: init.body, type: init.headers['Content-Type'] }); return reply(200, { Key: name });
    }
    if (url.pathname === '/storage/v1/object/sign/team-files') {
      if (!service && !caller) return reply(400, { message: 'Object not found' });
      return reply(200, body.paths.map(path => ({ path, signedURL: db.files.has(`team-files/${path}`) ? `/object/sign/team-files/${path}?token=signed` : null, error: null })));
    }
    if (/^\/storage\/v1\/object\/[\w-]+$/.test(url.pathname) && init.method === 'DELETE') { if (!service) return reply(403, {}); for (const name of body.prefixes) db.files.delete(`${url.pathname.split('/').pop()}/${name}`); return reply(200, []); }
    if (['/rest/v1/rpc/register_teams', '/rest/v1/rpc/team_form', '/rest/v1/rpc/group_form', '/rest/v1/rpc/unreferenced_files'].includes(url.pathname) && !service) return reply(404, { message: 'Could not find the function in the schema cache' });
    switch (url.pathname) {
      case '/rest/v1/rpc/server_time': return reply(200, Date.now());
      case '/rest/v1/tournament_public': {
        // The screens' version check asks for its event and the real one: id=in.(main,practice).
        const ids = [...new Set(/^in\.\((.*)\)$/.exec(url.searchParams.get('id'))?.[1].split(',') ?? [id])];
        return reply(200, ids.filter(i => db.pub[i]).map(i => ({ id: i, ...structuredClone(db.pub[i]), practiceOff: db.pub[i].state.event?.practiceOff ?? null })));
      }
      // Only once the Realtime migrations are run (db.announces).
      case '/rest/v1/rpc/tournament_versions':
        if (!db.announces) return reply(404, { message: 'Could not find the function public.tournament_versions in the schema cache' });
        return reply(200, body.p_ids.filter(i => db.pub[i]).map(i => ({ id: i, version: db.pub[i].version, practiceOff: db.pub[i].state.event?.practiceOff ?? false, announced: true })));
      case '/rest/v1/tournament': return reply(200, caller?.official && db.rows[id] ? [structuredClone(db.rows[id])] : []);
      case '/rest/v1/officials': { const who = service ? Object.values(users).find(u => u.id === eq('user_id')) : caller; return reply(200, who ? [who.official] : []); }
      case '/rest/v1/player_photos': return reply(200, ['admin', 'official', 'checkin'].includes(caller?.official.role) ? db.photos.filter(p => p.event === eq('event') && (!eq('team_id') || p.team_id === eq('team_id')) && (!eq('player') || p.player === Number(eq('player')))) : []);
      case '/rest/v1/payment_proofs': return reply(200, ['admin', 'official'].includes(caller?.official.role) ? db.proofs.filter(p => p.event === eq('event')) : []);
      case '/rest/v1/rpc/unreferenced_files': {
        const used = new Set([...db.photos.flatMap(p => [p.path, thumbPath(p.path)]), ...db.proofs.map(p => p.path)]);
        return reply(200, [...db.files.keys()].filter(k => k.startsWith('team-files/') && !used.has(k.slice(11))).map(k => ({ bucket: 'team-files', name: k.slice(11) })));
      }
      case '/auth/v1/token': { const u = users[body.email]; return u?.password === body.password ? reply(200, { access_token: `token-${u.id}`, refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: u.id } }) : reply(400, { error_description: 'Invalid login credentials' }); }
      case '/auth/v1/logout': return reply(204);
      case '/auth/v1/user': {
        if (!caller) return reply(401, { msg: 'Invalid token' });
        if (service) return reply(200, { id: caller.id });
        if (init.method === 'PUT') { if (body.password === caller.password) return reply(422, { msg: 'New password should be different from the old password.' }); caller.password = body.password; }
        return reply(200, { id: caller.id, email: Object.keys(users).find(email => users[email] === caller) });
      }
      case '/rest/v1/rpc/register_teams': {
        const main = db.rows[body.p_event ?? 'main'];
        if (main.state.demo) return reply(400, { message: 'Registration will open soon. Please check back.' });
        // The pictures are paths of files already uploaded, which must exist.
        const event = body.p_event ?? 'main', paths = body.p_teams.map(t => t.players.map(p => p.photo)), shot = body.p_payment?.screenshot;
        if (paths.flat().some(p => !p.startsWith(`${event}/`) || !db.files.has(`team-files/${p}`))) return reply(400, { message: 'Add a photo of each player (a JPEG under 4 MB).' });
        if (shot && !db.files.has(`team-files/${shot}`)) return reply(400, { message: 'Add the payment screenshot as a picture under 4 MB.' });
        try {
          const teams = addTeams(main.state, { forane: body.p_forane, parish: body.p_parish, centreType: body.p_centre_type, teams: body.p_teams, coordinator: body.p_coordinator, payment: body.p_payment && { ...body.p_payment, screenshot: shot ? photo : '' }, adults: body.p_adults });
          teams.forEach((team, j) => { paths[j].forEach((path, player) => db.photos.push({ event, team_id: team.id, player, path })); if (shot) db.proofs.push({ event, team_id: team.id, path: shot }); });
          main.version++; db.pub[event] = { version: main.version, state: publicState(main.state) }; return reply(200, { teams });
        }
        catch (error) { return reply(400, { message: error.message }); }
      }
      case '/rest/v1/rpc/group_form': {
        try { const teams = groupForm(db.rows[body.p_event].state, body.p_group_id, body.p_mobile); return reply(200, { teams: teams.map(team => ({ team, photos: db.photos.filter(p => p.event === body.p_event && p.team_id === team.id).map(p => p.path) })) }); }
        catch (error) { return /doesn’t match/.test(error.message) ? reply(200, { error: error.message }) : reply(400, { message: error.message }); }
      }
      case '/rest/v1/rpc/team_form': {
        try { const team = teamForm(db.rows[body.p_event].state, body.p_team_id, body.p_mobile); return reply(200, { team, photos: db.photos.filter(p => p.event === body.p_event && p.team_id === team.id).map(p => p.path) }); }
        catch (error) { return /doesn’t match/.test(error.message) ? reply(200, { error: error.message }) : reply(400, { message: error.message }); }
      }
      case '/rest/v1/rpc/save_tournament': {
        if (!caller?.official) return reply(403, { message: 'Sign in as a tournament official.' });
        const target = body.p_id ?? 'main', row = db.rows[target];
        if (db.raceOnce) { db.raceOnce = false; row.version++; row.state = { ...row.state, event: { ...row.state.event, venue: 'Changed elsewhere' } }; }
        if (body.p_expected !== (row?.version ?? 0)) return reply(409, { message: 'The event was changed from another session. Please try again.' });
        db.rows[target] = { version: (row?.version ?? 0) + 1, state: body.p_state };
        db.photos = db.photos.filter(p => p.event !== target || body.p_state.teams.some(t => t.id === p.team_id)); // drop_orphan_photos()
        db.pub[target] = { version: db.rows[target].version, state: body.p_public };
        db.saves.push({ by: caller.official.name, action: body.p_action, event: target }); return reply(200, db.rows[target].version);
      }
      default: return reply(404, { message: 'not mocked' });
    }
  };
  return db;
}

test('live Pages runtime: public view, official sign-in, roles, conflict retry, practice mode and team removal', async t => {
  const db = fakeSupabase(), memory = new Map(), realFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  globalThis.fetch = db.fetch; globalThis.location = { origin: 'https://sajinct.github.io', pathname: '/carromia/', search: '' };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; delete globalThis.location; });
  const { remoteApi, shareLink } = await import('../dist/runtime.js');
  const players = [player('Arun', '9111111111'), player('Joel', '9222222222')], adults = true, where = centre(0);

  let state = await remoteApi('state');
  assert.equal(state.isAdmin, false); assert.equal(state.demo, true); assert.equal(state.teams.length, 16); assert.equal(state.teams[0].players[0].mobile, undefined); assert.equal(state.practiceAvailable, false);
  await assert.rejects(remoteApi('register', { name: 'Real team', ...where, players, adults }), /open soon/);
  await assert.rejects(remoteApi('assign', { id: 'M05', board: 1 }), /Sign in/);
  await assert.rejects(remoteApi('login', { email: 'omar@example.org', password: 'wrong' }), /Incorrect email or password/);

  await remoteApi('login', { email: 'Omar@example.org ', password: 'official-pass' });
  state = await remoteApi('state');
  assert.equal(state.isAdmin, true); assert.deepEqual(state.user, { name: 'Omar Official', role: 'official', boards: [] }); assert.equal(state.teams[0].players[0].mobile, '9000000000'); assert.ok(state.teams[0].checkinToken, 'officials can print a team’s form again'); assert.equal(state.practice, false);
  await remoteApi('unassign', { id: 'M01' }); await remoteApi('assign', { id: 'M05', board: 1 }); await remoteApi('start', { id: 'M05' });
  assert.equal(db.rows.main.state.matches.find(m => m.id === 'M05').status, 'playing');
  assert.equal(db.public.state.matches.find(m => m.id === 'M05').status, 'playing'); assert.ok(!JSON.stringify(db.public).includes('9000000000'), 'public copy has no mobiles');
  await assert.rejects(remoteApi('reset', { confirm: 'RESET' }), /Only an event admin/);
  await assert.rejects(remoteApi('serve-lunch', { id: 'CAR-002' }), /Lunch coupons are turned off/);
  db.raceOnce = true; await remoteApi('checkin', { id: 'CAR-001', checkedIn: true });
  assert.equal(db.rows.main.state.event.venue, 'Changed elsewhere', 'the retry builds on the other official’s save');

  // An official changes their own password: the current one is checked and they stay signed in.
  await assert.rejects(remoteApi('change-password', { current: 'wrong', password: 'new-official-pass' }), /current password is incorrect/);
  await assert.rejects(remoteApi('change-password', { current: 'official-pass', password: 'short' }), /8 characters/);
  await assert.rejects(remoteApi('change-password', { current: 'official-pass', password: 'official-pass' }), /different/);
  await remoteApi('change-password', { current: 'official-pass', password: 'new-official-pass' });
  assert.equal((await remoteApi('state')).isAdmin, true);
  await remoteApi('logout');
  await assert.rejects(remoteApi('change-password', { current: 'new-official-pass', password: 'another-pass-1' }), /Sign in/);
  await assert.rejects(remoteApi('login', { email: 'omar@example.org', password: 'official-pass' }), /Incorrect email or password/);
  await remoteApi('login', { email: 'omar@example.org', password: 'new-official-pass' });
  await remoteApi('change-password', { current: 'new-official-pass', password: 'official-pass' });

  // The admin opens the real event for registration; the public registers.
  await remoteApi('logout'); await remoteApi('login', { email: 'asha@example.org', password: 'admin-pass' });
  await assert.rejects(remoteApi('reset', { confirm: 'nope' }), /Type RESET/);
  await remoteApi('reset', { confirm: 'RESET' });
  await assert.rejects(remoteApi('demo'), /practice mode/, 'sample teams never go into the real event');
  await remoteApi('logout');
  await assert.rejects(remoteApi('register', { name: 'Real Team', ...where, parish: 'Nowhere', players, adults }), /forane or zone/);
  await assert.rejects(remoteApi('register', { name: 'Real Team', ...where, players: [players[0], player('Joel', '9222222222', false)], adults }), /photo of each player/);
  const { team } = await remoteApi('register', { name: 'Real Team', ...where, players, lunch: 1, adults });
  assert.equal(team.id, 'CAR-001'); assert.equal(team.forane, where.forane); assert.equal(team.players[0].idLast4, '1234'); assert.equal((await remoteApi('state')).teams.length, 1);
  await assert.rejects(remoteApi('photos'), /Sign in/);
  // Anyone with the primary player's mobile number can download the team's form.
  await assert.rejects(remoteApi('team-form', { id: team.id, mobile: '9222222222' }), /doesn’t match/);
  const form = await remoteApi('team-form', { id: team.id, mobile: '9111111111' });
  assert.equal(form.team.id, team.id); assert.equal(form.team.checkinToken, undefined); assert.equal(typeof form.lunchQr, 'string', 'a team with lunch gets its lunch coupon QR code');
  const [photo1, photo2] = db.photos.filter(p => p.team_id === team.id).map(p => p.path);
  assert.deepEqual(form.photos, [photo1, photo2].map(p => `${SUPABASE}/storage/v1/object/sign/team-files/${thumbPath(p)}?token=signed`), 'the form gets short-lived links to the thumbnails');
  // Each photo and its thumbnail are files; the database holds only their paths.
  assert.match(photo1, /^main\/[0-9a-f-]{36}\/player-1\.jpg$/); assert.equal(db.files.size, 4); assert.equal(db.files.get(`team-files/${photo1}`).type, 'image/jpeg');
  assert.deepEqual(Buffer.from(db.files.get(`team-files/${photo1}`).bytes), Buffer.from(photo.split(',')[1], 'base64'));
  // Browsers can't register (or upload) without the Edge Function.
  assert.equal((await db.fetch(`${SUPABASE}/rest/v1/rpc/register_teams`, { method: 'POST', headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  // Practice mode: a separate sample event; the real event and the public copy are untouched.
  await remoteApi('login', { email: 'omar@example.org', password: 'official-pass' });
  assert.deepEqual(await remoteApi('photos'), { 'CAR-001': [photo1, photo2].map(p => `${SUPABASE}/storage/v1/object/sign/team-files/${thumbPath(p)}?token=signed`) });
  assert.deepEqual(await remoteApi('photo-full?team=CAR-001&player=1'), { url: `${SUPABASE}/storage/v1/object/sign/team-files/${photo2}?token=signed` });
  await assert.rejects(remoteApi('upi-qr', { image: photo.replace('jpeg', 'png') }), /Only an event admin/, 'the real event’s QR code is for admins');
  const publicBefore = JSON.stringify(db.public);
  await remoteApi('practice', { on: true });
  state = await remoteApi('state');
  assert.equal(state.practice, true); assert.equal(state.teams.length, 16); assert.equal(state.event.venue, 'Changed elsewhere', 'practice uses the real event details');
  await remoteApi('unassign', { id: 'M01' }); await remoteApi('assign', { id: 'M05', board: 1 });
  assert.equal(db.rows.practice.state.matches.find(m => m.id === 'M05').status, 'called');
  assert.ok(!JSON.stringify(db.pub.practice).includes('9000000000'), 'the practice public copy has no mobiles');
  await remoteApi('reset', { confirm: 'RESET' });
  assert.equal(db.rows.practice.state.teams.length, 0); assert.equal(db.rows.practice.state.practice, true); assert.equal(db.rows.practice.state.event.registrationOpen, true, 'an empty practice opens registration');
  assert.equal(JSON.stringify(db.public), publicBefore, 'practice never changes the real public copy'); assert.equal(db.rows.main.state.teams.length, 1);
  // A TV or phone that is not signed in follows practice after opening a practice link.
  await remoteApi('logout');
  state = await remoteApi('state'); assert.equal(state.practice, true); assert.equal(state.isAdmin, false); assert.equal(state.teams.length, 0); assert.equal(state.practiceLinks.live, 'https://sajinct.github.io/carromia/?practice=1#/live');
  assert.equal(shareLink('/results'), 'https://sajinct.github.io/carromia/?practice=1#/results', 'a practice screen’s results QR opens practice results');
  const { team: practiceTeam } = await remoteApi('register', { name: 'Practice Pair', ...where, players, adults });
  assert.equal(practiceTeam.id, 'CAR-001'); assert.equal(db.rows.practice.state.teams.length, 1); assert.equal(db.rows.main.state.teams.length, 1, 'practice registrations stay out of the real event');
  assert.equal((await remoteApi('state')).teams[0].players[0].mobile, undefined);
  await remoteApi('demo').catch(() => {}); await remoteApi('login', { email: 'omar@example.org', password: 'official-pass' });
  await remoteApi('demo'); assert.equal(db.rows.practice.state.teams.length, 16, 'officials can reload the sample in practice');
  await remoteApi('practice', { on: false }); state = await remoteApi('state'); assert.equal(state.practice, false); assert.equal(state.teams.length, 1);
  assert.equal(shareLink('/results'), 'https://sajinct.github.io/carromia/#/results'); assert.throws(() => shareLink('/admin'), /Page not found/);

  // An admin can turn practice mode off for every device; a device still in it goes back to the real event.
  await remoteApi('practice', { on: true }); await assert.rejects(remoteApi('practice-mode', { on: false }), /Leave practice mode/);
  await remoteApi('practice', { on: false }); await assert.rejects(remoteApi('practice-mode', { on: false }), /Only an event admin/);
  await remoteApi('logout'); await remoteApi('login', { email: 'asha@example.org', password: 'admin-pass' });
  await remoteApi('practice-mode', { on: false }); assert.equal(db.public.state.event.practiceOff, true);
  // The admin uploads the UPI QR code; it is a public file and the event keeps its address.
  const { url: qrUrl } = await remoteApi('upi-qr', { image: photo.replace('jpeg', 'png') });
  assert.match(qrUrl, /^https:\/\/vzxcqpgwvknonkhjinuk\.supabase\.co\/storage\/v1\/object\/public\/event-assets\/main\/upi-qr-[0-9a-f-]{36}\.png$/);
  assert.equal(db.files.get(`event-assets/${qrUrl.split('event-assets/')[1]}`).type, 'image/png');
  await assert.rejects(remoteApi('upi-qr', { image: photo }), /PNG or JPEG/);
  memory.set('carromia-practice', 'on');
  state = await remoteApi('state'); assert.deepEqual([state.practice, state.practiceAvailable, memory.has('carromia-practice')], [false, false, false]);
  await assert.rejects(remoteApi('practice', { on: true }), /turned off by the event admin/);
  await remoteApi('practice-mode', { on: true }); assert.equal((await remoteApi('state')).practiceAvailable, true);
  await remoteApi('logout'); await remoteApi('login', { email: 'omar@example.org', password: 'official-pass' });

  // Team removal: admin only, real event before the draw.
  await assert.rejects(remoteApi('remove-team', { id: 'CAR-001' }), /Only an event admin/);
  await remoteApi('logout'); await remoteApi('login', { email: 'asha@example.org', password: 'admin-pass' });
  await remoteApi('remove-team', { id: 'CAR-001' });
  assert.equal((await remoteApi('state')).teams.length, 0); assert.equal(db.public.state.teams.length, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!db.files.has(`team-files/${photo1}`) && !db.files.has(`team-files/${thumbPath(photo2)}`), 'the removed team’s files are deleted');
  await remoteApi('logout');
  assert.equal((await remoteApi('register', { name: 'Next Team', ...where, players, adults })).team.id, 'CAR-002', 'removed IDs are not reused');

  assert.deepEqual(db.saves.map(s => `${s.event}:${s.by}:${s.action}`), ['main:Omar Official:unassign', 'main:Omar Official:assign', 'main:Omar Official:start', 'main:Omar Official:checkin', 'main:Asha Admin:reset',
    'practice:Omar Official:unassign', 'practice:Omar Official:assign', 'practice:Omar Official:reset', 'practice:Omar Official:demo', 'main:Asha Admin:practice-mode', 'main:Asha Admin:practice-mode', 'main:Asha Admin:remove-team']);
  assert.equal((await remoteApi('state')).isAdmin, false);
});
test('live Pages runtime: check-in, lunch and umpire accounts do only their own job', async t => {
  const db = fakeSupabase(), memory = new Map(), realFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  globalThis.fetch = db.fetch; globalThis.location = { origin: 'https://sajinct.github.io', pathname: '/carromia/', search: '' };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; delete globalThis.location; });
  const { remoteApi } = await import('../dist/runtime.js');
  const as = (email, password) => remoteApi('logout').then(() => remoteApi('login', { email, password }));
  // The sample has M01 to M04 called to boards 1 to 4, every team checked in, and lunch booked by most teams.
  db.rows.main.state.event.lunchCoupons = true;
  const team = db.rows.main.state.teams.find(t => t.lunch), token = team.checkinToken;

  await as('cara@example.org', 'checkin-pass');
  let state = await remoteApi('state');
  assert.deepEqual(state.user, { name: 'Cara Checkin', role: 'checkin', boards: [] });
  assert.equal(state.teams[0].players[0].mobile, undefined, 'no contact numbers'); assert.equal(state.teams[0].players[0].idType, 'Aadhaar', 'ID details to compare at check-in');
  assert.ok(state.teams[0].checkinToken, 'a scanned QR code finds its team');
  await remoteApi('photos');
  await assert.rejects(remoteApi('payment-proofs'), /Payment screenshots are for/);
  await remoteApi('checkin', { token });
  for (const [path, input] of [['serve-lunch', { token }], ['confirm-payment', { id: team.id }], ['unassign', { id: 'M01' }], ['draw', {}]]) await assert.rejects(remoteApi(path, input), /Check-in desk role|Only an event admin/, path);

  await as('lena@example.org', 'lunch-pass');
  state = await remoteApi('state');
  assert.equal(state.teams[0].players[0].idType, undefined); assert.ok(state.teams[0].checkinToken, 'a scanned coupon finds its team');
  await assert.rejects(remoteApi('photos'), /Player photos are for/);
  await remoteApi('serve-lunch', { token }); assert.equal(db.rows.main.state.teams.find(t => t.id === team.id).lunchServed, 1);
  await remoteApi('serve-lunch', { token, undo: true }); assert.equal(db.rows.main.state.teams.find(t => t.id === team.id).lunchServed, 0);
  await assert.rejects(remoteApi('checkin', { token }), /Lunch counter role/);

  // An umpire on board 1 runs the match there, and nothing on board 2.
  await as('uma@example.org', 'umpire-pass');
  assert.deepEqual((await remoteApi('state')).user, { name: 'Uma Umpire', role: 'umpire', boards: [1] });
  await assert.rejects(remoteApi('start', { id: 'M02' }), /isn’t assigned to you/);
  await assert.rejects(remoteApi('unassign', { id: 'M01' }), /Umpire role/);
  await assert.rejects(remoteApi('payment-proofs'), /Payment screenshots are for/);
  await remoteApi('start', { id: 'M01' });
  const m = db.rows.main.state.matches.find(m => m.id === 'M01');
  await remoteApi('round-winner', { id: 'M01', winner: m.teamA }); await remoteApi('next-round', { id: 'M01' }); await remoteApi('round-winner', { id: 'M01', winner: m.teamA });
  assert.equal(db.rows.main.state.matches.find(m => m.id === 'M01').status, 'completed');
  assert.equal(db.rows.main.state.matches.find(m => m.id === 'M01').official, 'Uma Umpire');
  await remoteApi('board-ready', { board: 1 });
  await assert.rejects(remoteApi('board-ready', { board: 2 }), /isn’t assigned to you/);

  // A change an admin makes to the umpire's boards applies on their next refresh.
  db.users['uma@example.org'].official.boards = [2];
  assert.deepEqual((await remoteApi('state')).user.boards, [2]);
  await assert.rejects(remoteApi('board-ready', { board: 1 }), /isn’t assigned to you/);
  assert.deepEqual(db.saves.map(s => `${s.by}:${s.action}`), ['Cara Checkin:checkin', 'Lena Lunch:serve-lunch', 'Lena Lunch:serve-lunch', 'Uma Umpire:start', 'Uma Umpire:round-winner', 'Uma Umpire:next-round', 'Uma Umpire:round-winner', 'Uma Umpire:board-ready']);
});
test('live Pages runtime: a parish registers several teams at once; the coordinator downloads every form', async t => {
  const db = fakeSupabase(), memory = new Map(), realFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  globalThis.fetch = db.fetch; globalThis.location = { origin: 'https://sajinct.github.io', pathname: '/carromia/', search: '' };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; delete globalThis.location; });
  const { remoteApi } = await import('../dist/runtime.js');
  await remoteApi('login', { email: 'asha@example.org', password: 'admin-pass' }); await remoteApi('reset', { confirm: 'RESET' }); await remoteApi('logout');

  const parish = centre(3), adults = true, coordinator = { name: 'Fr. Coord', mobile: '9900000000' }, pair = name => [player(`${name} A`, '9333333333'), player(`${name} B`, '9444444444')];
  await assert.rejects(remoteApi('register', { ...parish, adults, coordinator, teams: [{ name: 'Alpha', players: pair('Alpha') }, { name: 'Beta', players: [player('B1'), player('B2', '9000000001', false)] }] }), /photo of each player/);
  await assert.rejects(remoteApi('register', { ...parish, adults, teams: [{ name: 'Alpha', players: pair('Alpha') }, { name: 'Beta', players: pair('Beta') }] }), /parish coordinator/);
  assert.equal(db.files.size, 0, 'a refused registration leaves no files');
  const { teams } = await remoteApi('register', { ...parish, adults, coordinator, teams: [{ name: 'Alpha', players: pair('Alpha'), lunch: 2 }, { name: 'Beta', players: pair('Beta'), primaryContact: 1 }] });
  assert.deepEqual(teams.map(g => [g.id, g.group.id, g.group.size, g.status]), [['CAR-001', 'CAR-001', 2, 'confirmed'], ['CAR-002', 'CAR-001', 2, 'confirmed']]);
  assert.equal(db.files.size, 8, 'two photos and two thumbnails per team');
  assert.deepEqual(db.public.state.teams[1].group, { id: 'CAR-001', size: 2 }); assert.ok(!JSON.stringify(db.public).includes('9900000000'), 'the coordinator’s number is not public');
  await assert.rejects(remoteApi('group-form', { id: 'CAR-001', mobile: '9333333333' }), /parish coordinator/);
  const { forms } = await remoteApi('group-form', { id: 'car-001', mobile: '9900000000' });
  assert.deepEqual(forms.map(g => g.team.id), ['CAR-001', 'CAR-002']); assert.ok(forms.every(g => typeof g.qr === 'string' && g.team.checkinToken === undefined));
  assert.equal(new Set(forms.flatMap(g => g.photos)).size, 4, 'each team’s own thumbnails');
  assert.equal((await remoteApi('team-form', { id: 'CAR-002', mobile: '9900000000' })).team.id, 'CAR-002', 'the coordinator can download one team’s form too');
});
// A screen running watch() against the stand-in, with a fake page and Realtime socket.
async function watchedScreen(t, db) {
  const memory = new Map(), realFetch = globalThis.fetch, listeners = [], document = { hidden: false, addEventListener: (type, fn) => listeners.push(fn) };
  const screen = { memory, fetches: 0, changes: 0, sockets: [], setHidden: hidden => { document.hidden = hidden; listeners.forEach(fn => fn()); } };
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  globalThis.fetch = (...args) => { screen.fetches++; return db.fetch(...args); }; globalThis.location = { origin: 'https://sajinct.github.io', pathname: '/carromia/', search: '' }; globalThis.document = document;
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; delete globalThis.location; delete globalThis.document; });
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; screen.sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { if (this.closed) return; this.closed = true; this.onclose?.(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    joined() { return this.sent.filter(m => m.event === 'phx_join').map(m => m.topic); }
    accept() { this.onopen(); this.sent.filter(m => m.event === 'phx_join').forEach(m => this.receive({ topic: m.topic, event: 'phx_reply', ref: m.ref, payload: { status: 'ok', response: {} } })); }
    announce(event, payload) { this.receive({ topic: `realtime:tournament:${event}`, event: 'broadcast', ref: null, payload: { type: 'broadcast', event: 'changed', payload } }); }
  }
  screen.settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  const { watch } = await import('../dist/runtime.js');
  watch(() => screen.changes++, { WebSocketImpl: FakeSocket });
  await screen.settle();
  return screen;
}
test('live Pages runtime: screens follow Realtime announcements and fall back to version checks', async t => {
  const db = fakeSupabase(), screen = await watchedScreen(t, db), { sockets, memory, settle, setHidden } = screen;
  assert.equal(sockets.length, 1); assert.match(sockets[0].url, /^wss:\/\/vzxcqpgwvknonkhjinuk\.supabase\.co\/realtime\/v1\/websocket\?apikey=sb_publishable_/);
  sockets[0].accept(); await settle();
  assert.deepEqual(sockets[0].joined(), ['realtime:tournament:main']);
  // Joined, but nothing announced yet (a database without the migration): version checks carry on.
  db.pub.main.version = 6; t.mock.timers.tick(10000); await settle();
  assert.equal(screen.changes, 1, 'the version check caught a change the channel never announced');

  // A change announced on the channel: one redraw, none for a repeat; no polling while connected.
  const before = screen.fetches;
  db.pub.main.version = 7; sockets[0].announce('main', { version: 7, practiceOff: false }); sockets[0].announce('main', { version: 7, practiceOff: false });
  t.mock.timers.tick(30000); await settle();
  assert.equal(screen.changes, 2); assert.equal(screen.fetches, before, 'no version checks once the channel has announced a change');
  assert.ok(sockets[0].sent.some(m => m.topic === 'phoenix' && m.event === 'heartbeat'));

  // The connection drops: version checks stand in until it reconnects.
  sockets[0].close(); db.pub.main.version = 8;
  t.mock.timers.tick(1000); await settle();
  assert.equal(sockets.length, 2, 'reconnects after a second');
  t.mock.timers.tick(9000); await settle();
  assert.equal(screen.changes, 3, 'the version check caught the change');

  // Practice mode on this device: the screen follows the practice channel and the real one, and
  // goes back when an admin turns practice off.
  memory.set('carromia-practice', 'on'); db.pub.practice = { version: 3, state: db.pub.main.state };
  t.mock.timers.tick(10000); await settle();
  const practice = sockets.at(-1); practice.accept(); await settle();
  assert.deepEqual(practice.joined(), ['realtime:tournament:main', 'realtime:tournament:practice']);
  const now = screen.changes;
  practice.announce('main', { version: 9, practiceOff: false }); assert.equal(screen.changes, now, 'the real event’s screen.changes don’t redraw a practice screen');
  practice.announce('main', { version: 10, practiceOff: true }); assert.equal(screen.changes, now + 1);

  // A hidden tab lets go of its connection, and reconnects when shown again.
  setHidden(true); t.mock.timers.tick(60000); await settle();
  assert.ok(practice.closed); const count = sockets.length;
  setHidden(false); await settle();
  assert.equal(sockets.length, count + 1);
});
test('live Pages runtime: a screen stops checking as soon as the database confirms it announces changes', async t => {
  const db = fakeSupabase(); db.announces = true;
  const screen = await watchedScreen(t, db), [socket] = screen.sockets;
  db.pub.main.version = 5; socket.accept(); await screen.settle();
  assert.equal(screen.changes, 1, 'the join catches up on a change made while connecting');
  const before = screen.fetches;
  t.mock.timers.tick(60000); await screen.settle();
  assert.equal(screen.fetches, before, 'no version checks, although nothing has been announced yet');
  socket.announce('main', { version: 6, practiceOff: false });
  assert.equal(screen.changes, 2);
});
