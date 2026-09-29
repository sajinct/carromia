import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { emptyState, addTeam, createDraw, assign, start, result, seedDemo, eligible, log, fail } from './lib/tournament.mjs';

const port = Number(process.env.PORT || 3000);
const password = process.env.ADMIN_PASSWORD || 'carromia-demo';
const dataDir = process.env.DATA_DIR || join(import.meta.dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const dataPath = join(dataDir, 'tournament.json');
let state = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : emptyState();
const sessions = new Map(), streams = new Set(), attempts = new Map();
const maxStreams = Number(process.env.MAX_STREAMS || 200);
function limited(key, max, windowMs) { const now = Date.now(); let a = attempts.get(key); if (!a || a.expires < now) attempts.set(key, a = { count: 0, expires: now + windowMs }); return ++a.count > max; }
setInterval(() => { const now = Date.now(); for (const map of [sessions, attempts]) for (const [key, value] of map) if ((value.expires ?? value) < now) map.delete(key); }, 600000).unref();
function save() { writeFileSync(`${dataPath}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${dataPath}.tmp`, dataPath); for (const stream of streams) stream.write('data: update\n\n'); }
function admin(req) { const token = /(?:^|;\s*)carromia_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; return sessions.get(token) > Date.now(); }
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new Error('Request too large.'); } return JSON.parse(text || '{}'); }
function view(isAdmin) {
  return { ...state, teams: state.teams.map(({ checkinToken, ...t }) => ({ ...t, players: t.players.map(p => isAdmin ? p : { name: p.name }) })), activity: isAdmin ? state.activity : [], matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m) })), isAdmin, localDemo: !process.env.ADMIN_PASSWORD, serverTime: Date.now() };
}
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
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
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, view(admin(req)));
    if (url.pathname === '/api/backup' && req.method === 'GET') { if (!admin(req)) return send(res, 401, { error: 'Sign in to download a backup.' }); return send(res, 200, state); }
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
        const a = Buffer.from(String(input.password || '')), b = Buffer.from(password);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 401, { error: 'Incorrect desk password.' });
        attempts.delete(key); const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 12 * 3600000);
        res.setHeader('Set-Cookie', `carromia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/logout') { const token = /carromia_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; sessions.delete(token); res.setHeader('Set-Cookie', 'carromia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/register') { if (limited(`register:${req.socket.remoteAddress}`, 30, 600000)) return send(res, 429, { error: 'Too many registrations from this connection. Try again in a few minutes.' }); fail(state.demo, 'Sample tournament is active. Start a fresh event from Settings to accept registrations.'); const team = addTeam(state, input); save(); return send(res, 201, { team }); }
      if (!admin(req)) return send(res, 401, { error: 'Sign in to the tournament desk first.' });
      const before = structuredClone(state);
      try {
        switch (url.pathname) {
          case '/api/checkin': { const team = state.teams.find(t => input.token ? t.checkinToken === input.token : t.id === input.id); fail(!team, 'Team not found. Check the QR code or team ID.'); fail(state.matches.some(m => ['called', 'playing', 'tiebreak'].includes(m.status) && [m.teamA, m.teamB].includes(team.id)) && input.checkedIn === false, 'This team is assigned to a board.'); team.checkedIn = input.checkedIn !== false; log(state, `${team.name} ${team.checkedIn ? 'checked in' : 'check-in removed'}`); break; }
          case '/api/draw': createDraw(state); break;
          case '/api/assign': assign(state, input.id, input.board); break;
          case '/api/start': start(state, input.id); break;
          case '/api/result': result(state, input.id, input); break;
          case '/api/unassign': { const m = state.matches.find(m => m.id === input.id); fail(!m || m.status !== 'called', 'Only a called match can be returned to the queue.'); m.status = 'ready'; m.board = null; log(state, `${m.id} returned to queue`); break; }
          case '/api/settings': { const e = state.event; for (const key of ['name', 'year', 'venue', 'date']) if (input[key] !== undefined) e[key] = String(input[key]).trim().slice(0, 120); fail(!e.name || !e.venue, 'Event name and venue are required.'); for (const [key, min, max] of [['durationMinutes', 1, 60], ['resetMinutes', 0, 30], ['restMinutes', 0, 60]]) { const n = Number(input[key]); fail(!Number.isInteger(n) || n < min || n > max, `Invalid value for ${key}.`); e[key] = n; } e.registrationOpen = state.matches.length ? false : Boolean(input.registrationOpen); log(state, 'Event settings updated'); break; }
          case '/api/demo': fail(state.teams.length > 0, 'Start a fresh event before loading sample teams.'); { const event = state.event; state = seedDemo(); state.event = { ...event, registrationOpen: false }; break; }
          case '/api/reset': fail(input.confirm !== 'RESET', 'Type RESET to start a fresh event.'); state = { ...emptyState(), event: { ...state.event, registrationOpen: true } }; break;
          default: return send(res, 404, { error: 'Endpoint not found.' });
        }
        save(); return send(res, 200, { ok: true });
      } catch (error) { state = before; throw error; }
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Endpoint not found.' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const pathname = url.pathname === '/' || !extname(url.pathname) ? '/index.html' : url.pathname;
    fail(pathname.includes('..') || !/^\/[a-zA-Z0-9/_.-]+$/.test(pathname), 'Invalid path.');
    const file = join(import.meta.dirname, 'public', pathname);
    if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(file));
  } catch (error) { send(res, 400, { error: error.message || 'Something went wrong.' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`CARROMIA running at http://localhost:${port}\nTournament desk: http://localhost:${port}/admin\n${process.env.ADMIN_PASSWORD ? 'Custom admin password enabled.' : 'Local preview password: carromia-demo'}`));
