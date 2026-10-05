import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { publicState, thumbPath } from './tournament.mjs';

export class ConflictError extends Error {
  constructor() { super('The event was changed from another session. Your view has been refreshed; please try again.'); this.status = 409; }
}

// Local single-process storage: data/tournament.json, written atomically. Photos and payment
// screenshots are files in data/uploads/<bucket>/<path>; data/photos/<team id>.json and
// data/payments/<team id>.json hold the paths of a team's files.
export function fileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tournament.json'), photos = join(dir, 'photos'), payments = join(dir, 'payments'), uploads = join(dir, 'uploads');
  const readAll = folder => existsSync(folder) ? Object.fromEntries(readdirSync(folder).filter(f => /^CAR-\d+\.json$/.test(f)).map(f => [f.slice(0, -5), JSON.parse(readFileSync(join(folder, f), 'utf8'))])) : {};
  const readOne = (folder, teamId) => existsSync(join(folder, `${teamId}.json`)) ? JSON.parse(readFileSync(join(folder, `${teamId}.json`), 'utf8')) : null;
  return {
    kind: 'file',
    async load() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
    async save(state) { writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${path}.tmp`, path); },
    async audit() {},
    async signIn() { return null; },
    async saveFile(bucket, file, bytes) { const target = join(uploads, bucket, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); },
    async readFile(bucket, file) { const target = join(uploads, bucket, file); return existsSync(target) ? { bytes: readFileSync(target), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg' } : null; },
    async savePhotos(teamId, paths) { mkdirSync(photos, { recursive: true }); writeFileSync(join(photos, `${teamId}.json`), JSON.stringify(paths)); },
    async loadPhotos() { return readAll(photos); },
    // A team's photos and payment screenshot, or every one when no team is given.
    async deletePhotos(teamId) {
      if (!teamId) {
        for (const folder of [photos, payments, join(uploads, 'team-files')]) rmSync(folder, { recursive: true, force: true });
        return;
      }
      const files = [...(readOne(photos, teamId) || []).flatMap(p => [p, thumbPath(p)]), readOne(payments, teamId)].filter(Boolean);
      for (const file of files) rmSync(join(uploads, 'team-files', file), { force: true });
      for (const folder of [photos, payments]) rmSync(join(folder, `${teamId}.json`), { force: true });
    },
    // Payment screenshots, one per pending team; deleted with the team's photos.
    async savePaymentProof(teamId, file) { mkdirSync(payments, { recursive: true }); writeFileSync(join(payments, `${teamId}.json`), JSON.stringify(file)); },
    async loadPaymentProofs() { return readAll(payments); }
  };
}

// Supabase storage: the event is one JSON row guarded by a version number, so a save only
// succeeds if nobody else saved since this process last loaded it (compare-and-swap).
// save_tournament also refreshes the public copy the GitHub Pages site reads.
// Rows of { team_id, player, path } as { [team id]: [photo 1, photo 2] }.
export function photoMap(rows) {
  const map = {};
  for (const r of rows || []) if (r.path) { map[r.team_id] ??= []; map[r.team_id][r.player] = r.path; }
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
    // Refresh roles and assignments for existing sessions; removed accounts lose desk access.
    async officialProfile(user) {
      const [profile] = await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(user.id)}&select=name,role,boards`);
      return profile ? { ...user, ...profile, boards: profile.boards || [] } : null;
    },
    // Returns the official's profile, or null for a wrong password or a non-official account.
    async signIn(email, password) {
      const res = await fetch(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers, body: JSON.stringify({ email, password }) });
      if (!res.ok) return null;
      const { user } = await res.json();
      const [official] = await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(user.id)}&select=name,role,boards`);
      return official ? { id: user.id, email: user.email, name: official.name, role: official.role, boards: official.boards || [] } : null;
    },
    async setPassword(id, password) { await call(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) }); },
    // Files in Supabase Storage (see the storage migration for the buckets).
    async saveFile(bucket, file, bytes, type) { await call(`/storage/v1/object/${bucket}/${file}`, { method: 'POST', headers: { 'Content-Type': type, 'x-upsert': 'true' }, body: bytes }); },
    async readFile(bucket, file) {
      const { 'Content-Type': _, ...auth } = headers;
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${file}`, { headers: auth });
      if ([400, 404].includes(res.status)) return null;
      if (!res.ok) throw Object.assign(new Error(`Supabase ${res.status}: ${await res.text()}`), { status: res.status });
      return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
    },
    // Player photos: one row per player in player_photos, with the path of the photo's file.
    async savePhotos(teamId, paths) { await call('/rest/v1/player_photos', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(paths.map((path, i) => ({ event: 'main', team_id: teamId, player: i, path }))) }); },
    async loadPhotos() { return photoMap(await call('/rest/v1/player_photos?event=eq.main&select=team_id,player,path')); },
    // The database deletes a team's rows when the team leaves the saved event; this then deletes the
    // files nothing points at any more (older than an hour, so registrations in progress are safe).
    async deletePhotos() {
      const files = await call('/rest/v1/rpc/unreferenced_files', { method: 'POST', body: '{}' }) || [];
      for (const bucket of new Set(files.map(f => f.bucket))) {
        const names = files.filter(f => f.bucket === bucket).map(f => f.name);
        for (let i = 0; i < names.length; i += 100) await call(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: JSON.stringify({ prefixes: names.slice(i, i + 100) }) });
      }
    },
    async savePaymentProof(teamId, path) { await call('/rest/v1/payment_proofs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ event: 'main', team_id: teamId, path }) }); },
    async loadPaymentProofs() { return Object.fromEntries((await call('/rest/v1/payment_proofs?event=eq.main&select=team_id,path')).filter(r => r.path).map(r => [r.team_id, r.path])); }
  };
}
