import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { fileStore, supabaseStore, ConflictError } from './lib/store.mjs';
import { emptyState, addTeams, playerPhotos, paymentProof, teamForm, groupForm, publicTeam, publicState, eligible, fail, actions, refusal, checkBoard, teamsFor, fileRoles, registrationStatus, defaults, shareRoutes, teamFiles, thumbPath, teamFilePath, assetPath, upiQrImage, maxGroupTeams, maxPhotoLength, maxThumbLength, maxScreenshotLength, submitGallery } from './lib/tournament.mjs';

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
async function official(req) { const token = /(?:^|;\s*)carromia_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; const session = sessions.get(token); if (!(session?.expires > Date.now())) return null; return supabase ? store.officialProfile(session.user) : session.user; }
function signIn(res, user) {
  const token = randomBytes(32).toString('hex'); sessions.set(token, { expires: Date.now() + 12 * 3600000, user });
  res.setHeader('Set-Cookie', `carromia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`);
}
const auditDetail = ({ token, confirm, password, ...input }) => input;
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req, limit = 20000) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > limit) throw new Error('Request too large.'); } return JSON.parse(text || '{}'); }
function view(user) {
  const isAdmin = Boolean(user);
  return { ...(isAdmin ? state : publicState(state)), event: { ...defaults, ...state.event }, teams: isAdmin ? teamsFor(state.teams, user.role) : state.teams.map(publicTeam), activity: isAdmin ? state.activity : [], matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m) })), registration: registrationStatus(state), isAdmin, user: user && { name: user.name, role: user.role, boards: user.boards || [] }, authMode: supabase ? 'supabase' : 'password', localDemo: !supabase && !process.env.ADMIN_PASSWORD, serverTime: Date.now() };
}
// Pictures arrive as data URLs and are stored as files; the desk reads them through /api/files.
// A team's QR code: the check-in desk's, or the lunch counter's on its lunch coupons.
const teamQr = (token, route) => QRCode.toDataURL(`${process.env.PUBLIC_URL || `http://localhost:${port}`}${route}?token=${token}`, { width: 240, margin: 2, color: { dark: '#172d2c', light: '#ffffff' } });
const bytes = data => Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
// The largest registration: a full group's photos and thumbnails, a screenshot, and the details.
const registerLimit = maxGroupTeams * 2 * (maxPhotoLength + maxThumbLength) + maxScreenshotLength + 400000;
const fileUrl = path => `/api/files/team-files/${path}`;
async function sendFile(res, bucket, path, cache) {
  const file = await store.readFile(bucket, path); if (!file) return send(res, 404, { error: 'File not found.' });
  res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': cache }); res.end(file.bytes);
}
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.facebook.com https://www.instagram.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (streams.size >= maxStreams) return send(res, 503, { error: 'Too many live connections. Updates will continue by polling.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); streams.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000); req.on('close', () => { clearInterval(heartbeat); streams.delete(res); }); return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, view(await official(req)));
    if (url.pathname === '/api/backup' && req.method === 'GET') { const user = await official(req); if (!user) return send(res, 401, { error: 'Sign in to download a backup.' }); if (user.role !== 'admin') return send(res, 403, { error: 'Only an event admin can download backups.' }); return send(res, 200, state); }
    // The UPI QR code is public; a team's photos and payment screenshot are for officials only.
    if (url.pathname.startsWith('/api/assets/') && req.method === 'GET') { const path = url.pathname.slice(12); if (!assetPath.test(path)) return send(res, 404, { error: 'File not found.' }); return sendFile(res, 'event-assets', path, 'public, max-age=86400, immutable'); }
    if (['/api/payment-proofs', '/api/photos', '/api/photo-full'].includes(url.pathname) || url.pathname.startsWith('/api/files/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      const user = await official(req);
      if (!user) return send(res, 401, { error: 'Sign in to the tournament desk first.' });
      // Payment screenshots are for admins and officials; player photos also for the check-in desk.
      const kind = url.pathname === '/api/payment-proofs' || url.pathname.endsWith('/payment.jpg') ? 'payments' : 'photos';
      if (!fileRoles[kind].includes(user.role)) return send(res, 403, { error: kind === 'payments' ? 'Payment screenshots are for event admins and officials.' : 'Player photos are for the check-in desk, officials and admins.' });
      if (url.pathname === '/api/payment-proofs') return send(res, 200, Object.fromEntries(Object.entries(await store.loadPaymentProofs()).map(([id, path]) => [id, fileUrl(path)])));
      // Thumbnails for lists: { [team id]: [photo 1, photo 2] }; the full photo is asked for one at a time.
      if (url.pathname === '/api/photos') return send(res, 200, Object.fromEntries(Object.entries(await store.loadPhotos()).map(([id, paths]) => [id, paths.map(p => p && fileUrl(thumbPath(p)))])));
      if (url.pathname === '/api/photo-full') { const path = (await store.loadPhotos())[url.searchParams.get('team')]?.[Number(url.searchParams.get('player'))]; return path ? send(res, 200, { url: fileUrl(path) }) : send(res, 404, { error: 'No photo for this player.' }); }
      const path = url.pathname.slice('/api/files/team-files/'.length);
      if (!url.pathname.startsWith('/api/files/team-files/') || !teamFilePath.test(path)) return send(res, 404, { error: 'File not found.' });
      return sendFile(res, 'team-files', path, 'private, max-age=3600');
    }
    if (url.pathname === '/api/qr' && req.method === 'GET') {
      const t = state.teams.find(t => t.checkinToken === url.searchParams.get('token')); if (!t) return send(res, 404, { error: 'Team not found.' });
      return send(res, 200, { qr: await teamQr(t.checkinToken, url.searchParams.get('for') === 'lunch' ? '/lunch' : '/checkin') });
    }
    if (url.pathname === '/api/upi-payment-qr' && req.method === 'GET') {
      const uri = url.searchParams.get('uri') || '';
      if (uri.length > 1024 || !/^upi:\/\/pay\?pa=[\w.@-]+&pn=[\w%.~'()*!-]*(&mc=\d{4}&tr=[A-Za-z0-9]{1,35})?&am=\d+\.\d{2}&cu=INR$/.test(uri)) return send(res, 400, { error: 'Invalid UPI payment link.' });
      return send(res, 200, { qr: await QRCode.toDataURL(uri, { width: 440, margin: 4, color: { dark: '#000000', light: '#ffffff' } }) });
    }
    if (url.pathname === '/api/link-qr' && req.method === 'GET') {
      const route = url.searchParams.get('route'); if (!shareRoutes.includes(route)) return send(res, 404, { error: 'Page not found.' });
      const link = `${process.env.PUBLIC_URL || `http://localhost:${port}`}${route}`;
      return send(res, 200, { url: link, qr: await QRCode.toDataURL(link, { width: 320, margin: 2, color: { dark: '#172d2c', light: '#ffffff' } }) });
    }
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== process.env.PUBLIC_URL) return send(res, 403, { error: 'Origin not allowed.' });
      // Registration carries two player photos (each with a thumbnail) and a payment screenshot.
      const input = await body(req, { '/api/register': registerLimit, '/api/upi-qr': 7100000, '/api/settings': 300000 }[url.pathname] ?? 20000);
      if (url.pathname === '/api/gallery-submit') {
        if (limited(`gallery:${req.socket.remoteAddress}`, 8, 600000)) return send(res, 429, { error: 'Too many links from this connection. Try again in 10 minutes.' });
        await change(() => submitGallery(state, input));
        return send(res, 201, { ok: true });
      }
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
      if (url.pathname === '/api/register') {
        if (limited(`register:${req.socket.remoteAddress}`, 30, 600000)) return send(res, 429, { error: 'Too many registrations from this connection. Try again in a few minutes.' });
        // One team, or several from one parish paid for together (input.teams). The screenshot is kept
        // once, in the first team's folder, and every team in the group points at it.
        const entries = Array.isArray(input.teams) ? input.teams : [input], photos = entries.map(t => playerPhotos(t)), proof = paymentProof(input);
        const teams = await change(() => { fail(state.demo, 'Sample tournament is active. Start a fresh event from Settings to accept registrations.'); return addTeams(state, { ...input, teams: entries }); });
        const folders = teams.map(() => teamFiles(`main/${randomUUID()}`));
        await Promise.all(teams.flatMap((team, j) => photos[j].flatMap((p, i) => [store.saveFile('team-files', folders[j].photos[i], bytes(p.photo), 'image/jpeg'), store.saveFile('team-files', thumbPath(folders[j].photos[i]), bytes(p.thumb), 'image/jpeg')])));
        for (const [j, team] of teams.entries()) await store.savePhotos(team.id, folders[j].photos);
        if (proof && teams[0].status === 'pending') { await store.saveFile('team-files', folders[0].payment, bytes(proof), 'image/jpeg'); for (const team of teams) await store.savePaymentProof(team.id, folders[0].payment); }
        for (const team of teams) store.audit({ actor_name: 'Public registration', action: 'register', detail: { team: team.id, name: team.name, ...(team.group ? { group: team.group.id } : {}) } });
        return send(res, 201, { teams, team: teams[0] });
      }
      // A team's registration form, for whoever knows its primary player's or parish coordinator's
      // mobile number, or every form in a group for the coordinator.
      if (url.pathname === '/api/team-form' || url.pathname === '/api/group-form') {
        const id = String(input.id ?? '').trim().toUpperCase();
        if (limited(`form:${req.socket.remoteAddress}`, 10, 600000) || limited(`form:${id}`, 10, 600000)) return send(res, 429, { error: 'Too many tries. Try again in 10 minutes.' });
        const saved = await store.loadPhotos();
        const formFor = async ({ checkinToken, ...team }) => {
          const [qr, lunchQr] = await Promise.all([teamQr(checkinToken, '/checkin'), team.lunch ? teamQr(checkinToken, '/lunch') : '']);
          // The thumbnails, inline, for the form's photo boxes.
          const photos = await Promise.all((saved[team.id] || []).map(async p => { const file = p && await store.readFile('team-files', thumbPath(p)); return file ? `data:image/jpeg;base64,${file.bytes.toString('base64')}` : ''; }));
          return { team, qr, lunchQr, photos };
        };
        if (url.pathname === '/api/team-form') return send(res, 200, await formFor(teamForm(state, id, input.mobile)));
        return send(res, 200, { forms: await Promise.all(groupForm(state, id, input.mobile).map(formFor)) });
      }
      const user = await official(req);
      if (!user) return send(res, 401, { error: 'Sign in to the tournament desk first.' });
      if (url.pathname === '/api/change-password') {
        if (!supabase) return send(res, 400, { error: 'The desk password is set with ADMIN_PASSWORD when the server starts.' });
        if (limited(`password:${user.id}`, 5, 60000)) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
        const current = String(input.current || ''), next = String(input.password || '');
        if (next.length < 8) return send(res, 400, { error: 'Passwords need at least 8 characters.' });
        if (next === current) return send(res, 400, { error: 'Choose a new password that is different from your current one.' });
        if (!await store.signIn(user.email, current)) return send(res, 401, { error: 'Your current password is incorrect.' });
        try { await store.setPassword(user.id, next); }
        catch (error) { if (error.status !== 422) throw error; return send(res, 400, { error: 'This password was not accepted. Choose a longer or less common one.' }); }
        store.audit({ actor_id: user.id, actor_name: user.name, action: 'change-password' }); return send(res, 200, { ok: true });
      }
      // The UPI QR code for Event settings, saved as a public file; settings then keep its address.
      if (url.pathname === '/api/upi-qr') {
        if (user.role !== 'admin') return send(res, 403, { error: 'Only an event admin can do this.' });
        const path = `main/upi-qr-${randomUUID()}.png`; await store.saveFile('event-assets', path, bytes(upiQrImage(input)), 'image/png');
        return send(res, 200, { url: `/api/assets/${path}` });
      }
      const action = actions[url.pathname.slice(5)];
      if (!action) return send(res, 404, { error: 'Endpoint not found.' });
      const refused = refusal(action, user); if (refused) return send(res, 403, { error: refused });
      await change(() => { checkBoard(state, input, user); const next = action.run(state, input, { now: Date.now(), official: user.name }); if (next) state = next; });
      // Photos go with their team: a removed team's, or every one when a fresh event starts.
      try {
        if (url.pathname === '/api/remove-team') await store.deletePhotos(String(input.id));
        if (url.pathname === '/api/reset') await store.deletePhotos();
      } catch (error) { console.error(`Deleting files failed: ${error.message}`); }
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
