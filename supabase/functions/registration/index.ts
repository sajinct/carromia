// CARROMIA registration files (Supabase Edge Function "registration").
// Player photos and payment screenshots are kept in the private "team-files" Storage bucket, which
// browsers can't write to or read from without an official's sign-in. This function holds the
// service key and does the three things the public and the desk need:
// * register: checks the pictures, uploads them to team-files/<event>/<uuid>/ (a folder per team),
//   then registers the team, or a parish's teams with one payment, with register_teams() (which
//   checks the files exist). If registration fails, the files go.
// * team-form: for whoever knows the team's primary mobile number or its parish coordinator's
//   (team_form() checks it and counts wrong tries), the team's details and short-lived links to its
//   photo thumbnails.
// * group-form: the same for every team in a group registration, for the parish coordinator.
// * sweep: for a signed-in official, deletes files nothing points at any more (unreferenced_files()).
// Deploy: Dashboard -> Edge Functions -> Deploy a new function -> Via editor, name "registration",
// paste this file, and turn off "Enforce JWT verification" (visitors registering are not signed in).
// Plain JavaScript on purpose, so it can be pasted into the dashboard editor and tested in Node.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
// Mirrors maxPhotoLength and maxThumbLength in lib/tournament.mjs (a 4 MB picture as a data URL).
const maxPhoto = 5600000, maxThumb = 200000;
// Mirrors maxGroupTeams in lib/tournament.mjs.
const maxTeams = 8;
const photoMessage = 'Add a photo of each player (a JPEG under 4 MB).', shotMessage = 'Add the payment screenshot as a picture under 4 MB.';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
// A JPEG data URL as bytes, refused unless it really is a JPEG and small enough.
function jpegBytes(data, limit, message) {
  if (typeof data !== 'string' || data.length > limit || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) fail(400, message);
  const binary = atob(data.slice(data.indexOf(',') + 1)), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(400, message);
  return bytes;
}
const thumbPath = path => path.replace(/\.jpg$/, '-thumb.jpg');

export async function handle(req, env, fetchImpl = fetch) {
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { message: 'Use POST.' });
  const base = env.url.replace(/\/+$/, '');
  // New sb_secret keys go in the apikey header only; legacy service_role JWTs also as a bearer token.
  const service = { apikey: env.key, ...(env.key.startsWith('sb_') ? {} : { Authorization: `Bearer ${env.key}` }) };
  async function call(path, { method = 'GET', body, bytes, headers = {} } = {}) {
    const res = await fetchImpl(base + path, { method, headers: { ...service, 'Content-Type': bytes ? 'image/jpeg' : 'application/json', ...headers }, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text(); let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!res.ok) fail(res.status >= 500 ? 502 : res.status, value?.msg || value?.message || value?.error_description || `Request failed (${res.status}).`);
    return value;
  }
  const remove = paths => call('/storage/v1/object/team-files', { method: 'DELETE', body: { prefixes: paths } });
  try {
    let input;
    try { input = await req.json(); } catch { fail(400, 'Invalid request.'); }
    const event = input.p_event === 'practice' || input.event === 'practice' ? 'practice' : 'main';

    switch (input.action) {
      case 'register': {
        // One team (p_name, p_players, p_primary, p_lunch) or several from one parish (p_teams),
        // paid for together. Each team's photos go in a folder of its own; the screenshot in the first.
        const entries = Array.isArray(input.p_teams) ? input.p_teams : [{ name: input.p_name, players: input.p_players, primaryContact: input.p_primary, lunch: input.p_lunch }];
        if (!entries.length) fail(400, 'Add at least one team.');
        if (entries.length > maxTeams) fail(400, `Register up to ${maxTeams} teams at a time.`);
        if (entries.some(t => !Array.isArray(t?.players) || t.players.length !== 2)) fail(400, 'Enter exactly two players with valid mobile numbers.');
        // Every picture is checked before anything is uploaded.
        const folders = entries.map(() => `${event}/${crypto.randomUUID()}`), files = [];
        entries.forEach((t, j) => t.players.forEach((p, i) => files.push([`${folders[j]}/player-${i + 1}.jpg`, jpegBytes(p?.photo, maxPhoto, photoMessage)], [`${folders[j]}/player-${i + 1}-thumb.jpg`, jpegBytes(p?.thumb, maxThumb, photoMessage)])));
        const shot = input.p_payment?.screenshot ? jpegBytes(input.p_payment.screenshot, maxPhoto, shotMessage) : null;
        if (shot) files.push([`${folders[0]}/payment.jpg`, shot]);
        try {
          await Promise.all(files.map(([path, bytes]) => call(`/storage/v1/object/team-files/${path}`, { method: 'POST', bytes })));
          const body = {
            p_event: event, p_forane: input.p_forane, p_parish: input.p_parish, p_centre_type: input.p_centre_type, p_adults: input.p_adults, p_coordinator: input.p_coordinator ?? null,
            p_teams: entries.map((t, j) => ({ name: t.name, primaryContact: t.primaryContact, lunch: t.lunch, players: t.players.map((p, i) => ({ name: p?.name, mobile: p?.mobile, idType: p?.idType, idLast4: p?.idLast4, photo: `${folders[j]}/player-${i + 1}.jpg` })) })),
            p_payment: input.p_payment ? { txnRef: String(input.p_payment.txnRef ?? ''), screenshot: shot ? `${folders[0]}/payment.jpg` : '' } : null
          };
          const { teams } = await call('/rest/v1/rpc/register_teams', { method: 'POST', body });
          return reply(200, { teams, team: teams[0] });
        } catch (error) {
          await remove(files.map(([path]) => path)).catch(() => {});
          throw error;
        }
      }
      case 'team-form': {
        const form = await call('/rest/v1/rpc/team_form', { method: 'POST', body: { p_event: event, p_team_id: String(input.id ?? ''), p_mobile: String(input.mobile ?? '') } });
        if (form.error) return reply(200, { error: form.error });
        const thumbs = (form.photos || []).map(thumbPath);
        const signed = thumbs.length ? await call('/storage/v1/object/sign/team-files', { method: 'POST', body: { expiresIn: 600, paths: thumbs } }) : [];
        return reply(200, { team: form.team, photos: signed.map(s => s.signedURL ? `${base}/storage/v1${s.signedURL}` : '') });
      }
      case 'group-form': {
        const form = await call('/rest/v1/rpc/group_form', { method: 'POST', body: { p_event: event, p_group_id: String(input.id ?? ''), p_mobile: String(input.mobile ?? '') } });
        if (form.error) return reply(200, { error: form.error });
        const thumbs = form.teams.flatMap(t => (t.photos || []).map(thumbPath));
        const signed = thumbs.length ? await call('/storage/v1/object/sign/team-files', { method: 'POST', body: { expiresIn: 600, paths: thumbs } }) : [];
        // Links come back in the order the paths were sent.
        let next = 0;
        return reply(200, { teams: form.teams.map(t => ({ team: t.team, photos: (t.photos || []).map(() => { const s = signed[next++]; return s?.signedURL ? `${base}/storage/v1${s.signedURL}` : ''; }) })) });
      }
      case 'sweep': {
        const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) fail(401, 'Sign in to the tournament desk first.');
        let me;
        try { me = await call('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } }); } catch { fail(401, 'Your sign-in has expired. Please sign in again.'); }
        const [mine] = await call(`/rest/v1/officials?user_id=eq.${encodeURIComponent(me.id)}&select=role`);
        if (!mine) fail(403, 'This account is not a tournament official.');
        const files = await call('/rest/v1/rpc/unreferenced_files', { method: 'POST', body: {} }) || [];
        for (const bucket of new Set(files.map(f => f.bucket))) {
          const names = files.filter(f => f.bucket === bucket).map(f => f.name);
          for (let i = 0; i < names.length; i += 100) await call(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 100) } });
        }
        return reply(200, { deleted: files.length });
      }
      default: fail(400, 'Unknown action.');
    }
  } catch (error) {
    return reply(error.status || 500, { message: error.status ? error.message : 'Something went wrong. Please try again.' });
  }
}

if (typeof Deno !== 'undefined') Deno.serve(req => handle(req, { url: Deno.env.get('SUPABASE_URL'), key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }));
