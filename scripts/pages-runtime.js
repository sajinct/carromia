// GitHub Pages runtime: the static site talks to Supabase directly (see supabase/migrations).
// Visitors read the public copy of the event; signed-in officials apply the tournament rules in
// the browser and save through save_tournament(), which rejects stale saves so no change is lost.
// Practice mode: any device opened with ?practice=1 (or switched from the desk) follows the
// separate 'practice' event instead, so a TV, phones and the desk can rehearse the full flow
// without touching the real event. It stays on until "Exit practice", or until an admin turns
// practice mode off for everyone (practiceOff on the real event), which sends every device back.
import { emptyState, eligible, fail, freshEvent, publicState, practiceEvent, actions, refusal, checkBoard, teamsFor, fileRoles, registrationStatus, defaults, playerPhotos, paymentProof, shareRoutes, thumbPath, upiQrImage } from './tournament-browser.js';
import { findCentre } from './parishes.js';

export const pagesMode = true;
// The publishable key is meant for browsers; the database rules decide what it may do.
const SUPABASE_URL = 'https://vzxcqpgwvknonkhjinuk.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro';
const SESSION_KEY = 'carromia-official-session', PRACTICE_KEY = 'carromia-practice';
// The engine's actions, with the two that differ on the live site: sample teams live only in the
// practice event, and resetting practice gives an empty practice event with registration open.
const handlers = {
  ...actions,
  demo: { admin: true, run: (state, input, { event }) => { fail(event !== 'practice', 'Sample teams live in practice mode, so they never mix with real registrations.'); return practiceEvent(state.event); } },
  reset: { admin: true, run: (state, input, { event }) => event === 'practice' ? { ...freshEvent(state, input.confirm), practice: true } : freshEvent(state, input.confirm) }
};
let offset = 0, clockSynced = false;
const now = () => Date.now() + offset;

const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const practiceOn = () => { try { return localStorage.getItem(PRACTICE_KEY) === 'on'; } catch { return false; } };
const setPractice = on => { try { on ? localStorage.setItem(PRACTICE_KEY, 'on') : localStorage.removeItem(PRACTICE_KEY); } catch {} };
const writeSession = value => { try { value ? localStorage.setItem(SESSION_KEY, JSON.stringify(value)) : localStorage.removeItem(SESSION_KEY); } catch {} };
// A practice link (?practice=1) switches this device into practice mode; ?practice=0 leaves it.
if (typeof location !== 'undefined') { const flag = new URLSearchParams(location.search).get('practice'); if (flag !== null) setPractice(flag === '1'); }
const siteUrl = () => `${location.origin}${location.pathname}`;
const practiceLink = route => `${siteUrl()}?practice=1#${route}`;

// `bytes` sends a file (with its `type`) instead of JSON.
async function request(path, { method = 'GET', body, bytes, type, token } = {}) {
  const headers = { apikey: PUBLISHABLE_KEY, 'Content-Type': bytes ? type : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(SUPABASE_URL + path, { method, headers, cache: 'no-store', body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)) }); }
  catch { throw new Error('Unable to reach the tournament. Check your connection and try again.'); }
  const text = await res.text(); let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!res.ok) throw Object.assign(new Error(value?.message || value?.msg || value?.error_description || 'The tournament service is unavailable.'), { status: res.status });
  return value;
}

// Returns a valid access token for the signed-in official, refreshing it when close to expiry.
async function accessToken() {
  const session = readSession(); if (!session) return null;
  if (session.expires_at * 1000 - 60000 > Date.now()) return session.access_token;
  try {
    const next = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
    writeSession({ ...session, access_token: next.access_token, refresh_token: next.refresh_token, expires_at: next.expires_at }); return next.access_token;
  } catch { writeSession(null); return null; }
}
// Photos and payment screenshots are private files; officials get links to them that last an hour.
async function signed(user, paths) {
  if (!paths.length) return [];
  const links = await request('/storage/v1/object/sign/team-files', { method: 'POST', token: user.token, body: { expiresIn: 3600, paths } });
  return paths.map(p => { const link = links.find(l => l.path === p)?.signedURL; return link ? `${SUPABASE_URL}/storage/v1${link}` : ''; });
}
// The registration Edge Function (supabase/functions/registration) holds the key for team files.
async function registration(body, token) {
  try { return await request('/functions/v1/registration', { method: 'POST', token, body }); }
  catch (error) { throw error.status === 404 && !/Team not found/.test(error.message) ? new Error('Registration is being updated. Please try again shortly.') : error; }
}
const dataBytes = data => Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), c => c.charCodeAt(0));
async function official() { const token = await accessToken(); return token ? { token, ...readSession().official } : null; }

async function syncClock() {
  if (clockSynced) return;
  const sent = Date.now(), server = await request('/rest/v1/rpc/server_time', { method: 'POST', body: {} });
  offset = server - (sent + Date.now()) / 2; clockSynced = true;
}

const eventId = () => practiceOn() ? 'practice' : 'main';
// Whether an admin has turned practice mode off, from the real event's public copy.
const practiceOff = async () => Boolean((await request('/rest/v1/tournament_public?id=eq.main&select=state'))[0]?.state?.event?.practiceOff);
async function load(user) {
  const id = eventId();
  const [row] = await request(user ? `/rest/v1/tournament?id=eq.${id}&select=version,state` : `/rest/v1/tournament_public?id=eq.${id}&select=version,state`, { token: user?.token });
  if (row) return { id, version: row.version, state: row.state };
  // The practice event is created from the sample tournament on an official's first use.
  if (id === 'practice' && user) return { id, version: 0, state: practiceEvent((await request('/rest/v1/tournament?id=eq.main&select=state', { token: user.token }))[0]?.state?.event ?? emptyState().event) };
  return { id, version: 0, state: { ...emptyState(), practice: id === 'practice' } };
}

// Applies a desk action to the latest saved event and saves it; retries if someone saved first.
async function change(user, action, input, apply) {
  for (let attempt = 1; ; attempt++) {
    const { id, version, state } = await load(user);
    const next = apply(state, id) ?? state;
    const { password, confirm, token, ...detail } = input;
    try { await request('/rest/v1/rpc/save_tournament', { method: 'POST', token: user.token, body: { p_expected: version, p_state: next, p_public: publicState(next), p_action: action, p_detail: detail, p_id: id } }); return; }
    catch (error) { if (error.status !== 409 || attempt >= 3) throw error; }
  }
}

async function qrCode(url, width = 240, payment = false) {
  const { default: QRCode } = await import('./vendor/qrcode.js');
  return { qr: await QRCode.toDataURL(url, { width, margin: payment ? 4 : 2, color: { dark: payment ? '#000000' : '#172d2c', light: '#ffffff' } }) };
}
// A team's check-in or lunch-counter page, from its QR code.
function teamLink(token, route) { const link = `${route}?token=${encodeURIComponent(token)}`; return practiceOn() ? practiceLink(link) : `${siteUrl()}#${link}`; }
// A public page's link for this device's event: a practice screen points phones to practice.
export function shareLink(route) {
  fail(!shareRoutes.includes(route), 'Page not found.');
  return practiceOn() ? practiceLink(route) : `${siteUrl()}#${route}`;
}

async function signIn(input) {
  const email = String(input.email || '').trim().toLowerCase();
  let session;
  try { session = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: String(input.password || '') } }); }
  catch (error) { throw new Error(error.status === 400 ? 'Incorrect email or password.' : error.message); }
  const [profile] = await request(`/rest/v1/officials?user_id=eq.${encodeURIComponent(session.user.id)}&select=name,role,boards`, { token: session.access_token });
  fail(!profile, 'This account is not a tournament official.');
  writeSession({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, official: profile });
  return { ok: true };
}

// An official changes their own password. Signing in again with the current password proves it
// is them, and gives the recent sign-in Supabase asks for before a password change.
async function changePassword(input) {
  const token = await accessToken();
  fail(!token, 'Sign in to the tournament desk first.');
  const current = String(input.current || ''), password = String(input.password || '');
  fail(password.length < 8, 'Passwords need at least 8 characters.');
  fail(password === current, 'Choose a new password that is different from your current one.');
  const { email } = await request('/auth/v1/user', { token });
  let fresh;
  try { fresh = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: current } }); }
  catch (error) { throw new Error(error.status === 400 ? 'Your current password is incorrect.' : error.message); }
  await request('/auth/v1/user', { method: 'PUT', token: fresh.access_token, body: { password, current_password: current } });
  writeSession({ ...readSession(), access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: fresh.expires_at });
  return { ok: true };
}

// The signed-in official's name, role and boards, read again on each refresh so a change an admin
// makes applies without signing out. An official who was removed is signed out.
async function profile(user) {
  const [row] = await request('/rest/v1/officials?select=name,role,boards', { token: user.token });
  if (!row) { writeSession(null); return null; }
  writeSession({ ...readSession(), official: row }); return { ...user, ...row };
}
// What the screens render: the followed event, with private details only for officials, and for
// the one-job roles only what their job needs.
async function view(user) {
  if (practiceOn() && await practiceOff()) setPractice(false);
  if (user) user = await profile(user);
  const { state } = await load(user), practice = eventId() === 'practice';
  const teams = user ? teamsFor(state.teams, user.role) : state.teams;
  return { ...state, event: { ...defaults, ...state.event }, practice, practiceAvailable: !state.event.practiceOff && (Boolean(user) || practice), practiceLinks: practice ? { live: practiceLink('/live'), register: practiceLink('/register'), desk: practiceLink('/admin') } : null, teams, activity: user ? state.activity : [], matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m, now()) })), registration: registrationStatus({ ...state, practice }, now()), isAdmin: Boolean(user), user: user && { name: user.name, role: user.role, boards: user.boards || [] }, authMode: 'supabase', localDemo: false, serverTime: now() };
}

// Officials are managed by the 'officials' Edge Function (supabase/functions/officials), which holds
// the service key and checks the caller is an admin; the browser only sends the admin's own token.
const officialActions = { officials: 'list', 'official-add': 'add', 'official-update': 'update', 'official-reset': 'reset-password', 'official-remove': 'remove' };
async function manageOfficials(user, action, input) {
  fail(!user, 'Sign in to the tournament desk first.');
  try { return await request('/functions/v1/officials', { method: 'POST', token: user.token, body: { ...input, action } }); }
  catch (error) { throw error.status === 404 && !error.message.includes('Official') ? new Error('Officials management isn’t set up yet. Deploy the “officials” Edge Function (see README).') : error; }
}

export async function remoteApi(path, input = {}) {
  if (path.startsWith('upi-payment-qr?')) return qrCode(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('uri'), 440, true);
  // Check-in and lunch-coupon QR codes keep the device in the same event (a practice QR opens practice mode).
  if (path.startsWith('qr?')) { const query = new URLSearchParams(path.slice(3)); return qrCode(teamLink(query.get('token'), query.get('for') === 'lunch' ? '/lunch' : '/checkin')); }
  if (path.startsWith('practice-qr?')) return qrCode(practiceLink(new URLSearchParams(path.slice(12)).get('route')));
  if (path.startsWith('link-qr?')) { const url = shareLink(new URLSearchParams(path.slice(8)).get('route')); return { url, ...await qrCode(url, 320) }; }
  if (path === 'practice') { fail(input.on === true && await practiceOff(), 'Practice mode is turned off by the event admin.'); setPractice(input.on === true); return { ok: true }; }
  await syncClock();
  if (path === 'login') return signIn(input);
  if (path === 'change-password') return changePassword(input);
  // A team's registration form, for whoever knows its primary player's or parish coordinator's
  // mobile number, or every form in a group for the coordinator; the database checks the number and
  // counts wrong tries.
  const formFor = async ({ team: { checkinToken, ...team }, photos }) => {
    const [{ qr }, { qr: lunchQr }] = await Promise.all([qrCode(teamLink(checkinToken, '/checkin')), team.lunch ? qrCode(teamLink(checkinToken, '/lunch')) : { qr: '' }].map(p => Promise.resolve(p).catch(() => ({ qr: '' }))));
    return { team, photos: photos || [], qr, lunchQr };
  };
  if (path === 'team-form' || path === 'group-form') {
    const reply = await registration({ action: path, event: eventId(), id: String(input.id ?? '').trim().toUpperCase(), mobile: String(input.mobile ?? '') });
    fail(reply.error, reply.error);
    return path === 'team-form' ? formFor(reply) : { forms: await Promise.all(reply.teams.map(formFor)) };
  }
  if (path === 'logout') { const token = readSession()?.access_token; writeSession(null); if (token) request('/auth/v1/logout', { method: 'POST', token }).catch(() => {}); return { ok: true }; }
  if (path === 'register') {
    // One team, or several from one parish paid for together (input.teams).
    const teams = Array.isArray(input.teams) ? input.teams : [input];
    // The database checks the rest; the forane / parish pair is checked against the register here.
    const centre = findCentre(input.forane, input.parish, input.centreType);
    fail(!centre, 'Choose your forane or zone, then your parish or centre from the list.');
    fail(input.adults !== true, teams.length > 1 ? 'Confirm that all players are 18 or older.' : 'Confirm that both players are 18 or older.');
    teams.forEach(t => playerPhotos(t));
    const payment = { txnRef: String(input.payment?.txnRef ?? ''), screenshot: paymentProof(input) };
    return registration({ action: 'register', p_forane: centre.group, p_parish: centre.name, p_centre_type: centre.type, p_event: eventId(), p_adults: true, p_payment: payment,
      p_coordinator: teams.length > 1 ? { name: String(input.coordinator?.name ?? ''), mobile: String(input.coordinator?.mobile ?? '') } : null,
      p_teams: teams.map(t => ({ name: t.name, players: Array.isArray(t.players) ? t.players : [], primaryContact: Number(t.primaryContact) === 1 ? 1 : 0, lunch: Number(t.lunch) || 0 })) });
  }

  let user = await official();
  if (path === 'state') return view(user);
  if (user) user = await profile(user);
  if (officialActions[path]) return manageOfficials(user, officialActions[path], input);
  fail(!user, 'Sign in to the tournament desk first.');
  // Payment screenshots are for admins and officials; player photos also for the check-in desk.
  const kind = path === 'payment-proofs' ? 'payments' : path === 'photos' || path.startsWith('photo-full?') ? 'photos' : null;
  fail(kind && !fileRoles[kind].includes(user.role), kind === 'payments' ? 'Payment screenshots are for event admins and officials.' : 'Player photos are for the check-in desk, officials and admins.');
  // Player photo thumbnails, for officials: { [team id]: [photo 1, photo 2] }.
  if (path === 'photos') {
    const rows = (await request(`/rest/v1/player_photos?event=eq.${eventId()}&select=team_id,player,path`, { token: user.token })).filter(r => r.path);
    const links = await signed(user, rows.map(r => thumbPath(r.path)));
    const map = {}; rows.forEach((r, i) => { map[r.team_id] ??= []; map[r.team_id][r.player] = links[i]; }); return map;
  }
  // One player's full-size photo.
  if (path.startsWith('photo-full?')) {
    const q = new URLSearchParams(path.slice(11));
    const [row] = await request(`/rest/v1/player_photos?event=eq.${eventId()}&team_id=eq.${encodeURIComponent(q.get('team'))}&player=eq.${Number(q.get('player'))}&select=path`, { token: user.token });
    fail(!row?.path, 'No photo for this player.');
    return { url: (await signed(user, [row.path]))[0] };
  }
  if (path === 'payment-proofs') {
    const rows = (await request(`/rest/v1/payment_proofs?event=eq.${eventId()}&select=team_id,path`, { token: user.token })).filter(r => r.path);
    const links = await signed(user, rows.map(r => r.path));
    return Object.fromEntries(rows.map((r, i) => [r.team_id, links[i]]));
  }
  // The UPI QR code for Event settings: a public file; settings then keep its address.
  if (path === 'upi-qr') {
    fail(user.role !== 'admin' && !practiceOn(), 'Only an event admin can do this.');
    const file = `${eventId()}/upi-qr-${crypto.randomUUID()}.png`;
    await request(`/storage/v1/object/event-assets/${file}`, { method: 'POST', token: user.token, bytes: dataBytes(upiQrImage(input)), type: 'image/png' });
    return { url: `${SUPABASE_URL}/storage/v1/object/public/event-assets/${file}` };
  }
  if (path === 'backup') { fail(user.role !== 'admin', 'Only an event admin can download backups.'); return (await load(user)).state; }
  const action = handlers[path];
  fail(!action, 'This action is not available.');
  // In practice mode an official may try every action; the real event keeps admin-only actions.
  // Check-in, lunch and umpire accounts do only their own job, in practice too.
  const refused = refusal(action, user, practiceOn()); fail(refused, refused);
  await change(user, path, input, (state, event) => { checkBoard(state, input, user); return action.run(state, input, { now: now(), official: user.name, event }); });
  // A removed team's files, or a fresh event's, are deleted in the background.
  if (path === 'remove-team' || path === 'reset') registration({ action: 'sweep' }, user.token).catch(() => {});
  return { ok: true };
}

// Calls onChange whenever the followed event changes. The database announces each change on a
// Realtime channel (supabase/migrations/20261008000000_carromia_realtime.sql), so a screen fetches
// the event only when something happened. A cheap version check every 10 seconds stands in while
// that connection is down, and until the database is known to announce changes: on joining, the
// screen asks tournament_versions() (20261009000000_carromia_realtime_versions.sql), which says so,
// and an announcement proves it too. A database without those migrations keeps being checked.
// A practice screen also hears when an admin turns practice off, which sends it back to the real
// event. Hidden tabs let go of their connection.
export function watch(onChange, { WebSocketImpl = globalThis.WebSocket, every = 10000 } = {}) {
  let known = null, socket = null, retry = 1000, trusted = false;
  const seen = (id, version, practiceOff) => {
    const key = `${id}:${version}`, changed = known !== null && key !== known;
    known = key;
    if (changed || (id === 'practice' && practiceOff)) onChange();
  };
  // The followed event's version and the real event's practiceOff, with announced: true when the
  // database announces changes (only asked just after joining the channel).
  const versions = async (id, joined) => {
    if (joined) {
      try { return await request('/rest/v1/rpc/tournament_versions', { method: 'POST', body: { p_ids: [...new Set(['main', id])] } }); } catch {}
    }
    return request(`/rest/v1/tournament_public?id=in.(main,${id})&select=id,version,practiceOff:state->event->practiceOff`);
  };
  const check = async (joined = false) => {
    if (document.hidden) return;
    try {
      const id = eventId(), rows = await versions(id, joined);
      if (rows.some(r => r.announced === true)) trusted = true;
      seen(id, rows.find(r => r.id === id)?.version ?? 0, rows.find(r => r.id === 'main')?.practiceOff === true);
    } catch {}
  };
  const connect = () => {
    if (socket || document.hidden || !WebSocketImpl) return;
    const id = eventId(), topics = id === 'practice' ? ['main', 'practice'] : ['main'];
    const ws = socket = new WebSocketImpl(`${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${PUBLISHABLE_KEY}&vsn=1.0.0`);
    ws.event = id; ws.live = false;
    let ref = 0, beat;
    const send = (topic, event, payload = {}) => ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref), join_ref: topic === 'phoenix' ? null : topic }));
    ws.onopen = () => {
      topics.forEach(t => send(`realtime:tournament:${t}`, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: false } }));
      beat = setInterval(() => send('phoenix', 'heartbeat'), 25000);
    };
    ws.onmessage = ({ data }) => {
      let message; try { message = JSON.parse(data); } catch { return; }
      const { topic, event, payload } = message;
      if (!topic?.startsWith('realtime:tournament:')) return;
      if (event === 'phx_reply' && payload?.status !== 'ok') ws.close();
      else if (event === 'phx_error' || event === 'phx_close') ws.close();
      // Once joined, catch up on anything that changed while connecting.
      else if (event === 'phx_reply' && topic === `realtime:tournament:${id}` && !ws.live) { ws.live = true; retry = 1000; check(true); }
      else if (event === 'broadcast' && payload?.event === 'changed') announced(topic, payload.payload ?? {});
    };
    const announced = (topic, { version, practiceOff }) => {
      if (topic === `realtime:tournament:${id}` && typeof version === 'number') { trusted = true; seen(id, version, false); }
      else if (topic === `realtime:tournament:${id}`) check();
      else if (id === 'practice' && practiceOff === true) onChange();
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      clearInterval(beat);
      if (socket !== ws) return;
      socket = null; setTimeout(connect, retry); retry = Math.min(retry * 2, 60000);
    };
  };
  const disconnect = () => { const ws = socket; socket = null; ws?.close(); };
  check(); connect();
  setInterval(() => {
    // Practice mode switched on this device: follow the other event's channel.
    if (socket && socket.event !== eventId()) { disconnect(); connect(); }
    if (!socket?.live || !trusted) check();
  }, every);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) disconnect();
    else { retry = 1000; check(); connect(); }
  });
}
