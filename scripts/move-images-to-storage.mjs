// Moves pictures saved in the database before Supabase Storage was used into Storage: player photos
// and payment screenshots into "team-files", and a UPI QR code saved in the event into "event-assets".
// Run once after 20261005000000_carromia_storage.sql, then run 20261006000000_carromia_storage_cleanup.sql.
// Usage: npm run move:images. Safe to re-run: only pictures not yet moved are touched.
// These pictures were already shrunk when they were taken, so a moved photo is its own thumbnail.
import { randomUUID } from 'node:crypto';
import { supabaseStore } from '../lib/store.mjs';
import { publicState, thumbPath } from '../lib/tournament.mjs';

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (see .env.example).');
const store = supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY), { call } = store;
const bytes = data => Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
const patch = (table, row, body) => call(`/rest/v1/${table}?event=eq.${row.event}&team_id=eq.${encodeURIComponent(row.team_id)}${row.player === undefined ? '' : `&player=eq.${row.player}`}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
// One new folder per team, shared by its photos and screenshot.
const folders = new Map();
const folder = row => { const key = `${row.event}/${row.team_id}`; if (!folders.has(key)) folders.set(key, `${row.event}/${randomUUID()}`); return folders.get(key); };

const photos = await call('/rest/v1/player_photos?path=is.null&image=not.is.null&select=event,team_id,player,image');
for (const row of photos) {
  const path = `${folder(row)}/player-${row.player + 1}.jpg`;
  for (const file of [path, thumbPath(path)]) await store.saveFile('team-files', file, bytes(row.image), 'image/jpeg');
  await patch('player_photos', row, { path, image: null });
}
const proofs = await call('/rest/v1/payment_proofs?path=is.null&image=not.is.null&select=event,team_id,image');
for (const row of proofs) {
  const path = `${folder(row)}/payment.jpg`;
  await store.saveFile('team-files', path, bytes(row.image), 'image/jpeg');
  await patch('payment_proofs', row, { path, image: null });
}

let qrs = 0;
for (const id of ['main', 'practice']) {
  const [row] = await call(`/rest/v1/tournament?id=eq.${id}&select=version,state`);
  const qr = row?.state?.event?.upiQr;
  if (!qr?.startsWith('data:')) continue;
  const png = qr.startsWith('data:image/png'), path = `${id}/upi-qr-${randomUUID()}.${png ? 'png' : 'jpg'}`;
  await store.saveFile('event-assets', path, bytes(qr), png ? 'image/png' : 'image/jpeg');
  const state = { ...row.state, event: { ...row.state.event, upiQr: `${SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/event-assets/${path}` } };
  await call('/rest/v1/rpc/save_tournament', { method: 'POST', body: JSON.stringify({ p_expected: row.version, p_state: state, p_public: publicState(state), p_action: 'move-upi-qr', p_id: id }) });
  qrs++;
}
console.log(`Moved ${photos.length} player photos, ${proofs.length} payment screenshots and ${qrs} UPI QR codes into Supabase Storage.`);
