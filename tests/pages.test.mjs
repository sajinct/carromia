import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo, publicState, addTeam, playerPhotos, teamForm } from '../lib/tournament.mjs';
import { centre, player, photo } from './registration-fixture.mjs';
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
  // The registration deadline is removed so this test passes on any date.
  const sample = seedDemo(); sample.event.registrationDeadline = '';
  const db = { rows: { main: { version: 1, state: sample } }, pub: { main: { version: 1, state: publicState(sample) } }, saves: [], photos: [], raceOnce: false };
  Object.defineProperty(db, 'public', { get: () => db.pub.main });
  const users = { 'asha@example.org': { id: 'u1', password: 'admin-pass', official: { name: 'Asha Admin', role: 'admin' } }, 'omar@example.org': { id: 'u2', password: 'official-pass', official: { name: 'Omar Official', role: 'official' } } };
  const byToken = token => Object.values(users).find(u => `token-${u.id}` === token);
  const reply = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  db.fetch = async (href, init = {}) => {
    const url = new URL(href), body = init.body ? JSON.parse(init.body) : null, caller = byToken(init.headers?.Authorization?.replace('Bearer ', ''));
    const id = url.searchParams.get('id')?.replace('eq.', '');
    assert.equal(init.headers.apikey, 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro');
    switch (url.pathname) {
      case '/rest/v1/rpc/server_time': return reply(200, Date.now());
      case '/rest/v1/tournament_public': return reply(200, db.pub[id] ? [structuredClone(db.pub[id])] : []);
      case '/rest/v1/tournament': return reply(200, caller?.official && db.rows[id] ? [structuredClone(db.rows[id])] : []);
      case '/rest/v1/officials': return reply(200, caller ? [caller.official] : []);
      case '/rest/v1/player_photos': return reply(200, caller?.official ? db.photos.filter(p => p.event === url.searchParams.get('event').replace('eq.', '')) : []);
      case '/auth/v1/token': { const u = users[body.email]; return u?.password === body.password ? reply(200, { access_token: `token-${u.id}`, refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: u.id } }) : reply(400, { error_description: 'Invalid login credentials' }); }
      case '/auth/v1/logout': return reply(204);
      case '/auth/v1/user': {
        if (!caller) return reply(401, { msg: 'Invalid token' });
        if (init.method === 'PUT') { if (body.password === caller.password) return reply(422, { msg: 'New password should be different from the old password.' }); caller.password = body.password; }
        return reply(200, { id: caller.id, email: Object.keys(users).find(email => users[email] === caller) });
      }
      case '/rest/v1/rpc/register_team': {
        const main = db.rows[body.p_event ?? 'main'];
        if (main.state.demo) return reply(400, { message: 'Registration will open soon. Please check back.' });
        try { const images = playerPhotos({ players: body.p_players }), team = addTeam(main.state, { name: body.p_name, forane: body.p_forane, parish: body.p_parish, centreType: body.p_centre_type, players: body.p_players, payment: body.p_payment, primaryContact: body.p_primary, lunch: body.p_lunch, adults: body.p_adults }); images.forEach((image, player) => db.photos.push({ event: body.p_event ?? 'main', team_id: team.id, player, image })); main.version++; db.pub[body.p_event ?? 'main'] = { version: main.version, state: publicState(main.state) }; return reply(200, { team }); }
        catch (error) { return reply(400, { message: error.message }); }
      }
      case '/rest/v1/rpc/team_form': {
        try { const team = teamForm(db.rows[body.p_event].state, body.p_team_id, body.p_mobile); return reply(200, { team, photos: db.photos.filter(p => p.event === body.p_event && p.team_id === team.id).map(p => p.image) }); }
        catch (error) { return /doesn’t match/.test(error.message) ? reply(200, { error: error.message }) : reply(400, { message: error.message }); }
      }
      case '/rest/v1/rpc/save_tournament': {
        if (!caller?.official) return reply(403, { message: 'Sign in as a tournament official.' });
        const target = body.p_id ?? 'main', row = db.rows[target];
        if (db.raceOnce) { db.raceOnce = false; row.version++; row.state = { ...row.state, event: { ...row.state.event, venue: 'Changed elsewhere' } }; }
        if (body.p_expected !== (row?.version ?? 0)) return reply(409, { message: 'The event was changed from another session. Please try again.' });
        db.rows[target] = { version: (row?.version ?? 0) + 1, state: body.p_state };
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
  assert.equal(form.team.id, team.id); assert.equal(form.team.checkinToken, undefined); assert.deepEqual(form.photos, [photo, photo]);

  // Practice mode: a separate sample event; the real event and the public copy are untouched.
  await remoteApi('login', { email: 'omar@example.org', password: 'official-pass' });
  assert.deepEqual(await remoteApi('photos'), { 'CAR-001': [photo, photo] });
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
  await remoteApi('logout');
  assert.equal((await remoteApi('register', { name: 'Next Team', ...where, players, adults })).team.id, 'CAR-002', 'removed IDs are not reused');

  assert.deepEqual(db.saves.map(s => `${s.event}:${s.by}:${s.action}`), ['main:Omar Official:unassign', 'main:Omar Official:assign', 'main:Omar Official:start', 'main:Omar Official:checkin', 'main:Asha Admin:reset',
    'practice:Omar Official:unassign', 'practice:Omar Official:assign', 'practice:Omar Official:reset', 'practice:Omar Official:demo', 'main:Asha Admin:practice-mode', 'main:Asha Admin:practice-mode', 'main:Asha Admin:remove-team']);
  assert.equal((await remoteApi('state')).isAdmin, false);
});
