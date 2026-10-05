// CARROMIA officials manager (Supabase Edge Function "officials").
// Lets an event admin list, add, update, reset the password of, and remove tournament officials
// from the app. Creating accounts and setting passwords need the Auth admin API, so this runs
// on Supabase with the service key, which never reaches the browser.
// Every request is checked here: the caller must be signed in and be an admin in public.officials.
// Deploy: Dashboard -> Edge Functions -> Deploy a new function -> Via editor, name "officials",
// paste this file, and turn off "Enforce JWT verification" (this code verifies the caller itself).
// Plain JavaScript on purpose, so it can be pasted into the dashboard editor and tested in Node.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
// As in lib/tournament.mjs: admins, officials, and the one-job roles. Umpires run the boards listed in `boards`.
const roles = ['admin', 'official', 'checkin', 'lunch', 'umpire', 'media'];

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function newPassword() { const bytes = crypto.getRandomValues(new Uint8Array(9)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, 'x').replace(/\//g, 'y').replace(/=+$/, ''); }

export async function handle(req, env, fetchImpl = fetch) {
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { message: 'Use POST.' });
  const base = env.url.replace(/\/+$/, '');
  // New sb_secret keys go in the apikey header only; legacy service_role JWTs also as a bearer token.
  const service = { apikey: env.key, ...(env.key.startsWith('sb_') ? {} : { Authorization: `Bearer ${env.key}` }) };
  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetchImpl(base + path, { method, headers: { ...service, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!res.ok) fail(res.status >= 500 ? 502 : res.status, value?.msg || value?.message || value?.error_description || `Request failed (${res.status}).`);
    return value;
  }
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) fail(401, 'Sign in to the tournament desk first.');
    let me;
    try { me = await call('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } }); } catch { fail(401, 'Your sign-in has expired. Please sign in again.'); }
    const [mine] = await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(me.id)}&select=name,role`);
    if (mine?.role !== 'admin') fail(403, 'Only an event admin can manage officials.');

    let input;
    try { input = await req.json(); } catch { fail(400, 'Invalid request.'); }
    const audit = (action, detail) => call('/rest/v1/audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: { actor_id: me.id, actor_name: mine.name, action: `officials:${action}`, detail } }).catch(() => {});
    const users = async () => (await call('/auth/v1/admin/users?page=1&per_page=1000')).users || [];
    const officialFor = async id => (await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(id)}&select=user_id,name,role,boards`))[0] || fail(404, 'Official not found.');
    const cleanName = value => { const name = String(value ?? '').trim().slice(0, 80); if (!name) fail(400, 'Enter the official’s name.'); return name; };
    const cleanRole = value => { if (!roles.includes(value)) fail(400, 'Choose a role.'); return value; };
    // Umpires and media managers need at least one assigned board; other roles have none.
    const cleanBoards = (role, value) => {
      if (!['umpire', 'media'].includes(role)) return [];
      const boards = [...new Set((Array.isArray(value) ? value : String(value ?? '').split(',')).map(b => String(b).trim()).filter(Boolean).map(Number))].sort((a, b) => a - b);
      if (!boards.length || boards.some(b => ![1, 2, 3, 4].includes(b))) fail(400, role === 'media' ? 'Choose the media manager’s boards, from 1 to 4.' : 'Choose the umpire’s boards, from 1 to 4.');
      return boards;
    };
    const cleanPassword = value => { const password = String(value ?? '').trim(); if (password && password.length < 8) fail(400, 'Passwords need at least 8 characters.'); return password; };

    switch (input.action) {
      case 'list': {
        const [officials, accounts] = await Promise.all([call('/rest/v1/officials?select=user_id,name,role,boards,created_at&order=created_at'), users()]);
        const byId = new Map(accounts.map(u => [u.id, u]));
        return reply(200, { officials: officials.map(o => ({ id: o.user_id, name: o.name, role: o.role, boards: o.boards || [], email: byId.get(o.user_id)?.email || '', lastSignIn: byId.get(o.user_id)?.last_sign_in_at || null, you: o.user_id === me.id })) });
      }
      case 'add': {
        const email = String(input.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
        const name = cleanName(input.name), role = cleanRole(input.role), boards = cleanBoards(role, input.boards);
        let password = cleanPassword(input.password), user = (await users()).find(u => u.email?.toLowerCase() === email);
        if (user) {
          // Existing account: keep its password unless a new one was given.
          if (password) await call(`/auth/v1/admin/users/${user.id}`, { method: 'PUT', body: { password } });
        } else {
          password ||= newPassword();
          user = await call('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
        }
        await call('/rest/v1/officials?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { user_id: user.id, name, role, boards } });
        await audit('add', { email, name, role, boards });
        return reply(200, { official: { id: user.id, name, role, boards, email }, password: password || null });
      }
      case 'update': {
        const current = await officialFor(input.id);
        const name = input.name === undefined ? current.name : cleanName(input.name), role = input.role === undefined ? current.role : cleanRole(input.role);
        const boards = cleanBoards(role, input.boards === undefined ? current.boards : input.boards);
        if (current.user_id === me.id && role !== 'admin') fail(400, 'You can’t remove your own admin role. Ask another admin.');
        await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(current.user_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { name, role, boards } });
        await audit('update', { id: current.user_id, name, role, boards });
        return reply(200, { ok: true });
      }
      case 'reset-password': {
        const current = await officialFor(input.id);
        const password = cleanPassword(input.password) || newPassword();
        await call(`/auth/v1/admin/users/${current.user_id}`, { method: 'PUT', body: { password } });
        await audit('reset-password', { id: current.user_id, name: current.name });
        return reply(200, { password });
      }
      case 'remove': {
        const current = await officialFor(input.id);
        if (current.user_id === me.id) fail(400, 'You can’t remove yourself. Ask another admin.');
        // Deleting the account also removes the official (on delete cascade) and signs them out.
        await call(`/auth/v1/admin/users/${current.user_id}`, { method: 'DELETE' });
        await audit('remove', { id: current.user_id, name: current.name });
        return reply(200, { ok: true });
      }
      default: fail(400, 'Unknown action.');
    }
  } catch (error) {
    return reply(error.status || 500, { message: error.status ? error.message : 'Something went wrong. Please try again.' });
  }
}

if (typeof Deno !== 'undefined') Deno.serve(req => handle(req, { url: Deno.env.get('SUPABASE_URL'), key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }));
