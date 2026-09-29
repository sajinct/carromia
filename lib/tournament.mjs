import { randomUUID, randomInt } from 'node:crypto';

export const defaults = { name: 'CARROMIA', year: '2026', venue: 'Mary Matha Church, Vijayanagar', date: '2026-11-15', startTime: '09:00', durationMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true };
export function emptyState() { return { version: 1, event: { ...defaults }, teams: [], matches: [], boards: [1, 2, 3, 4].map(id => ({ id, availableAt: 0 })), activity: [], demo: false }; }
export function log(state, message, now = Date.now()) { state.activity.unshift({ id: randomUUID(), message, at: now }); state.activity = state.activity.slice(0, 80); }
export function fail(condition, message) { if (condition) throw new Error(message); }
// A match that occupies a board right now.
export const isLive = m => ['called', 'playing', 'tiebreak'].includes(m.status);
const teamName = (state, id) => state.teams.find(t => t.id === id)?.name ?? id;
export function addTeam(state, input) {
  fail(!state.event.registrationOpen || state.matches.length > 0, 'Registration is closed for this draw.');
  const clean = (s, limit = 80) => String(s ?? '').trim().slice(0, limit);
  const team = { id: '', name: clean(input.name), parish: clean(input.parish), players: (input.players || []).map(p => ({ name: clean(p.name), mobile: clean(p.mobile, 20) })), primaryContact: Number(input.primaryContact) === 1 ? 1 : 0, checkedIn: false, registeredAt: Date.now(), checkinToken: randomUUID() };
  fail(!team.name || !team.parish, 'Enter a team name and parish.');
  fail(team.players.length !== 2 || team.players.some(p => !p.name || !/^\+?[\d\s()-]{7,20}$/.test(p.mobile)), 'Enter exactly two players with valid mobile numbers.');
  fail(state.teams.some(t => t.name.toLowerCase() === team.name.toLowerCase()), 'That team name is already registered.');
  fail(state.teams.length >= 128, 'This version supports up to 128 teams.');
  team.id = nextTeamId(state); state.teams.push(team); log(state, `${team.name} registered`); return team;
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
  fail(state.teams.length < 2, 'Register at least two teams before creating a draw.');
  const teams = [...state.teams];
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
export function publicState(state) { return { ...state, teams: state.teams.map(({ checkinToken, ...t }) => ({ ...t, players: t.players.map(p => ({ name: p.name })) })), activity: [] }; }
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
function coins(input) {
  const a = Number(input.a), b = Number(input.b);
  fail(input.a === '' || input.b === '' || input.a == null || input.b == null || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 9 || b > 9, 'Remaining coins must be whole numbers from 0 to 9.');
  return [a, b];
}
// Records the coin counts and picks the winner. Returns false when equal counts still await an official decision.
function decide(m, a, b, input) {
  m.coinsA = a; m.coinsB = b;
  if (a === b) {
    if (!input.tieWinner) return false;
    fail(![m.teamA, m.teamB].includes(input.tieWinner) || !String(input.reason || '').trim(), 'Choose a tie-break winner and record the official decision.');
    m.winner = input.tieWinner; m.tieReason = String(input.reason).trim().slice(0, 300);
  } else { m.winner = a < b ? m.teamA : m.teamB; delete m.tieReason; }
  return true;
}
export function result(state, id, input, now = Date.now(), official = 'Tournament desk') {
  const m = state.matches.find(m => m.id === id);
  fail(!m || !['playing', 'tiebreak'].includes(m.status), 'This match is not in play.');
  const [a, b] = coins(input);
  // Clearing every coin wins immediately; any other result waits for the timer.
  const early = now < m.endsAt;
  fail(early && (a === 0) === (b === 0), 'Before the match timer ends, a result can only be recorded when one team has cleared all its coins (0 remaining).');
  if (!decide(m, a, b, input)) { m.status = 'tiebreak'; log(state, `${m.id} tied at ${a}–${b}; awaiting official tie-break`, now); return; }
  m.status = 'completed'; m.completedAt = now; m.official = official;
  if (early) m.endedEarly = true; else delete m.endedEarly;
  state.boards.find(b => b.id === m.board).availableAt = now + state.event.resetMinutes * 60000;
  log(state, `${m.id}: ${teamName(state, m.winner)} won (${a}–${b} remaining${early ? ', all coins cleared before time' : ''})`, now); refresh(state);
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
  const [a, b] = coins(input);
  resetDownstream(state, m);
  fail(!decide(m, a, b, input), 'Equal counts need a tie-break winner and the official decision.');
  m.corrected = true; m.correctedAt = now; m.official = official;
  log(state, `${m.id} corrected: ${teamName(state, m.winner)} won (${a}–${b} remaining)`, now); refresh(state);
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
  names.forEach((name, i) => { const t = addTeam(s, { name, parish: ['Mary Matha', 'St. Thomas', 'St. Joseph', 'Holy Family'][i % 4], players: [{ name: `${players[i % 8]} Demo`, mobile: '9000000000' }, { name: `${players[(i + 3) % 8]} Demo`, mobile: '9000000000' }] }); t.checkedIn = true; });
  createDraw(s, false); for (let i = 0; i < 4; i++) assign(s, s.matches[i].id, i + 1);
  log(s, 'Sample tournament loaded — all teams are fictional'); return s;
}
// Every desk action in one place: whether it needs an admin, and how it changes the event. Callers
// (the local server and the live site) supply ctx = { now, official }. A handler that returns a
// value replaces the whole event (fresh event, sample); otherwise it changes the event in place.
export const actions = {
  checkin: { run: (state, input) => checkIn(state, input) },
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
