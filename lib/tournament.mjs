import { randomUUID, randomInt } from 'node:crypto';
import { findCentre, idTypes } from '../public/parishes.js';

export const defaults = { name: 'CARROMIA', year: '2026', venue: 'Mary Matha Church, Vijayanagar', date: '2026-11-15', startTime: '09:00', durationMinutes: 30, resetMinutes: 5, restMinutes: 0, registrationOpen: true, maxTeams: 64, maxTeamsPerParish: 4, registrationDeadline: '2026-11-10', entryFee: 500 };
// Events saved before a setting existed use its default.
export const setting = (state, key) => state.event[key] ?? defaults[key];
export function emptyState() { return { version: 1, event: { ...defaults }, teams: [], matches: [], boards: [1, 2, 3, 4].map(id => ({ id, availableAt: 0 })), activity: [], demo: false }; }
export function log(state, message, now = Date.now()) { state.activity.unshift({ id: randomUUID(), message, at: now }); state.activity = state.activity.slice(0, 80); }
export function fail(condition, message) { if (condition) throw new Error(message); }
// A match that occupies a board right now.
export const isLive = m => ['called', 'playing', 'tiebreak'].includes(m.status);
const teamName = (state, id) => state.teams.find(t => t.id === id)?.name ?? id;
// "St. Thomas", "st thomas" and "St Thomas Church" count as the same parish.
export const parishKey = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(church|parish)\b/g, ' ').replace(/\s+/g, ' ').trim();
const longDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Whether teams can register right now, and if not, why. The deadline is the end of that day in
// India and applies to the real event only, so registration can still be rehearsed in practice.
export function registrationStatus(state, now = Date.now()) {
  const maxTeams = setting(state, 'maxTeams'), deadline = setting(state, 'registrationDeadline'), slotsLeft = Math.max(0, maxTeams - state.teams.length);
  const reason = !state.event.registrationOpen || state.matches.length > 0 ? 'Registration is closed for this draw.'
    : deadline && !state.practice && now > Date.parse(`${deadline}T23:59:59.999+05:30`) ? `Registration closed on ${longDate(deadline)}.`
    : slotsLeft === 0 ? `All ${maxTeams} team slots are taken. Registration is full.` : '';
  return { open: !reason, reason, slotsLeft, maxTeams };
}
// Player photos are shrunk to a small JPEG in the browser and stored apart from the event.
export const maxPhotoLength = 200000;
export function playerPhotos(input) {
  const photos = (input.players || []).map(p => String(p?.photo ?? ''));
  fail(photos.length !== 2 || photos.some(p => !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p) || p.length > maxPhotoLength), 'Add a photo of each player (a JPEG under 150 KB).');
  return photos;
}
// When the event collects payment at registration, a team gives the UPI transaction number and/or
// a screenshot and stays pending until the desk confirms the money arrived. The screenshot is kept
// apart from the event, like player photos. Teams saved before payments existed count as confirmed.
export const maxUpiQrLength = 150000, maxScreenshotLength = 400000;
export const isConfirmed = team => team.status !== 'pending';
export function paymentProof(input) {
  const shot = String(input.payment?.screenshot ?? '');
  fail(shot !== '' && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot) || shot.length > maxScreenshotLength), 'Add the payment screenshot as a picture under 300 KB.');
  return shot;
}
export function addTeam(state, input, now = Date.now()) {
  const status = registrationStatus(state, now); fail(!status.open, status.reason);
  const clean = (s, limit = 80) => String(s ?? '').trim().slice(0, limit);
  const centre = findCentre(input.forane, input.parish, input.centreType);
  const team = { id: '', name: clean(input.name), forane: centre?.group ?? '', parish: centre?.name ?? '', centreType: centre?.type ?? '', players: (input.players || []).map(p => ({ name: clean(p.name), mobile: clean(p.mobile, 20), idType: idTypes.includes(p.idType) ? p.idType : '', idLast4: clean(p.idLast4, 4).toUpperCase() })), primaryContact: Number(input.primaryContact) === 1 ? 1 : 0, lunch: Math.min(2, Math.max(0, Math.trunc(Number(input.lunch)) || 0)), checkedIn: false, registeredAt: now, checkinToken: randomUUID() };
  fail(!team.name, 'Enter a team name.');
  fail(!centre, 'Choose your forane or zone, then your parish or centre from the list.');
  fail(team.players.length !== 2 || team.players.some(p => !p.name || !/^\+?[\d\s()-]{7,20}$/.test(p.mobile)), 'Enter exactly two players with valid mobile numbers.');
  fail(team.players.some(p => !p.idType || !/^[A-Z0-9]{4}$/.test(p.idLast4)), 'Choose each player’s ID proof and enter the last 4 letters or digits of its number.');
  fail(state.teams.some(t => t.name.toLowerCase() === team.name.toLowerCase()), 'That team name is already registered.');
  fail(input.adults !== true, 'Confirm that both players are 18 or older.');
  const perParish = setting(state, 'maxTeamsPerParish');
  fail(state.teams.filter(t => parishKey(t.parish) === parishKey(team.parish)).length >= perParish, `${team.parish} already has ${perParish} teams registered, the most allowed for one parish.`);
  if (state.event.paymentRequired) {
    const txnRef = clean(input.payment?.txnRef, 30).replace(/\s+/g, '').toUpperCase(), screenshot = Boolean(paymentProof(input));
    fail(txnRef && !/^[A-Z0-9]{6,30}$/.test(txnRef), 'Enter the UPI transaction number (UTR) as shown in your payment app: 6 to 30 letters or digits.');
    fail(!txnRef && !screenshot, 'Enter the UPI transaction number or add a payment screenshot.');
    Object.assign(team, { status: 'pending', payment: { amount: setting(state, 'entryFee'), txnRef, screenshot } });
  } else team.status = 'confirmed';
  team.id = nextTeamId(state); state.teams.push(team); log(state, `${team.name} registered${team.status === 'pending' ? ' (payment to be confirmed)' : ''}`); return team;
}
// A confirmed team's full details, for its registration form, when the caller knows the primary
// player's mobile number (compared on the last 10 digits). One message for every failure.
export const mobileKey = mobile => String(mobile ?? '').replace(/\D/g, '').slice(-10);
export function teamForm(state, id, mobile) {
  const team = state.teams.find(t => t.id === String(id ?? '').trim().toUpperCase());
  fail(!team, 'Team not found.');
  fail(!isConfirmed(team), 'This team’s payment is still being verified. The form can be downloaded once the desk confirms it.');
  fail(mobileKey(mobile).length < 10 || mobileKey(mobile) !== mobileKey(team.players[team.primaryContact]?.mobile), 'That mobile number doesn’t match this team’s primary contact.');
  return team;
}
export function confirmPayment(state, id, now = Date.now(), official = 'Tournament desk') {
  const team = state.teams.find(t => t.id === id); fail(!team, 'Team not found.');
  fail(isConfirmed(team), `${team.name} is already confirmed.`);
  Object.assign(team, { status: 'confirmed', confirmedAt: now, confirmedBy: official });
  log(state, `${team.name} payment confirmed by ${official}`, now);
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
  for (const [key, min, max] of [['durationMinutes', 1, 60], ['resetMinutes', 0, 30], ['restMinutes', 0, 60]]) { const n = Number(input[key]); fail(!Number.isInteger(n) || n < min || n > max, `Invalid value for ${key}.`); e[key] = n; }
  for (const [key, min, max] of [['maxTeams', 2, 128], ['maxTeamsPerParish', 1, 128], ['entryFee', 0, 100000]]) { if (input[key] === undefined) continue; const n = Number(input[key]); fail(input[key] === '' || !Number.isInteger(n) || n < min || n > max, `Invalid value for ${key}.`); e[key] = n; }
  if (input.registrationDeadline !== undefined) { const d = String(input.registrationDeadline).trim(); fail(d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))), 'Enter a valid registration deadline.'); e.registrationDeadline = d; }
  if (input.upiQr !== undefined) { const qr = String(input.upiQr ?? ''); fail(qr !== '' && (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(qr) || qr.length > maxUpiQrLength), 'Upload the UPI QR code as a PNG or JPEG under 110 KB.'); e.upiQr = qr; }
  if (input.upiId !== undefined) { const id = String(input.upiId).trim(); fail(id !== '' && !/^[\w.-]{2,256}@[a-zA-Z][\w.-]{1,63}$/.test(id), 'Enter a valid UPI ID, like name@bank.'); e.upiId = id; }
  if (input.paymentRequired !== undefined) e.paymentRequired = Boolean(input.paymentRequired);
  fail(e.paymentRequired && !e.upiQr, 'Upload the UPI QR code to collect payment at registration.');
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
export function practiceEvent(event) { const sample = seedDemo(); sample.event = { ...event, registrationOpen: false }; sample.practice = true; return sample; }
// What anyone may see: no mobile numbers, check-in tokens or desk activity.
// What anyone may see: no contact or ID details, check-in tokens, payment references or desk activity.
export const publicTeam = ({ checkinToken, payment, confirmedBy, ...t }) => ({ ...t, players: t.players.map(p => ({ name: p.name })) });
export function publicState(state) { return { ...state, teams: state.teams.map(publicTeam), activity: [] }; }
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
export function start(state, id, now = Date.now()) {
  const m = state.matches.find(m => m.id === id); fail(!m || m.status !== 'called', 'Call the match to a board first.');
  m.status = 'playing'; m.startedAt = now; m.endsAt = now + state.event.durationMinutes * 60000; log(state, `${m.id} started on Board ${m.board}`, now);
}
// A match is the best of three games: the first team to win two games wins. If the match time runs
// out first, the team with fewer coins left on the board wins, and equal counts go to a tie-break
// (Golden Pocket, then sudden death) that an official decides and records.
const whole = (value, max) => { const n = Number(value); return value === '' || value == null || !Number.isInteger(n) || n < 0 || n > max ? null : n; };
function games(input) {
  const a = whole(input.gamesA, 2), b = whole(input.gamesB, 2);
  fail(a === null || b === null || (a === 2 && b === 2), 'Games won must be 0, 1 or 2 for each team, and only one team can win two games.');
  return [a, b];
}
function coins(input) {
  const a = whole(input.a, 9), b = whole(input.b, 9);
  fail(a === null || b === null, 'Coins left on the board must be whole numbers from 0 to 9.');
  return [a, b];
}
// Records the score and picks the winner. Returns false when equal coin counts still await the tie-break.
function decide(m, [gamesA, gamesB], input) {
  m.gamesA = gamesA; m.gamesB = gamesB;
  if (gamesA === 2 || gamesB === 2) { m.winner = gamesA === 2 ? m.teamA : m.teamB; delete m.coinsA; delete m.coinsB; delete m.tieReason; return true; }
  const [a, b] = coins(input); m.coinsA = a; m.coinsB = b;
  if (a === b) {
    if (!input.tieWinner) return false;
    fail(![m.teamA, m.teamB].includes(input.tieWinner) || !String(input.reason || '').trim(), 'Choose the tie-break winner and how the tie was decided.');
    m.winner = input.tieWinner; m.tieReason = String(input.reason).trim().slice(0, 300);
  } else { m.winner = a < b ? m.teamA : m.teamB; delete m.tieReason; }
  return true;
}
const scoreLine = m => m.coinsA == null ? `${m.gamesA}–${m.gamesB} in games` : `time up at ${m.gamesA}–${m.gamesB} in games, ${m.coinsA}–${m.coinsB} coins left${m.tieReason ? `, tie-break: ${m.tieReason}` : ''}`;
export function result(state, id, input, now = Date.now(), official = 'Tournament desk') {
  const m = state.matches.find(m => m.id === id);
  fail(!m || !['playing', 'tiebreak'].includes(m.status), 'This match is not in play.');
  const won = games(input);
  fail(now < m.endsAt && !won.includes(2), 'Before the match time is up, a result can be recorded only when a team has won two games.');
  if (!decide(m, won, input)) { m.status = 'tiebreak'; log(state, `${m.id} tied on ${m.coinsA}–${m.coinsB} coins left; awaiting the tie-break`, now); return; }
  m.status = 'completed'; m.completedAt = now; m.official = official;
  state.boards.find(b => b.id === m.board).availableAt = now + state.event.resetMinutes * 60000;
  log(state, `${m.id}: ${teamName(state, m.winner)} won (${scoreLine(m)})`, now); refresh(state);
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
// Fixes a recorded score. Allowed until the winner's next match is called; the bracket is re-derived.
export function correctResult(state, id, input, now = Date.now(), official = 'Tournament desk') {
  const m = state.matches.find(m => m.id === id);
  fail(!m || m.status !== 'completed' || m.bye || m.walkover, 'Only a played, completed match can be corrected.');
  // Everything is checked before anything changes, so a refused correction leaves the bracket as it was.
  const won = games(input);
  if (!won.includes(2)) { const [a, b] = coins(input); fail(a === b && (![m.teamA, m.teamB].includes(input.tieWinner) || !String(input.reason || '').trim()), 'Equal coin counts need the tie-break winner and how the tie was decided.'); }
  resetDownstream(state, m); decide(m, won, input);
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
// Every desk action in one place: whether it needs an admin, and how it changes the event. Callers
// (the local server and the live site) supply ctx = { now, official }. A handler that returns a
// value replaces the whole event (fresh event, sample); otherwise it changes the event in place.
export const actions = {
  checkin: { run: (state, input) => checkIn(state, input) },
  'confirm-payment': { run: (state, input, { now, official }) => confirmPayment(state, input.id, now, official) },
  assign: { run: (state, input, { now }) => assign(state, input.id, input.board, now) },
  unassign: { run: (state, input) => unassign(state, input.id) },
  start: { run: (state, input, { now }) => start(state, input.id, now) },
  result: { run: (state, input, { now, official }) => result(state, input.id, input, now, official) },
  'board-ready': { run: (state, input, { now }) => boardReady(state, input.board, now) },
  draw: { admin: true, run: state => createDraw(state) },
  'correct-result': { admin: true, run: (state, input, { now, official }) => correctResult(state, input.id, input, now, official) },
  walkover: { admin: true, run: (state, input, { now, official }) => walkover(state, input.id, input.winner, input.reason, now, official) },
  'undo-walkover': { admin: true, run: (state, input, { now }) => undoWalkover(state, input.id, now) },
  settings: { admin: true, run: (state, input) => { updateSettings(state, input); log(state, 'Event settings updated'); } },
  'remove-team': { admin: true, run: (state, input) => removeTeam(state, input.id) },
  demo: { admin: true, run: state => loadSample(state) },
  reset: { admin: true, run: (state, input) => freshEvent(state, input.confirm) }
};
