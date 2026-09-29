import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { publicState } from './tournament.mjs';

export class ConflictError extends Error {
  constructor() { super('The event was changed from another session. Your view has been refreshed; please try again.'); this.status = 409; }
}

// Local single-process storage: data/tournament.json, written atomically.
export function fileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tournament.json');
  return {
    kind: 'file',
    async load() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
    async save(state) { writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${path}.tmp`, path); },
    async audit() {},
    async signIn() { return null; }
  };
}

// Supabase storage: the event is one JSON row guarded by a version number, so a save only
// succeeds if nobody else saved since this process last loaded it (compare-and-swap).
// save_tournament also refreshes the public copy the GitHub Pages site reads.
export function supabaseStore(url, key) {
  const base = url.replace(/\/+$/, '');
  // New sb_ keys go in the apikey header only; legacy JWT keys also need a bearer token.
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }) };
  async function call(path, init = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await res.text(); let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (res.status === 409) throw new ConflictError();
    if (!res.ok) throw Object.assign(new Error(`Supabase ${res.status}: ${value?.message || value?.msg || value?.error_description || text}`), { status: res.status });
    return value;
  }
  let version = 0;
  return {
    kind: 'supabase',
    call,
    async load() {
      const [row] = await call('/rest/v1/tournament?id=eq.main&select=version,state');
      version = row?.version ?? 0; return row?.state ?? null;
    },
    async save(state) {
      version = await call('/rest/v1/rpc/save_tournament', { method: 'POST', body: JSON.stringify({ p_expected: version, p_state: state, p_public: publicState(state) }) });
    },
    async audit(entry) {
      try { await call('/rest/v1/audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(entry) }); }
      catch (error) { console.error(`Audit log write failed: ${error.message}`); }
    },
    // Returns the official's profile, or null for a wrong password or a non-official account.
    async signIn(email, password) {
      const res = await fetch(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers, body: JSON.stringify({ email, password }) });
      if (!res.ok) return null;
      const { user } = await res.json();
      const [official] = await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(user.id)}&select=name,role`);
      return official ? { id: user.id, email: user.email, name: official.name, role: official.role } : null;
    },
    async setPassword(id, password) { await call(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) }); }
  };
}
