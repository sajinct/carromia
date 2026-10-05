import { randomUUID, randomInt } from 'node:crypto';
import { findCentre, idTypes } from '../public/parishes.js';
import { socialLink, publicMedia } from '../public/social.js';
import { registrationCutoff, registrationDeadlineText } from '../public/event-deadline.js';

export const defaults = { name: 'CARROMIA', year: '2026', venue: 'St Claret’s Hall, Mary Matha Church, Vijayanagar', date: '2026-11-15', startTime: '09:45', gamesPerMatch: 3, gameMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true, maxTeams: 64, maxTeamsPerParish: 4, registrationDeadline: '2026-11-10', registrationDeadlineTime: '24:00', entryFee: 500, lunchCoupons: false };
// Events saved before a setting existed use its default.
export const setting = (state, key) => state.event[key] ?? defaults[key];
export function emptyState() { return { version: 1, event: { ...defaults }, teams: [], matches: [], boards: [1, 2, 3, 4].map(id => ({ id, availableAt: 0 })), activity: [], demo: false }; }
export function log(state, message, now = Date.now()) { state.activity.unshift({ id: randomUUID(), message, at: now }); state.activity = state.activity.slice(0, 80); }
export function fail(condition, message) { if (condition) throw new Error(message); }
// A match that occupies a board right now.
export const isLive = m => ['called', 'playing'].includes(m.status);
const teamName = (state, id) => state.teams.find(t => t.id === id)?.name ?? id;
// "St. Thomas", "st thomas" and "St Thomas Church" count as the same parish.
export const parishKey = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(church|parish)\b/g, ' ').replace(/\s+/g, ' ').trim();
// Whether teams can register right now, and if not, why. The configured cutoff is in India
// and applies to the real event only, so registration can still be rehearsed in practice.
export function registrationStatus(state, now = Date.now()) {
  const maxTeams = setting(state, 'maxTeams'), deadline = setting(state, 'registrationDeadline'), slotsLeft = Math.max(0, maxTeams - state.teams.length);
  const deadlineEvent = { ...state.event, registrationDeadline: deadline };
  const reason = !state.event.registrationOpen || state.matches.length > 0 ? 'Registration is closed for this draw.'
    : deadline && !state.practice && now >= registrationCutoff(deadlineEvent) ? `Registration closed on ${registrationDeadlineText(deadlineEvent, { day: 'numeric', month: 'long', year: 'numeric' })}.`
    : slotsLeft === 0 ? `All ${maxTeams} team slots are taken. Registration is full.` : '';
  return { open: !reason, reason, slotsLeft, maxTeams };
}
// Player photos are made in the browser as a high-quality JPEG (up to 2000px) and a small thumbnail
// for lists and the registration form. Both are stored as files, apart from the event.
export const maxPhotoLength = 5600000, maxThumbLength = 200000;
const jpegData = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
export function playerPhotos(input) {
  const photos = (input.players || []).map(p => ({ photo: String(p?.photo ?? ''), thumb: String(p?.thumb ?? '') }));
  fail(photos.length !== 2 || photos.some(p => !jpegData.test(p.photo) || p.photo.length > maxPhotoLength || !jpegData.test(p.thumb) || p.thumb.length > maxThumbLength), 'Add a photo of each player (a JPEG under 4 MB).');
  return photos;
}
// Where a registration's files live (the "team-files" bucket): one folder per registration, named
// with a random UUID, holding each player's photo and thumbnail and the payment screenshot.
export const teamFilePath = /^(main|practice)\/[0-9a-f-]{36}\/(player-[12](-thumb)?|payment)\.jpg$/;
export const teamFiles = folder => ({ photos: [`${folder}/player-1.jpg`, `${folder}/player-2.jpg`], payment: `${folder}/payment.jpg` });
export const thumbPath = path => path.replace(/\.jpg$/, '-thumb.jpg');
// The UPI QR code is a public file (the "event-assets" bucket); the event keeps its address.
export const assetPath = /^(main|practice)\/upi-qr-[0-9a-f-]{36}\.(png|jpg)$/;
export const maxUpiQrLength = 7000000;
export function upiQrImage(input) {
  const image = String(input.image ?? '');
  fail(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > maxUpiQrLength, 'Upload the UPI QR code as a PNG or JPEG picture under 5 MB.');
  return image;
}
const upiQrUrl = /^(https:\/\/[a-z0-9.-]+\/storage\/v1\/object\/public\/event-assets\/|\/api\/assets\/)(main|practice)\/upi-qr-[0-9a-f-]{36}\.(png|jpg)$/;
// A QR code saved as a picture in the event before files were used.
const legacyUpiQr = qr => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(qr) && qr.length <= 150000;
// When the event collects payment at registration, a team gives the UPI transaction number and/or
// a screenshot and stays pending until the desk confirms the money arrived. The screenshot is kept
// apart from the event, like player photos. Teams saved before payments existed count as confirmed.
export const maxScreenshotLength = maxPhotoLength;
// Public pages a screen can show a QR code for, such as the live display's "scan for results".
export const shareRoutes = ['/results', '/live', '/gallery/submit'];
export const isConfirmed = team => team.status !== 'pending';
export function paymentProof(input) {
  const shot = String(input.payment?.screenshot ?? '');
  fail(shot !== '' && (!jpegData.test(shot) || shot.length > maxScreenshotLength), 'Add the payment screenshot as a picture under 4 MB.');
  return shot;
}
// A registration is one or more teams from the same parish, paid for together. A group of two or
// more teams names a parish coordinator, whose mobile number can download every team's form. Each
// team keeps its own ID, check-in QR and place in the draw, and carries group = { id, size,
// coordinator } (id: the first team's ID) and the same payment. Everything is checked before
// anything changes.
export const mobilePattern = /^\+?[\d\s()-]{7,20}$/;
export const maxGroupTeams = 8;
export function addTeams(state, input, now = Date.now()) {
  const status = registrationStatus(state, now); fail(!status.open, status.reason);
  const clean = (s, limit = 80) => String(s ?? '').trim().slice(0, limit);
  const centre = findCentre(input.forane, input.parish, input.centreType);
  const entries = Array.isArray(input.teams) ? input.teams : [];
  fail(!entries.length, 'Add at least one team.');
  fail(entries.length > maxGroupTeams, `Register up to ${maxGroupTeams} teams at a time.`);
  const teams = entries.map(t => ({ id: '', name: clean(t?.name), forane: centre?.group ?? '', parish: centre?.name ?? '', centreType: centre?.type ?? '', players: (Array.isArray(t?.players) ? t.players : []).map(p => ({ name: clean(p?.name), mobile: clean(p?.mobile, 20), idType: idTypes.includes(p?.idType) ? p.idType : '', idLast4: clean(p?.idLast4, 4).toUpperCase() })), primaryContact: Number(t?.primaryContact) === 1 ? 1 : 0, lunch: Math.min(2, Math.max(0, Math.trunc(Number(t?.lunch)) || 0)), checkedIn: false, registeredAt: now, checkinToken: randomUUID() }));
  fail(teams.some(t => !t.name), 'Enter a team name.');
  fail(!centre, 'Choose your forane or zone, then your parish or centre from the list.');
  fail(teams.some(t => t.players.length !== 2 || t.players.some(p => !p.name || !mobilePattern.test(p.mobile))), 'Enter exactly two players with valid mobile numbers.');
  fail(teams.some(t => t.players.some(p => !p.idType || !/^[A-Z0-9]{4}$/.test(p.idLast4))), 'Choose each player’s ID proof and enter the last 4 letters or digits of its number.');
  for (const [i, team] of teams.entries()) {
    fail(state.teams.some(t => t.name.toLowerCase() === team.name.toLowerCase()), teams.length > 1 ? `The team name “${team.name}” is already registered.` : 'That team name is already registered.');
    fail(teams.slice(0, i).some(t => t.name.toLowerCase() === team.name.toLowerCase()), `Give each team a different name: “${team.name}” is used twice.`);
  }
  fail(input.adults !== true, teams.length > 1 ? 'Confirm that all players are 18 or older.' : 'Confirm that both players are 18 or older.');
  fail(teams.length > status.slotsLeft, `Only ${status.slotsLeft} team slot${status.slotsLeft === 1 ? ' is' : 's are'} left.`);
  const perParish = setting(state, 'maxTeamsPerParish'), already = state.teams.filter(t => parishKey(t.parish) === parishKey(centre.name)).length;
  fail(already >= perParish, `${centre.name} already has ${perParish} teams registered, the most allowed for one parish.`);
  fail(already + teams.length > perParish, `${centre.name} can register ${perParish - already} more team${perParish - already === 1 ? '' : 's'} (up to ${perParish} for one parish).`);
  let coordinator = null;
  if (teams.length > 1) {
    coordinator = { name: clean(input.coordinator?.name), mobile: clean(input.coordinator?.mobile, 20) };
    fail(!coordinator.name || !mobilePattern.test(coordinator.mobile), 'Enter the parish coordinator’s name and a valid mobile number.');
  }
  let payment = null;
  if (state.event.paymentRequired) {
    const txnRef = clean(input.payment?.txnRef, 30).replace(/\s+/g, '').toUpperCase(), screenshot = Boolean(paymentProof(input));
    fail(txnRef && !/^[A-Z0-9]{6,30}$/.test(txnRef), 'Enter the UPI transaction number (UTR) as shown in your payment app: 6 to 30 letters or digits.');
    fail(!txnRef && !screenshot, 'Enter the UPI transaction number or add a payment screenshot.');
    payment = { amount: setting(state, 'entryFee') * teams.length, txnRef, screenshot, ...(teams.length > 1 ? { teams: teams.length } : {}) };
  }
  for (const team of teams) {
    team.id = nextTeamId(state);
    team.status = payment ? 'pending' : 'confirmed';
    if (payment) team.payment = { ...payment };
    if (coordinator) team.group = { id: teams[0].id, size: teams.length, coordinator: { ...coordinator } };
    state.teams.push(team);
  }
  const pending = payment ? ' (payment to be confirmed)' : '';
  log(state, teams.length > 1 ? `${centre.name} registered ${teams.length} teams (${teams.map(t => t.name).join(', ')})${pending}` : `${teams[0].name} registered${pending}`, now);
  return teams;
}
export const addTeam = (state, input, now = Date.now()) => addTeams(state, { ...input, teams: [input] }, now)[0];
// The teams registered together with this one (just the team itself if it registered alone).
export const groupTeams = (state, team) => team.group ? state.teams.filter(t => t.group?.id === team.group.id) : [team];
// A confirmed team's full details, for its registration form, when the caller knows the primary
// player's or the parish coordinator's mobile number (compared on the last 10 digits).
export const mobileKey = mobile => String(mobile ?? '').replace(/\D/g, '').slice(-10);
const mobileMatches = (mobile, ...known) => mobileKey(mobile).length === 10 && known.some(k => mobileKey(k) === mobileKey(mobile));
export function teamForm(state, id, mobile) {
  const team = state.teams.find(t => t.id === String(id ?? '').trim().toUpperCase());
  fail(!team, 'Team not found.');
  fail(!isConfirmed(team), 'This team’s payment is still being verified. The form can be downloaded once the desk confirms it.');
  fail(!mobileMatches(mobile, team.players[team.primaryContact]?.mobile, team.group?.coordinator?.mobile), 'That mobile number doesn’t match this team’s primary contact or parish coordinator.');
  return team;
}
// Every team in a group, for one PDF of all their forms, for the parish coordinator.
export function groupForm(state, id, mobile) {
  const groupId = String(id ?? '').trim().toUpperCase(), teams = state.teams.filter(t => t.group?.id === groupId);
  fail(!teams.length, 'Group registration not found.');
  fail(teams.some(t => !isConfirmed(t)), 'This group’s payment is still being verified. The forms can be downloaded once the desk confirms it.');
  fail(!mobileMatches(mobile, teams[0].group.coordinator?.mobile), 'That mobile number doesn’t match the parish coordinator’s.');
  return teams;
}
// Confirms a team's payment, and with it every team paid for in the same registration.
export function confirmPayment(state, id, now = Date.now(), official = 'Tournament desk') {
  const team = state.teams.find(t => t.id === id); fail(!team, 'Team not found.');
  fail(isConfirmed(team), `${team.name} is already confirmed.`);
  const teams = groupTeams(state, team).filter(t => !isConfirmed(t));
  for (const t of teams) Object.assign(t, { status: 'confirmed', confirmedAt: now, confirmedBy: official });
  log(state, teams.length > 1 ? `Payment confirmed by ${official} for ${teams.length} teams (${teams.map(t => t.name).join(', ')})` : `${team.name} payment confirmed by ${official}`, now);
}
// Team numbers only ever increase, so a removed team's ID is never handed to someone else.
export function nextTeamId(state) {
  state.teamSeq = Math.max(state.teamSeq || 0, ...state.teams.map(t => Number(t.id.slice(4)) || 0)) + 1;
  return `CAR-${String(state.teamSeq).padStart(3, '0')}`;
}
export function removeTeam(state, id) {
  fail(state.matches.length > 0, 'Teams can’t be removed after the draw is created.');
  const index = state.teams.findIndex(t => t.id === id); fail(index < 0, 'Team not found.');
  const [team] = state.teams.splice(index, 1); log(state, `${team.name} (${team.id}) removed by the desk`);
}
export function createDraw(state, shuffle = true) {
  fail(state.matches.length > 0, 'A draw already exists.');
  const teams = state.teams.filter(isConfirmed), pending = state.teams.length - teams.length;
  fail(teams.length < 2, pending ? 'Confirm at least two teams’ payments before creating a draw.' : 'Register at least two teams before creating a draw.');
  if (pending) log(state, `${pending} team${pending === 1 ? '' : 's'} awaiting payment left out of the draw`);
  if (shuffle) for (let i = teams.length - 1; i > 0; i--) { const j = randomInt(i + 1); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  const size = 2 ** Math.ceil(Math.log2(teams.length));
  let seeds = [1, 2];
  while (seeds.length < size) seeds = seeds.flatMap(s => [s, seeds.length * 2 + 1 - s]);
  let previous = [], index = 1;
  for (let r = 1; r <= Math.log2(size); r++) {
    const round = [];
    for (let i = 0; i < size / 2 ** r; i++) {
      const m = { id: `M${String(index++).padStart(2, '0')}`, round: r, roundName: roundName(size / 2 ** r), teamA: r === 1 ? teams[seeds[i * 2] - 1]?.id ?? null : null, teamB: r === 1 ? teams[seeds[i * 2 + 1] - 1]?.id ?? null : null, sources: r === 1 ? [] : [previous[i * 2].id, previous[i * 2 + 1].id], status: 'waiting', board: null, winner: null };
      state.matches.push(m); round.push(m);
    }
    previous = round;
  }
  state.event.registrationOpen = false; refresh(state); log(state, `Knockout draw created for ${teams.length} teams`);
}
export function updateSettings(state, input) {
  const e = state.event;
  for (const key of ['name', 'year', 'venue', 'date']) if (input[key] !== undefined) e[key] = String(input[key]).trim().slice(0, 120);
  if (input.startTime !== undefined) { const t = String(input.startTime).trim(); fail(t !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t), 'Enter a valid start time.'); e.startTime = t; }
  fail(!e.name || !e.venue, 'Event name and venue are required.');
  for (const [key, min, max] of [['resetMinutes', 0, 30], ['restMinutes', 0, 60]]) { const n = Number(input[key]); fail(!Number.isInteger(n) || n < min || n > max, `Invalid value for ${key}.`); e[key] = n; }
  for (const [key, min, max] of [['gameMinutes', 1, 30], ['maxTeams', 2, 128], ['maxTeamsPerParish', 1, 128], ['entryFee', 0, 100000]]) { if (input[key] === undefined) continue; const n = Number(input[key]); fail(input[key] === '' || !Number.isInteger(n) || n < min || n > max, `Invalid value for ${key}.`); e[key] = n; }
  if (input.gamesPerMatch !== undefined) { const n = Number(input.gamesPerMatch); fail(![1, 3, 5].includes(n), 'Rounds per match must be 1, 3 or 5.'); e.gamesPerMatch = n; }
  if (input.registrationDeadline !== undefined) { const d = String(input.registrationDeadline).trim(); fail(d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))), 'Enter a valid registration deadline.'); e.registrationDeadline = d; }
  if (input.registrationDeadlineTime !== undefined) { const t = String(input.registrationDeadlineTime).trim(); fail(t !== '24:00' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t), 'Enter a valid registration closing time.'); e.registrationDeadlineTime = t; }
  if (input.upiQr !== undefined) { const qr = String(input.upiQr ?? ''); fail(qr !== '' && !upiQrUrl.test(qr) && !legacyUpiQr(qr), 'Upload the UPI QR code as a PNG or JPEG picture.'); e.upiQr = qr; }
  if (input.upiId !== undefined) { const id = String(input.upiId).trim(); fail(id !== '' && !/^[\w.-]{2,256}@[a-zA-Z][\w.-]{1,63}$/.test(id), 'Enter a valid UPI ID, like name@bank.'); e.upiId = id; }
  if (input.upiName !== undefined) { const n = String(input.upiName).trim().replace(/\s+/g, ' '); fail(n.length > 50 || /[^\w .&'()-]/.test(n), 'Enter a payee name of up to 50 letters, digits or spaces.'); e.upiName = n; }
  if (input.upiMerchantCode !== undefined) { const mc = String(input.upiMerchantCode).trim(); fail(mc !== '' && !/^\d{4}$/.test(mc), 'Enter the merchant category code as 4 digits.'); e.upiMerchantCode = mc; }
  if (input.paymentRequired !== undefined) e.paymentRequired = Boolean(input.paymentRequired);
  if (input.upiHidePayButton !== undefined) e.upiHidePayButton = Boolean(input.upiHidePayButton);
  if (input.lunchCoupons !== undefined) e.lunchCoupons = Boolean(input.lunchCoupons);
  fail(e.paymentRequired && !e.upiId && !e.upiQr, 'Enter a UPI ID or upload the UPI QR code to collect payment at registration.');
  if (input.contacts !== undefined) {
    const contacts = (Array.isArray(input.contacts) ? input.contacts : []).map(c => ({ name: String(c?.name ?? '').trim().slice(0, 60), phone: String(c?.phone ?? '').trim().slice(0, 20) })).filter(c => c.name || c.phone);
    fail(contacts.length > 3, 'Add up to 3 support contacts.');
    fail(contacts.some(c => !c.name || !/^\+?[\d\s()-]{7,20}$/.test(c.phone)), 'Give each support contact a name and a valid phone number.');
    e.contacts = contacts;
  }
  e.registrationOpen = !state.demo && !state.matches.length && Boolean(input.registrationOpen);
}
// Ends a board's reset period early once officials have set the board up again.
export function boardReady(state, boardId, now = Date.now()) {
  const b = state.boards.find(b => b.id === Number(boardId)); fail(!b, 'Board not found.');
  fail(state.matches.some(m => m.board === b.id && isLive(m)), 'This board has a match in progress.');
  fail(b.availableAt <= now, 'This board is already available.');
  b.availableAt = now; log(state, `Board ${b.id} reset early and ready`, now);
}
export function checkIn(state, input) {
  const team = state.teams.find(t => input.token ? t.checkinToken === input.token : t.id === input.id); fail(!team, 'Team not found. Check the QR code or team ID.');
  fail(input.checkedIn !== false && !isConfirmed(team), 'Payment for this team hasn’t been confirmed yet.');
  fail(input.checkedIn === false && state.matches.some(m => isLive(m) && [m.teamA, m.teamB].includes(team.id)), 'This team is assigned to a board.');
  team.checkedIn = input.checkedIn !== false; log(state, `${team.name} ${team.checkedIn ? 'checked in' : 'check-in removed'}`);
}
// With lunch coupons on, the lunch counter scans a coupon's QR code (the team's check-in token) and
// marks one of the team's booked lunches as served; the Teams page can serve or undo one by team ID.
export function serveLunch(state, input, now = Date.now()) {
  fail(!state.event.lunchCoupons, 'Lunch coupons are turned off in Event settings.');
  const team = state.teams.find(t => input.token ? t.checkinToken === input.token : t.id === input.id); fail(!team, 'Team not found. Check the QR code or team ID.');
  fail(!team.lunch, 'No lunch was booked for this team.');
  fail(!isConfirmed(team), 'Payment for this team hasn’t been confirmed yet.');
  const served = team.lunchServed || 0;
  if (input.undo) { fail(!served, 'No lunch has been served to this team yet.'); team.lunchServed = served - 1; log(state, `${team.name}: lunch served undone (${team.lunchServed} of ${team.lunch})`, now); return; }
  const count = Math.max(1, Math.trunc(Number(input.count)) || 1);
  fail(served >= team.lunch, 'Every lunch booked for this team has already been served.');
  fail(served + count > team.lunch, 'Only 1 lunch is left for this team.');
  team.lunchServed = served + count; team.lunchServedAt = now;
  log(state, `${team.name}: lunch ${team.lunchServed} of ${team.lunch} served`, now);
}
export function unassign(state, id) {
  const m = state.matches.find(m => m.id === id); fail(!m || m.status !== 'called', 'Only a called match can be returned to the queue.');
  m.status = 'ready'; m.board = null; log(state, `${m.id} returned to queue`);
}
// Clears teams, matches and results; event details are kept and registration reopens.
export function freshEvent(state, confirm) { fail(confirm !== 'RESET', 'Type RESET to start a fresh event.'); return { ...emptyState(), event: { ...state.event, registrationOpen: true } }; }
export function loadSample(state) {
  fail(state.teams.length > 0, 'Start a fresh event before loading sample teams.');
  const sample = seedDemo(); sample.event = { ...state.event, registrationOpen: false }; return sample;
}
// Practice mode: the sample tournament, using the real event's details, never shown publicly.
// Admins can turn practice mode off for every device, and back on; this is set on the real event.
export function practiceMode(state, on, now = Date.now()) {
  fail(state.practice, 'Leave practice mode to change this.');
  state.event.practiceOff = !on; log(state, `Practice mode turned ${on ? 'on' : 'off'} for all devices`, now);
}
export function practiceEvent(event) { const sample = seedDemo(); sample.event = { ...event, registrationOpen: false }; sample.practice = true; return sample; }
// What anyone may see: no mobile numbers, check-in tokens or desk activity.
// What anyone may see: no contact or ID details, check-in tokens, payment references or desk activity.
export const publicTeam = ({ checkinToken, payment, confirmedBy, group, ...t }) => ({ ...t, ...(group ? { group: { id: group.id, size: group.size } } : {}), players: t.players.map(p => ({ name: p.name })) });
export function publicState(state) { return { ...state, ...(state.media ? { media: publicMedia(state.media) } : {}), teams: state.teams.map(publicTeam), activity: [] }; }
export function roundName(count) { return count === 1 ? 'Final' : count === 2 ? 'Semifinals' : count === 4 ? 'Quarterfinals' : `Round of ${count * 2}`; }
export function refresh(state) {
  for (const m of state.matches) {
    if (m.status !== 'waiting') continue;
    if (m.sources.length) {
      const sources = m.sources.map(id => state.matches.find(s => s.id === id));
      if (sources.some(s => s.status !== 'completed')) continue;
      [m.teamA, m.teamB] = sources.map(s => s.winner);
    }
    if (!m.teamA || !m.teamB) { m.status = 'completed'; m.winner = m.teamA || m.teamB; m.bye = true; }
    else m.status = 'ready';
  }
}
export function eligible(state, match, now = Date.now()) {
  if (match.status !== 'ready') return 'Not ready';
  const ids = [match.teamA, match.teamB];
  if (ids.some(id => !state.teams.find(t => t.id === id)?.checkedIn)) return 'Awaiting check-in';
  if (state.matches.some(m => isLive(m) && [m.teamA, m.teamB].some(id => ids.includes(id)))) return 'Team on another board';
  // Rest is only needed after a match that was actually played (not a bye or walkover).
  const last = Math.max(0, ...state.matches.filter(m => m.status === 'completed' && !m.bye && !m.walkover && [m.teamA, m.teamB].some(id => ids.includes(id))).map(m => m.completedAt || 0));
  if (last && last + state.event.restMinutes * 60000 > now) return 'Rest period';
  return '';
}
export function assign(state, id, boardId, now = Date.now()) {
  const m = state.matches.find(m => m.id === id), b = state.boards.find(b => b.id === Number(boardId));
  fail(!m || !b, 'Match or board not found.'); fail(Boolean(eligible(state, m, now)), eligible(state, m, now));
  fail(state.matches.some(m => m.board === b.id && isLive(m)), 'This board is occupied.');
  fail(b.availableAt > now, 'This board is being reset.');
  m.board = b.id; m.status = 'called'; log(state, `${m.id} called to Board ${b.id}`, now);
}
// A match is played in rounds (games) of a set length: best of three rounds of 10 minutes by
// default. The umpire decides each round, whether or not its time has run out, and an official
// marks the winner; the next round starts when an official starts it. The first team to win most of
// the rounds wins the match. A match keeps the format it started with, whatever the settings say later.
export const roundsToWin = m => Math.ceil(m.gamesPerMatch / 2);
// The round being played or about to start: the last one, unless it already has a winner.
export const currentRound = m => m.rounds?.at(-1)?.winner ? null : m.rounds?.at(-1) ?? null;
function openRound(m, now) { m.rounds.push({ startedAt: now, endsAt: now + m.gameMinutes * 60000 }); }
export function start(state, id, now = Date.now()) {
  const m = state.matches.find(m => m.id === id); fail(!m || m.status !== 'called', 'Call the match to a board first.');
  Object.assign(m, { status: 'playing', startedAt: now, gamesPerMatch: setting(state, 'gamesPerMatch'), gameMinutes: setting(state, 'gameMinutes'), rounds: [], gamesA: 0, gamesB: 0 });
  openRound(m, now); log(state, `${m.id} started on Board ${m.board}`, now);
}
const count = m => { m.gamesA = m.rounds.filter(r => r.winner === m.teamA).length; m.gamesB = m.rounds.filter(r => r.winner === m.teamB).length; };
const scoreLine = m => `${Math.max(m.gamesA, m.gamesB)}–${Math.min(m.gamesA, m.gamesB)} in rounds`;
// A match started before rounds existed carries on in the current format, from round 1.
function playing(state, id, now = Date.now()) {
  const m = state.matches.find(m => m.id === id); fail(!m || m.status !== 'playing', 'This match is not in play.');
  if (!m.rounds) Object.assign(m, { gamesPerMatch: setting(state, 'gamesPerMatch'), gameMinutes: setting(state, 'gameMinutes'), rounds: [], gamesA: 0, gamesB: 0 });
  return m;
}
export function roundWinner(state, id, winnerId, now = Date.now(), official = 'Tournament desk') {
  const m = playing(state, id, now), round = currentRound(m);
  fail(!round, `Start round ${m.rounds.length + 1} first.`);
  fail(![m.teamA, m.teamB].includes(winnerId), 'Choose the team that won the round.');
  Object.assign(round, { winner: winnerId, endedAt: now, official }); count(m);
  log(state, `${m.id} round ${m.rounds.length}: ${teamName(state, winnerId)}`, now);
  if (Math.max(m.gamesA, m.gamesB) < roundsToWin(m)) return;
  m.status = 'completed'; m.winner = winnerId; m.completedAt = now; m.official = official;
  state.boards.find(b => b.id === m.board).availableAt = now + state.event.resetMinutes * 60000;
  log(state, `${m.id}: ${teamName(state, m.winner)} won (${scoreLine(m)})`, now); refresh(state);
}
export function nextRound(state, id, now = Date.now()) {
  const m = playing(state, id, now); fail(Boolean(currentRound(m)), `Round ${m.rounds.length} is still being played.`);
  openRound(m, now); log(state, `${m.id} round ${m.rounds.length} started`, now);
}
// Takes back the last round's winner, e.g. after a mis-tap. The round is played on with its own
// timer; a round started since is dropped. A round that ended the match is fixed with a correction.
export function undoRound(state, id, now = Date.now()) {
  const m = playing(state, id, now), started = currentRound(m);
  fail(m.rounds.length < (started ? 2 : 1), 'No round has been decided yet.');
  if (started) m.rounds.pop();
  const last = m.rounds.at(-1), was = last.winner; delete last.winner; delete last.endedAt; delete last.official; count(m);
  log(state, `${m.id} round ${m.rounds.length} winner (${teamName(state, was)}) taken back`, now);
}
// Later rounds fed by this match go back to "waiting" so refresh() can re-derive them. Refused once
// any of them has been called or played, because that result can no longer be changed safely.
function resetDownstream(state, m) {
  for (const d of state.matches.filter(d => d.sources.includes(m.id))) {
    fail(isLive(d), `${d.id} is already on a board. Return it to the queue first.`);
    fail(d.status === 'completed' && !d.bye, `${d.id} has already been played, so this result can no longer be changed.`);
    resetDownstream(state, d);
    Object.assign(d, { status: 'waiting', teamA: null, teamB: null, winner: null, board: null }); delete d.bye;
  }
}
// Fixes a recorded score: the winner of each round, in order (round1, round2, …). Allowed until the
// winner's next match is called; the bracket is re-derived.
export function correctResult(state, id, input, now = Date.now(), official = 'Tournament desk') {
  const m = state.matches.find(m => m.id === id);
  fail(!m || m.status !== 'completed' || m.bye || m.walkover, 'Only a played, completed match can be corrected.');
  m.gamesPerMatch ??= setting(state, 'gamesPerMatch');
  // Everything is checked before anything changes, so a refused correction leaves the bracket as it was.
  const winners = Array.from({ length: m.gamesPerMatch }, (_, i) => String(input[`round${i + 1}`] ?? '')), played = winners.filter(Boolean), need = roundsToWin(m);
  fail(played.some(w => ![m.teamA, m.teamB].includes(w)) || winners.slice(0, played.length).some(w => !w), 'Choose the winner of each round played, in order.');
  const decided = played.findIndex((w, i) => played.slice(0, i + 1).filter(x => x === w).length === need);
  fail(decided < 0 || decided !== played.length - 1, `The match ends when a team wins ${need} round${need === 1 ? '' : 's'}: choose the winners up to that round and no further.`);
  resetDownstream(state, m);
  m.rounds = played.map((winner, i) => ({ ...m.rounds?.[i], winner })); count(m); m.winner = played.at(-1);
  delete m.coinsA; delete m.coinsB; delete m.tieReason;
  m.corrected = true; m.correctedAt = now; m.official = official;
  log(state, `${m.id} corrected: ${teamName(state, m.winner)} won (${scoreLine(m)})`, now); refresh(state);
}
// Awards a match without play, e.g. when a team does not show up. The winner need not be checked in.
export function walkover(state, id, winnerId, reason, now = Date.now(), official = 'Tournament desk') {
  const m = state.matches.find(m => m.id === id);
  fail(!m || !['ready', 'called'].includes(m.status), 'Only a match that has not started can be awarded as a walkover.');
  fail(![m.teamA, m.teamB].includes(winnerId), 'Choose which team receives the walkover.');
  m.status = 'completed'; m.winner = winnerId; m.board = null; m.completedAt = now; m.official = official;
  m.walkover = String(reason || '').trim().slice(0, 300) || 'Opponent did not show';
  log(state, `${m.id}: ${teamName(state, winnerId)} awarded a walkover (${m.walkover})`, now); refresh(state);
}
export function undoWalkover(state, id, now = Date.now()) {
  const m = state.matches.find(m => m.id === id);
  fail(!m || m.status !== 'completed' || !m.walkover, 'This match was not a walkover.');
  resetDownstream(state, m);
  Object.assign(m, { status: 'ready', winner: null, board: null }); delete m.walkover; delete m.completedAt; delete m.official;
  log(state, `${m.id} walkover undone; back in the queue`, now); refresh(state);
}
export function seedDemo() {
  const s = emptyState(); s.demo = true;
  const names = ['Baseline Brothers', 'The Strikers', 'Pocket Aces', 'Royal Knights', 'Corner Kings', 'White Knights', 'Queen’s Guard', 'Black & Bold', 'Double Trouble', 'The Challengers', 'Strike Force', 'Last Coin', 'Board Brothers', 'Perfect Pocket', 'The Finishers', 'Carrom Collective'];
  const players = ['Arun', 'Joel', 'Mathew', 'Paul', 'Joseph', 'Kevin', 'Thomas', 'Mark'];
  const parishes = [['Mathikere Forane', 'Vijayanagar, Mary Matha Church'], ['Dharmaram Forane', 'Dharmaram, St. Thomas Forane Church'], ['Dharmaram Forane', "Kalkere, St. Joseph's Church"], ['Hongasandra Forane', 'Hongasandra, Holy Family Forane Church']];
  const player = (n, i) => ({ name: `${players[n % 8]} Demo`, mobile: '9000000000', idType: 'Aadhaar', idLast4: String(1000 + i) });
  names.forEach((name, i) => { const [forane, parish] = parishes[i % 4]; const t = addTeam(s, { name, forane, parish, players: [player(i, i * 2), player(i + 3, i * 2 + 1)], lunch: i % 3 ? 2 : 0, adults: true }); t.checkedIn = true; });
  createDraw(s, false); for (let i = 0; i < 4; i++) assign(s, s.matches[i].id, i + 1);
  log(s, 'Sample tournament loaded — all teams are fictional'); return s;
}
// Desk roles. An admin can do everything and an official everything but the admin actions. The
// other roles do one job each: check-in, lunch, assigned-board matches, or assigned-board
// streams with a shared gallery. The desk still calls matches to boards.
export const roles = { admin: 'Event admin', official: 'Official', checkin: 'Check-in desk', lunch: 'Lunch counter', umpire: 'Umpire', media: 'Media manager' };
// Which roles may open a team's private files: player photos (checked at check-in) and payment screenshots.
export const fileRoles = { photos: ['admin', 'official', 'checkin'], payments: ['admin', 'official'] };
// What the one-job roles are shown of a team: no contact numbers or payment details, and ID
// details only for check-in. The check-in token stays, so a scanned QR code finds its team.
export function staffTeam(t, role) {
  const { payment, confirmedBy, group, ...team } = t;
  return { ...team, ...(group ? { group: { id: group.id, size: group.size } } : {}), players: t.players.map(({ mobile, idType, idLast4, ...p }) => role === 'checkin' ? { ...p, idType, idLast4 } : p) };
}
export const teamsFor = (teams, role) => ['admin', 'official'].includes(role) ? teams : teams.map(t => role === 'media' ? publicTeam(t) : staffTeam(t, role));
// Why this official may not run this action on the real event, or '' if they may. In practice mode
// an official may try the admin actions too; the other roles rehearse only their own job.
export function refusal(action, user, practice = false) {
  if (user.role === 'admin' || (user.role === 'official' && (!action.admin || practice))) return '';
  if (action.staff?.includes(user.role)) return '';
  if (user.role === 'official' || action.admin) return 'Only an event admin can do this.';
  return `This isn’t part of the ${roles[user.role] ?? 'desk'} role.`;
}
// An umpire runs only the boards assigned to them: the match's board, or the board being reset.
export function checkBoard(state, input, user) {
  if (user.role === 'media') {
    fail(input.operation === 'settings', 'Only an event admin can change the media display settings.');
    if (['add', 'review', 'remove'].includes(input.operation)) return;
    const board = input.operation === 'stream' ? input.matchId ? state.matches.find(m => m.id === input.matchId)?.board : Number(input.boardId) : null;
    fail(!(user.boards || []).includes(board), 'This board isn’t assigned to you.');
    return;
  }
  if (user.role !== 'umpire') return;
  const board = input.board !== undefined ? Number(input.board) : state.matches.find(m => m.id === input.id)?.board;
  fail(!(user.boards || []).includes(board), 'This board isn’t assigned to you.');
}
// Every desk action in one place: whether it needs an admin, which of the one-job roles may run it
// (staff), and how it changes the event. Callers (the local server and the live site) supply
// ctx = { now, official }. A handler that returns a value replaces the whole event (fresh event,
// sample); otherwise it changes the event in place.
export function updateMedia(state, input, now = Date.now()) {
  const media = structuredClone(state.media || { streamsEnabled: false, galleryEnabled: false, streams: [], gallery: [] });
  if (input.operation === 'settings') {
    media.streamsEnabled = input.streamsEnabled === true; media.galleryEnabled = input.galleryEnabled === true;
  } else if (input.operation === 'stream') {
    const matchId = String(input.matchId || ''), boardId = matchId ? null : Number(input.boardId);
    fail(matchId ? !state.matches.some(m => m.id === matchId) : !state.boards.some(b => b.id === boardId), 'Choose an existing board or match.');
    const index = media.streams.findIndex(s => matchId ? s.matchId === matchId : !s.matchId && s.boardId === boardId);
    if (input.remove) { if (index >= 0) media.streams.splice(index, 1); }
    else {
      const url = socialLink(input.url, true).url, stream = { boardId, matchId: matchId || null, url, enabled: input.enabled === true };
      if (index >= 0) media.streams[index] = stream; else media.streams.push(stream);
    }
  } else if (input.operation === 'add') {
    const url = socialLink(input.url).url, title = String(input.title || '').trim();
    fail(!title || title.length > 120, 'Give the gallery item a title of up to 120 characters.');
    fail(!['photo', 'video'].includes(input.kind), 'Choose photo or video.');
    fail(media.gallery.length >= 200, 'The gallery can hold up to 200 links. Remove an old item first.');
    fail(media.gallery.some(p => p.url === url), 'This link is already in the gallery.');
    media.gallery.unshift({ id: randomUUID(), url, title, kind: input.kind, status: 'pending', addedAt: now });
  } else if (input.operation === 'review' || input.operation === 'remove') {
    const index = media.gallery.findIndex(p => p.id === input.id); fail(index < 0, 'Gallery item not found.');
    if (input.operation === 'remove') media.gallery.splice(index, 1);
    else { fail(!['approved', 'pending', 'rejected'].includes(input.status), 'Choose a valid gallery status.'); media.gallery[index].status = input.status; }
  } else fail(true, 'Unknown media action.');
  state.media = media; log(state, 'Streams & gallery updated', now);
}
// Visitors submit only these fields. Approval and source cannot be chosen by the caller.
export function gallerySubmissionInput(input) {
  const url = socialLink(input.url).url, title = String(input.title || '').trim();
  fail(!title || title.length > 120, 'Add a caption of up to 120 characters.');
  fail(!['photo', 'video'].includes(input.kind), 'Choose photo or video.');
  return { url, title, kind: input.kind };
}
export function submitGallery(state, input, now = Date.now()) {
  fail(!state.media?.galleryEnabled, 'The photo & video wall is not accepting links right now.');
  updateMedia(state, { ...gallerySubmissionInput(input), operation: 'add' }, now);
  state.media.gallery[0].source = 'public';
}
export const actions = {
  media: { admin: true, staff: ['media'], run: (state, input, { now }) => updateMedia(state, input, now) },
  checkin: { staff: ['checkin'], run: (state, input) => checkIn(state, input) },
  'serve-lunch': { staff: ['lunch'], run: (state, input, { now }) => serveLunch(state, input, now) },
  'confirm-payment': { run: (state, input, { now, official }) => confirmPayment(state, input.id, now, official) },
  assign: { run: (state, input, { now }) => assign(state, input.id, input.board, now) },
  unassign: { run: (state, input) => unassign(state, input.id) },
  start: { staff: ['umpire'], run: (state, input, { now }) => start(state, input.id, now) },
  'round-winner': { staff: ['umpire'], run: (state, input, { now, official }) => roundWinner(state, input.id, input.winner, now, official) },
  'next-round': { staff: ['umpire'], run: (state, input, { now }) => nextRound(state, input.id, now) },
  'undo-round': { staff: ['umpire'], run: (state, input, { now }) => undoRound(state, input.id, now) },
  'board-ready': { staff: ['umpire'], run: (state, input, { now }) => boardReady(state, input.board, now) },
  draw: { admin: true, run: state => createDraw(state) },
  'correct-result': { admin: true, run: (state, input, { now, official }) => correctResult(state, input.id, input, now, official) },
  walkover: { admin: true, run: (state, input, { now, official }) => walkover(state, input.id, input.winner, input.reason, now, official) },
  'undo-walkover': { admin: true, run: (state, input, { now }) => undoWalkover(state, input.id, now) },
  settings: { admin: true, run: (state, input) => { updateSettings(state, input); log(state, 'Event settings updated'); } },
  'remove-team': { admin: true, run: (state, input) => removeTeam(state, input.id) },
  'practice-mode': { admin: true, run: (state, input, { now }) => practiceMode(state, input.on === true, now) },
  demo: { admin: true, run: state => loadSample(state) },
  reset: { admin: true, run: (state, input) => freshEvent(state, input.confirm) }
};
