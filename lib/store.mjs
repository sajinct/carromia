import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { publicState } from './tournament.mjs';

export class ConflictError extends Error {
  constructor() { super('The event was changed from another session. Your view has been refreshed; please try again.'); this.status = 409; }
}

// Local single-process storage: data/tournament.json, written atomically. Player photos are kept
// apart from the event in data/photos/<team id>.json.
export function fileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tournament.json'), photos = join(dir, 'photos'), payments = join(dir, 'payments');
  return {
    kind: 'file',
    async load() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
    async save(state) { writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${path}.tmp`, path); },
    async audit() {},
    async signIn() { return null; },
    async savePhotos(teamId, images) { mkdirSync(photos, { recursive: true }); writeFileSync(join(photos, `${teamId}.json`), JSON.stringify(images)); },
    async loadPhotos() { return existsSync(photos) ? Object.fromEntries(readdirSync(photos).filter(f => /^CAR-\d+\.json$/.test(f)).map(f => [f.slice(0, -5), JSON.parse(readFileSync(join(photos, f), 'utf8'))])) : {}; },
    // A team's photos, or every photo when no team is given.
    async deletePhotos(teamId) { for (const folder of [photos, payments]) rmSync(teamId ? join(folder, `${teamId}.json`) : folder, { recursive: true, force: true }); },
    // Payment screenshots, one file per pending team; deleted with the team's photos.
    async savePaymentProof(teamId, image) { mkdirSync(payments, { recursive: true }); writeFileSync(join(payments, `${teamId}.json`), JSON.stringify(image)); },
    async loadPaymentProofs() { return existsSync(payments) ? Object.fromEntries(readdirSync(payments).filter(f => /^CAR-\d+\.json$/.test(f)).map(f => [f.slice(0, -5), JSON.parse(readFileSync(join(payments, f), 'utf8'))])) : {}; }
  };
}

// Supabase storage: the event is one JSON row guarded by a version number, so a save only
// succeeds if nobody else saved since this process last loaded it (compare-and-swap).
// save_tournament also refreshes the public copy the GitHub Pages site reads.
// Rows of { team_id, player, image } as { [team id]: [photo 1, photo 2] }.
export function photoMap(rows) {
  const map = {};
  for (const r of rows || []) { map[r.team_id] ??= []; map[r.team_id][r.player] = r.image; }
  return map;
}

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
    async setPassword(id, password) { await call(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) }); },
    // Player photos: one row per player in player_photos (see the registration-details migration).
    async savePhotos(teamId, images) { await call('/rest/v1/player_photos', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(images.map((image, i) => ({ event: 'main', team_id: teamId, player: i, image }))) }); },
    async loadPhotos() { return photoMap(await call('/rest/v1/player_photos?event=eq.main&select=team_id,player,image')); },
    // The database deletes a team's photos and payment screenshot when the team leaves the saved event.
    async deletePhotos() {},
    async savePaymentProof(teamId, image) { await call('/rest/v1/payment_proofs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ event: 'main', team_id: teamId, image }) }); },
    async loadPaymentProofs() { return Object.fromEntries((await call('/rest/v1/payment_proofs?event=eq.main&select=team_id,image')).map(r => [r.team_id, r.image])); }
  };
}
