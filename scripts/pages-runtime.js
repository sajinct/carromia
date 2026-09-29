// GitHub Pages runtime: the static site talks to Supabase directly (see supabase/migrations).
// Visitors read the public copy of the event; signed-in officials apply the tournament rules in
// the browser and save through save_tournament(), which rejects stale saves so no change is lost.
// Practice mode: any device opened with ?practice=1 (or switched from the desk) follows the
// separate 'practice' event instead, so a TV, phones and the desk can rehearse the full flow
// without touching the real event. It stays on until "Exit practice".
import { emptyState, createDraw, assign, start, result, eligible, fail, updateSettings, checkIn, unassign, freshEvent, publicState, log, boardReady, removeTeam, practiceEvent } from './tournament-browser.js';

export const pagesMode = true;
// The publishable key is meant for browsers; the database rules decide what it may do.
const SUPABASE_URL = 'https://vzxcqpgwvknonkhjinuk.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_HdgK5UXMha3bvF5mk7o1Yw_eMN6h_Ro';
const SESSION_KEY = 'carromia-official-session', PRACTICE_KEY = 'carromia-practice';
const adminOnly = new Set(['draw', 'settings', 'demo', 'reset', 'backup', 'remove-team']);
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

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(SUPABASE_URL + path, { method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) }); }
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
async function official() { const token = await accessToken(); return token ? { token, ...readSession().official } : null; }

async function syncClock() {
  if (clockSynced) return;
  const sent = Date.now(), server = await request('/rest/v1/rpc/server_time', { method: 'POST', body: {} });
  offset = server - (sent + Date.now()) / 2; clockSynced = true;
}

const eventId = () => practiceOn() ? 'practice' : 'main';
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

async function qrCode(url) {
  const { default: QRCode } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
  return { qr: await QRCode.toDataURL(url, { width: 240, margin: 2, color: { dark: '#172d2c', light: '#ffffff' } }) };
}

async function signIn(input) {
  const email = String(input.email || '').trim().toLowerCase();
  let session;
  try { session = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: String(input.password || '') } }); }
  catch (error) { throw new Error(error.status === 400 ? 'Incorrect email or password.' : error.message); }
  const [profile] = await request(`/rest/v1/officials?user_id=eq.${encodeURIComponent(session.user.id)}&select=name,role`, { token: session.access_token });
  fail(!profile, 'This account is not a tournament official.');
  writeSession({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, official: profile });
  return { ok: true };
}

// What the screens render: the followed event, with private details only for officials.
async function view(user) {
  const { state } = await load(user), practice = eventId() === 'practice';
  const teams = user ? state.teams.map(({ checkinToken, ...t }) => t) : state.teams;
  return { ...state, practice, practiceAvailable: Boolean(user) || practice, practiceLinks: practice ? { live: practiceLink('/live'), register: practiceLink('/register'), desk: practiceLink('/admin') } : null, teams, activity: user ? state.activity : [], matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m, now()) })), isAdmin: Boolean(user), user: user && { name: user.name, role: user.role }, authMode: 'supabase', localDemo: false, serverTime: now() };
}

export async function remoteApi(path, input = {}) {
  // Check-in QR codes keep the device in the same event (a practice QR opens practice mode).
  if (path.startsWith('qr?')) { const token = encodeURIComponent(new URLSearchParams(path.slice(3)).get('token')); return qrCode(practiceOn() ? practiceLink(`/checkin?token=${token}`) : `${siteUrl()}#/checkin?token=${token}`); }
  if (path.startsWith('practice-qr?')) return qrCode(practiceLink(new URLSearchParams(path.slice(12)).get('route')));
  if (path === 'practice') { setPractice(input.on === true); return { ok: true }; }
  await syncClock();
  if (path === 'login') return signIn(input);
  if (path === 'logout') { const token = readSession()?.access_token; writeSession(null); if (token) request('/auth/v1/logout', { method: 'POST', token }).catch(() => {}); return { ok: true }; }
  if (path === 'register') {
    const players = Array.isArray(input.players) ? input.players : [];
    return request('/rest/v1/rpc/register_team', { method: 'POST', body: { p_name: input.name, p_parish: input.parish, p_players: players, p_primary: Number(input.primaryContact) === 1 ? 1 : 0, p_event: eventId() } });
  }

  const user = await official();
  if (path === 'state') return view(user);
  fail(!user, 'Sign in to the tournament desk first.');
  // In practice mode every official may try every action; the real event keeps admin-only actions.
  fail(adminOnly.has(path) && user.role !== 'admin' && !(practiceOn() && path !== 'backup'), 'Only an event admin can do this.');
  if (path === 'backup') return (await load(user)).state;
  const actions = {
    checkin: state => checkIn(state, input),
    draw: state => createDraw(state),
    assign: state => assign(state, input.id, input.board, now()),
    start: state => start(state, input.id, now()),
    result: state => { result(state, input.id, input, now()); const m = state.matches.find(m => m.id === input.id); if (m.status === 'completed') m.official = user.name; },
    unassign: state => unassign(state, input.id),
    'board-ready': state => boardReady(state, input.board, now()),
    settings: state => { updateSettings(state, input); log(state, 'Event settings updated'); },
    'remove-team': state => removeTeam(state, input.id),
    demo: (state, id) => { fail(id !== 'practice', 'Sample teams live in practice mode, so they never mix with real registrations.'); return practiceEvent(state.event); },
    // Resetting practice gives an empty practice event with registration open, ready for a full rehearsal.
    reset: (state, id) => id === 'practice' ? { ...freshEvent(state, input.confirm), practice: true } : freshEvent(state, input.confirm)
  };
  fail(!actions[path], 'This action is not available.');
  await change(user, path, input, actions[path]);
  return { ok: true };
}

// Calls onChange whenever the followed event changes (a cheap version check every few seconds).
export function watch(onChange) {
  let known = null;
  const check = async () => {
    if (document.hidden) return;
    try {
      const id = eventId(), [row] = await request(`/rest/v1/tournament_public?id=eq.${id}&select=version`);
      const version = `${id}:${row?.version ?? 0}`; if (known !== null && version !== known) onChange(); known = version;
    } catch {}
  };
  check(); setInterval(check, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
