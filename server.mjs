import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { fileStore, supabaseStore, ConflictError } from './lib/store.mjs';
import { emptyState, addTeam, createDraw, assign, start, result, eligible, log, fail, updateSettings, checkIn, unassign, freshEvent, loadSample, boardReady, removeTeam, walkover, undoWalkover, correctResult } from './lib/tournament.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const password = process.env.ADMIN_PASSWORD || 'carromia-demo';
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_SECRET_KEY)) { console.error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY, or neither for local file storage.'); process.exit(1); }
const store = SUPABASE_URL ? supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY) : fileStore(process.env.DATA_DIR || join(import.meta.dirname, 'data'));
const supabase = store.kind === 'supabase';
let state = (await store.load()) ?? emptyState();
const sessions = new Map(), streams = new Set(), attempts = new Map();
const maxStreams = Number(process.env.MAX_STREAMS || 200);
function limited(key, max, windowMs) { const now = Date.now(); let a = attempts.get(key); if (!a || a.expires < now) attempts.set(key, a = { count: 0, expires: now + windowMs }); return ++a.count > max; }
setInterval(() => { const now = Date.now(); for (const map of [sessions, attempts]) for (const [key, value] of map) if (value.expires < now) map.delete(key); }, 600000).unref();
function broadcast() { for (const stream of streams) stream.write('data: update\n\n'); }
// Changes run one at a time so a slow save can never interleave with, or roll back, another change.
let queue = Promise.resolve();
function change(fn) {
  const run = queue.then(async () => {
    const before = structuredClone(state);
    try { const value = fn(); await store.save(state); broadcast(); return value; }
    catch (error) {
      if (!(error instanceof ConflictError)) { state = before; throw error; }
      state = (await store.load()) ?? emptyState(); broadcast(); throw error;
    }
  });
  queue = run.catch(() => {}); return run;
}
function official(req) { const token = /(?:^|;\s*)carromia_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; const session = sessions.get(token); return session?.expires > Date.now() ? session.user : null; }
function signIn(res, user) {
  const token = randomBytes(32).toString('hex'); sessions.set(token, { expires: Date.now() + 12 * 3600000, user });
  res.setHeader('Set-Cookie', `carromia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`);
}
const adminOnly = new Set(['/api/draw', '/api/settings', '/api/demo', '/api/reset', '/api/remove-team', '/api/walkover', '/api/undo-walkover', '/api/correct-result']);
const auditDetail = ({ token, confirm, password, ...input }) => input;
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new Error('Request too large.'); } return JSON.parse(text || '{}'); }
function view(user) {
  const isAdmin = Boolean(user);
  return { ...state, teams: state.teams.map(({ checkinToken, ...t }) => ({ ...t, players: t.players.map(p => isAdmin ? p : { name: p.name }) })), activity: isAdmin ? state.activity : [], matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m) })), isAdmin, user: user && { name: user.name, role: user.role }, authMode: supabase ? 'supabase' : 'password', localDemo: !supabase && !process.env.ADMIN_PASSWORD, serverTime: Date.now() };
}
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (streams.size >= maxStreams) return send(res, 503, { error: 'Too many live connections. Updates will continue by polling.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); streams.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000); req.on('close', () => { clearInterval(heartbeat); streams.delete(res); }); return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, view(official(req)));
    if (url.pathname === '/api/backup' && req.method === 'GET') { const user = official(req); if (!user) return send(res, 401, { error: 'Sign in to download a backup.' }); if (user.role !== 'admin') return send(res, 403, { error: 'Only an event admin can download backups.' }); return send(res, 200, state); }
    if (url.pathname === '/api/qr' && req.method === 'GET') {
      const t = state.teams.find(t => t.checkinToken === url.searchParams.get('token')); if (!t) return send(res, 404, { error: 'Team not found.' });
      const qr = await QRCode.toDataURL(`${process.env.PUBLIC_URL || `http://localhost:${port}`}/checkin?token=${t.checkinToken}`, { width: 240, margin: 2, color: { dark: '#172d2c', light: '#ffffff' } }); return send(res, 200, { qr });
    }
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== process.env.PUBLIC_URL) return send(res, 403, { error: 'Origin not allowed.' });
      const input = await body(req);
      if (url.pathname === '/api/login') {
        const key = `login:${req.socket.remoteAddress}`;
        if (limited(key, 10, 60000)) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
        let user;
        if (supabase) {
          user = await store.signIn(String(input.email || '').trim().toLowerCase(), String(input.password || ''));
          if (!user) return send(res, 401, { error: 'Incorrect email or password, or this account is not a tournament official.' });
        } else {
          const a = Buffer.from(String(input.password || '')), b = Buffer.from(password);
          if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 401, { error: 'Incorrect desk password.' });
          user = { id: null, name: 'Tournament desk', role: 'admin' };
        }
        attempts.delete(key); signIn(res, user); store.audit({ actor_id: user.id, actor_name: user.name, action: 'login' }); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/logout') { const token = /carromia_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; sessions.delete(token); res.setHeader('Set-Cookie', 'carromia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/register') { if (limited(`register:${req.socket.remoteAddress}`, 30, 600000)) return send(res, 429, { error: 'Too many registrations from this connection. Try again in a few minutes.' }); const team = await change(() => { fail(state.demo, 'Sample tournament is active. Start a fresh event from Settings to accept registrations.'); return addTeam(state, input); }); store.audit({ actor_name: 'Public registration', action: 'register', detail: { team: team.id, name: team.name } }); return send(res, 201, { team }); }
      const user = official(req);
      if (!user) return send(res, 401, { error: 'Sign in to the tournament desk first.' });
      if (adminOnly.has(url.pathname) && user.role !== 'admin') return send(res, 403, { error: 'Only an event admin can do this.' });
      await change(() => {
        switch (url.pathname) {
          case '/api/checkin': checkIn(state, input); break;
          case '/api/draw': createDraw(state); break;
          case '/api/assign': assign(state, input.id, input.board); break;
          case '/api/start': start(state, input.id); break;
          case '/api/result': result(state, input.id, input, Date.now(), user.name); break;
          case '/api/correct-result': correctResult(state, input.id, input, Date.now(), user.name); break;
          case '/api/walkover': walkover(state, input.id, input.winner, input.reason, Date.now(), user.name); break;
          case '/api/undo-walkover': undoWalkover(state, input.id); break;
          case '/api/unassign': unassign(state, input.id); break;
          case '/api/board-ready': boardReady(state, input.board); break;
          case '/api/remove-team': removeTeam(state, input.id); break;
          case '/api/settings': updateSettings(state, input); log(state, 'Event settings updated'); break;
          case '/api/demo': state = loadSample(state); break;
          case '/api/reset': state = freshEvent(state, input.confirm); break;
          default: throw Object.assign(new Error('Endpoint not found.'), { status: 404 });
        }
      });
      store.audit({ actor_id: user.id, actor_name: user.name, action: url.pathname.slice(5), detail: auditDetail(input) });
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Endpoint not found.' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const pathname = url.pathname === '/' || !extname(url.pathname) ? '/index.html' : url.pathname;
    fail(pathname.includes('..') || !/^\/[a-zA-Z0-9/_.-]+$/.test(pathname), 'Invalid path.');
    const file = join(import.meta.dirname, 'public', pathname);
    if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(file));
  } catch (error) {
    // 404/409 carry a user-facing message; any other status is a database failure.
    const known = [404, 409].includes(error.status);
    if (error.status && !known) console.error(error.message);
    send(res, known ? error.status : error.status ? 502 : 400, { error: error.status && !known ? 'The tournament database is unavailable. Please try again.' : error.message || 'Something went wrong.' });
  }
});
server.listen(port, host, () => console.log(`CARROMIA running at http://localhost:${port}\nTournament desk: http://localhost:${port}/admin\n${supabase ? `Storage and sign-in: Supabase (${new URL(SUPABASE_URL).host})` : process.env.ADMIN_PASSWORD ? 'Custom admin password enabled.' : 'Local preview password: carromia-demo'}`));
