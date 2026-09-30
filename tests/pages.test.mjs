import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo, publicState, addTeam, teamForm, thumbPath } from '../lib/tournament.mjs';
import { centre, player, photo } from './registration-fixture.mjs';
const root = join(import.meta.dirname, '..');
// The registration Edge Function runs against the same stand-in, with the service key.
const functionSource = readFileSync(join(root, 'supabase', 'functions', 'registration', 'index.ts'), 'utf8');
const { handle: registrationFunction } = await import(`data:text/javascript,${encodeURIComponent(functionSource)}`);
const SUPABASE = 'https://vzxcqpgwvknonkhjinuk.supabase.co', PUBLISHABLE = 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro', SERVICE = 'sb_secret_test';
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
  // The registration deadline is removed so this test passes on any date.
  const sample = seedDemo(); sample.event.registrationDeadline = '';
  const db = { rows: { main: { version: 1, state: sample } }, pub: { main: { version: 1, state: publicState(sample) } }, saves: [], photos: [], proofs: [], files: new Map(), raceOnce: false };
  Object.defineProperty(db, 'public', { get: () => db.pub.main });
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass', official: { name: 'Asha Admin', role: 'admin' } }, 'omar@example.org': { id: 'u2', password: 'official-pass', official: { name: 'Omar Official', role: 'official' } } };
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
    if (['/rest/v1/rpc/register_team', '/rest/v1/rpc/team_form', '/rest/v1/rpc/unreferenced_files'].includes(url.pathname) && !service) return reply(404, { message: 'Could not find the function in the schema cache' });
    switch (url.pathname) {
      case '/rest/v1/rpc/server_time': return reply(200, Date.now());
      case '/rest/v1/tournament_public': return reply(200, db.pub[id] ? [structuredClone(db.pub[id])] : []);
      case '/rest/v1/tournament': return reply(200, caller?.official && db.rows[id] ? [structuredClone(db.rows[id])] : []);
      case '/rest/v1/officials': { const who = service ? Object.values(users).find(u => u.id === eq('user_id')) : caller; return reply(200, who ? [who.official] : []); }
      case '/rest/v1/player_photos': return reply(200, caller?.official ? db.photos.filter(p => p.event === eq('event') && (!eq('team_id') || p.team_id === eq('team_id')) && (!eq('player') || p.player === Number(eq('player')))) : []);
      case '/rest/v1/payment_proofs': return reply(200, caller?.official ? db.proofs.filter(p => p.event === eq('event')) : []);
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
      case '/rest/v1/rpc/register_team': {
        const main = db.rows[body.p_event ?? 'main'];
        if (main.state.demo) return reply(400, { message: 'Registration will open soon. Please check back.' });
        // The pictures are paths of files already uploaded, which must exist.
        const event = body.p_event ?? 'main', paths = body.p_players.map(p => p.photo), shot = body.p_payment?.screenshot;
        if (paths.some(p => !p.startsWith(`${event}/`) || !db.files.has(`team-files/${p}`))) return reply(400, { message: 'Add a photo of each player (a JPEG under 4 MB).' });
        try { const team = addTeam(main.state, { name: body.p_name, forane: body.p_forane, parish: body.p_parish, centreType: body.p_centre_type, players: body.p_players, payment: body.p_payment && { ...body.p_payment, screenshot: shot ? photo : '' }, primaryContact: body.p_primary, lunch: body.p_lunch, adults: body.p_adults }); paths.forEach((path, player) => db.photos.push({ event, team_id: team.id, player, path })); if (shot) db.proofs.push({ event, team_id: team.id, path: shot }); main.version++; db.pub[event] = { version: main.version, state: publicState(main.state) }; return reply(200, { team }); }
        catch (error) { return reply(400, { message: error.message }); }
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
  assert.equal(state.isAdmin, true); assert.deepEqual(state.user, { name: 'Omar Official', role: 'official' }); assert.equal(state.teams[0].players[0].mobile, '9000000000'); assert.ok(state.teams[0].checkinToken, 'officials can print a team’s form again'); assert.equal(state.practice, false);
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
  assert.equal((await db.fetch(`${SUPABASE}/rest/v1/rpc/register_team`, { method: 'POST', headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);

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
