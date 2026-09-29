import { randomUUID, randomInt } from 'node:crypto';

export const defaults = { name: 'CARROMIA', year: '2026', venue: 'Mary Matha Church, Vijayanagar', date: '', durationMinutes: 10, resetMinutes: 5, restMinutes: 0, registrationOpen: true };
export function emptyState() { return { version: 1, event: { ...defaults }, teams: [], matches: [], boards: [1, 2, 3, 4].map(id => ({ id, availableAt: 0 })), activity: [], demo: false }; }
export function log(state, message, now = Date.now()) { state.activity.unshift({ id: randomUUID(), message, at: now }); state.activity = state.activity.slice(0, 80); }
export function fail(condition, message) { if (condition) throw new Error(message); }
export function addTeam(state, input) {
  fail(!state.event.registrationOpen || state.matches.length > 0, 'Registration is closed for this draw.');
  const clean = (s, limit = 80) => String(s ?? '').trim().slice(0, limit);
  const team = { id: `CAR-${String(state.teams.length + 1).padStart(3, '0')}`, name: clean(input.name), parish: clean(input.parish), players: (input.players || []).map(p => ({ name: clean(p.name), mobile: clean(p.mobile, 20) })), primaryContact: Number(input.primaryContact) === 1 ? 1 : 0, checkedIn: false, registeredAt: Date.now(), checkinToken: randomUUID() };
  fail(!team.name || !team.parish, 'Enter a team name and parish.');
  fail(team.players.length !== 2 || team.players.some(p => !p.name || !/^\+?[\d\s()-]{7,20}$/.test(p.mobile)), 'Enter exactly two players with valid mobile numbers.');
  fail(state.teams.some(t => t.name.toLowerCase() === team.name.toLowerCase()), 'That team name is already registered.');
  fail(state.teams.length >= 128, 'This version supports up to 128 teams.');
  state.teams.push(team); log(state, `${team.name} registered`); return team;
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
  if (state.matches.some(m => ['called', 'playing', 'tiebreak'].includes(m.status) && [m.teamA, m.teamB].some(id => ids.includes(id)))) return 'Team on another board';
  const last = Math.max(0, ...state.matches.filter(m => m.status === 'completed' && !m.bye && [m.teamA, m.teamB].some(id => ids.includes(id))).map(m => m.completedAt || 0));
  if (last + state.event.restMinutes * 60000 > now) return 'Rest period';
  return '';
}
export function assign(state, id, boardId, now = Date.now()) {
  const m = state.matches.find(m => m.id === id), b = state.boards.find(b => b.id === Number(boardId));
  fail(!m || !b, 'Match or board not found.'); fail(Boolean(eligible(state, m, now)), eligible(state, m, now));
  fail(state.matches.some(m => m.board === b.id && ['called', 'playing', 'tiebreak'].includes(m.status)), 'This board is occupied.');
  fail(b.availableAt > now, 'This board is being reset.');
  m.board = b.id; m.status = 'called'; log(state, `${m.id} called to Board ${b.id}`, now);
}
export function start(state, id, now = Date.now()) {
  const m = state.matches.find(m => m.id === id); fail(!m || m.status !== 'called', 'Call the match to a board first.');
  m.status = 'playing'; m.startedAt = now; m.endsAt = now + state.event.durationMinutes * 60000; log(state, `${m.id} started on Board ${m.board}`, now);
}
export function result(state, id, input, now = Date.now()) {
  const m = state.matches.find(m => m.id === id);
  fail(!m || !['playing', 'tiebreak'].includes(m.status), 'This match is not in play.');
  const a = Number(input.a), b = Number(input.b);
  fail(input.a === '' || input.b === '' || input.a == null || input.b == null || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 9 || b > 9, 'Remaining coins must be whole numbers from 0 to 9.');
  // Clearing every coin wins immediately; any other result waits for the timer.
  const early = now < m.endsAt;
  fail(early && (a === 0) === (b === 0), 'Before the match timer ends, a result can only be recorded when one team has cleared all its coins (0 remaining).');
  m.coinsA = a; m.coinsB = b;
  if (a === b) {
    m.status = 'tiebreak';
    if (!input.tieWinner) { log(state, `${m.id} tied at ${a}–${b}; awaiting official tie-break`, now); return; }
    fail(![m.teamA, m.teamB].includes(input.tieWinner) || !String(input.reason || '').trim(), 'Choose a tie-break winner and record the official decision.');
    m.winner = input.tieWinner; m.tieReason = String(input.reason).trim().slice(0, 300);
  } else { m.winner = a < b ? m.teamA : m.teamB; delete m.tieReason; }
  m.status = 'completed'; m.completedAt = now; m.official = 'Tournament desk';
  if (early) m.endedEarly = true; else delete m.endedEarly;
  state.boards.find(b => b.id === m.board).availableAt = now + state.event.resetMinutes * 60000;
  log(state, `${m.id}: ${state.teams.find(t => t.id === m.winner).name} won (${a}–${b} remaining${early ? ', all coins cleared before time' : ''})`, now); refresh(state);
}
export function seedDemo() {
  const s = emptyState(); s.demo = true;
  const names = ['Baseline Brothers', 'The Strikers', 'Pocket Aces', 'Royal Knights', 'Corner Kings', 'White Knights', 'Queen’s Guard', 'Black & Bold', 'Double Trouble', 'The Challengers', 'Strike Force', 'Last Coin', 'Board Brothers', 'Perfect Pocket', 'The Finishers', 'Carrom Collective'];
  const players = ['Arun', 'Joel', 'Mathew', 'Paul', 'Joseph', 'Kevin', 'Thomas', 'Mark'];
  names.forEach((name, i) => { const t = addTeam(s, { name, parish: ['Mary Matha', 'St. Thomas', 'St. Joseph', 'Holy Family'][i % 4], players: [{ name: `${players[i % 8]} Demo`, mobile: '9000000000' }, { name: `${players[(i + 3) % 8]} Demo`, mobile: '9000000000' }] }); t.checkedIn = true; });
  createDraw(s, false); for (let i = 0; i < 4; i++) assign(s, s.matches[i].id, i + 1);
  log(s, 'Sample tournament loaded — all teams are fictional'); return s;
}
