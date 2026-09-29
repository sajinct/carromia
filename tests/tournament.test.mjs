import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addTeam, createDraw, assign, start, result, eligible, updateSettings, boardReady, removeTeam, practiceEvent, publicState, walkover, undoWalkover, correctResult, unassign, actions, registrationStatus, parishKey } from '../lib/tournament.mjs';
const entry = (name, parish = 'Parish') => ({ name, parish, adults: true, players: [{ name: `${name} A`, mobile: '9000000000' }, { name: `${name} B`, mobile: '9000000001' }] });
// An event without registration limits, so the draw and match tests can use any number of teams on any date.
function open() { const s = emptyState(); Object.assign(s.event, { maxTeams: 128, maxTeamsPerParish: 128, registrationDeadline: '' }); return s; }
function setup(n) { const s = open(); for (let i = 1; i <= n; i++) addTeam(s, entry(`Team ${i}`)).checkedIn = true; return s; }
const MATCH = 30 * 60000, A_WINS = { gamesA: 2, gamesB: 0 }, B_WINS = { gamesA: 1, gamesB: 2 };
test('registration requires exactly two valid players, unique team names and the 18+ confirmation', () => {
  const s = setup(1);
  assert.throws(() => addTeam(s, { ...entry('New'), players: [] }), /exactly two/); assert.throws(() => addTeam(s, entry('team 1')), /already registered/);
  assert.throws(() => addTeam(s, { ...entry('New'), adults: false }), /18 or older/); assert.throws(() => addTeam(s, { ...entry('New'), adults: 'yes' }), /18 or older/);
  assert.equal(s.teams.length, 1);
});
test('registration limits: team slots, teams per parish, deadline and lunch booking', () => {
  const s = emptyState(), before = Date.parse('2026-11-10T18:29:00Z'), after = Date.parse('2026-11-10T18:30:00Z');
  assert.deepEqual([s.event.maxTeams, s.event.maxTeamsPerParish, s.event.registrationDeadline, s.event.entryFee], [64, 4, '2026-11-10', 500]);
  for (const parish of ['St. Thomas', 'st thomas', 'St Thomas Church', ' ST. THOMAS PARISH ']) addTeam(s, entry(`Thomas ${parish}`, parish), before);
  assert.equal(parishKey('St. Thomas Church'), 'st thomas');
  assert.throws(() => addTeam(s, entry('Fifth', 'St.Thomas'), before), /St\.Thomas already has 4 teams registered/);
  assert.equal(addTeam(s, { ...entry('Other', 'Holy Family'), lunch: '2' }, before).lunch, 2);
  assert.deepEqual([addTeam(s, { ...entry('L1', 'A'), lunch: 9 }, before).lunch, addTeam(s, { ...entry('L2', 'B'), lunch: -1 }, before).lunch, addTeam(s, entry('L3', 'C'), before).lunch], [2, 0, 0]);
  // The deadline is the end of 10 November in India (18:30 UTC); practice events ignore it.
  assert.deepEqual(registrationStatus(s, before), { open: true, reason: '', slotsLeft: 56, maxTeams: 64 });
  assert.equal(registrationStatus(s, after).reason, 'Registration closed on 10 November 2026.'); assert.throws(() => addTeam(s, entry('Late', 'D'), after), /closed on 10 November 2026/);
  assert.equal(registrationStatus({ ...s, practice: true }, after).open, true);
  s.event.registrationDeadline = ''; assert.equal(registrationStatus(s, after).open, true);
  s.event.maxTeams = 8; assert.equal(registrationStatus(s, before).reason, 'All 8 team slots are taken. Registration is full.'); assert.throws(() => addTeam(s, entry('Ninth', 'E'), before), /Registration is full/);
  // Events saved before these settings existed use the defaults.
  const old = emptyState(); for (const key of ['maxTeams', 'maxTeamsPerParish', 'registrationDeadline', 'entryFee']) delete old.event[key];
  assert.equal(registrationStatus(old, before).slotsLeft, 64); assert.equal(registrationStatus(old, after).open, false);
});
test('draw handles every team count from 2 to 128 with one champion and n-1 actual matches', () => {
  for (let n = 2; n <= 128; n++) {
    const s = setup(n); createDraw(s, false); s.event.resetMinutes = 0; let clock = 1000000;
    while (s.matches.some(m => m.status !== 'completed')) { const m = s.matches.find(m => m.status === 'ready'); assert.ok(m, `No ready match for ${n} teams`); assign(s, m.id, 1, clock); start(s, m.id, clock); clock += 600000; result(s, m.id, B_WINS, clock); }
    assert.ok(s.matches.at(-1).winner); assert.equal(s.matches.filter(m => !m.bye).length, n - 1);
  }
});
test('registration closes and a second draw is rejected', () => { const s = setup(4); createDraw(s); assert.equal(s.event.registrationOpen, false); assert.throws(() => createDraw(s), /already exists/); assert.throws(() => addTeam(s, {}), /closed/); });
test('check-in and board occupancy are enforced', () => { const s = setup(4); createDraw(s, false); s.teams[0].checkedIn = false; assert.throws(() => assign(s, 'M01', 1), /check-in/); s.teams[0].checkedIn = true; assign(s, 'M01', 1); assert.throws(() => assign(s, 'M02', 1), /occupied/); assert.throws(() => assign(s, 'M01', 2), /Not ready/); });
test('a match lasts 30 minutes; before time is up a result needs a team with two games, and scores are validated', () => {
  const s = setup(2); createDraw(s); assign(s, 'M01', 1, 0); start(s, 'M01', 0); assert.equal(s.matches[0].endsAt, MATCH);
  for (const score of [{ gamesA: 1, gamesB: 0, a: 1, b: 2 }, { gamesA: 1, gamesB: 1, a: 0, b: 4 }, { gamesA: 0, gamesB: 0, a: 3, b: 3 }]) assert.throws(() => result(s, 'M01', score, MATCH - 1), /won two games/);
  for (const gamesA of [-1, 3, 1.5, '', null, undefined, 'x']) assert.throws(() => result(s, 'M01', { gamesA, gamesB: 1, a: 1, b: 2 }, MATCH), /Games won/);
  assert.throws(() => result(s, 'M01', { gamesA: 2, gamesB: 2 }, MATCH), /only one team can win two games/);
  for (const a of [-1, 10, 1.5, '', null, undefined, 'NaN']) assert.throws(() => result(s, 'M01', { gamesA: 1, gamesB: 0, a, b: 2 }, MATCH), /whole numbers/);
  assert.equal(s.matches[0].status, 'playing');
});
test('the first team to win two games wins, even before time is up', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  result(s, 'M01', B_WINS, 720000, 'Omar Official'); const m = s.matches[0];
  assert.equal(m.status, 'completed'); assert.equal(m.winner, m.teamB); assert.deepEqual([m.gamesA, m.gamesB, m.coinsA, m.coinsB], [1, 2, undefined, undefined]); assert.equal(m.completedAt, 720000); assert.equal(m.official, 'Omar Official');
  assert.equal(s.boards[0].availableAt, 720000 + 5 * 60000, 'board reset starts when the match finishes'); assert.match(s.activity[0].message, /M01: Team 4 won \(1–2 in games\)/);
  assign(s, 'M02', 2, 0); start(s, 'M02', 0); result(s, 'M02', { gamesA: '2', gamesB: '1', a: '', b: '' }, MATCH + 5000); assert.equal(s.matches[1].winner, s.matches[1].teamA, 'form values arrive as text');
});
test('when time runs out the team with fewer coins left wins, whatever the games', () => {
  const s = setup(2); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  result(s, 'M01', { gamesA: 1, gamesB: 0, a: 5, b: 2 }, MATCH); const m = s.matches[0];
  assert.equal(m.status, 'completed'); assert.equal(m.winner, m.teamB); assert.deepEqual([m.gamesA, m.gamesB, m.coinsA, m.coinsB], [1, 0, 5, 2]);
  assert.match(s.activity[0].message, /time up at 1–0 in games, 5–2 coins left/);
});
test('equal coins hold the board for the tie-break, which needs a winner and how it was decided', () => {
  const s = setup(2); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); result(s, 'M01', { gamesA: 1, gamesB: 1, a: 3, b: 3 }, MATCH); const m = s.matches[0];
  assert.equal(m.status, 'tiebreak'); assert.equal(m.winner, null); assert.deepEqual([m.gamesA, m.gamesB, m.coinsA, m.coinsB], [1, 1, 3, 3]);
  assert.throws(() => result(s, m.id, { gamesA: 1, gamesB: 1, a: 3, b: 3, tieWinner: m.teamA, reason: '' }, MATCH), /how the tie was decided/);
  assert.throws(() => result(s, m.id, { gamesA: 1, gamesB: 1, a: 3, b: 3, tieWinner: 'CAR-999', reason: 'Golden Pocket' }, MATCH), /tie-break winner/);
  result(s, m.id, { gamesA: 1, gamesB: 1, a: 3, b: 3, tieWinner: m.teamB, reason: 'Golden Pocket' }, MATCH + 60000);
  assert.equal(m.status, 'completed'); assert.equal(m.winner, m.teamB); assert.equal(m.tieReason, 'Golden Pocket'); assert.match(s.activity[0].message, /tie-break: Golden Pocket/);
});
test('winner advances only after both predecessor matches are complete', () => { const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); result(s, 'M01', A_WINS, 600000); assert.equal(s.matches[2].status, 'waiting'); assign(s, 'M02', 2, 0); start(s, 'M02', 0); result(s, 'M02', B_WINS, 600000); assert.equal(s.matches[2].status, 'ready'); assert.equal(s.matches[2].teamA, s.matches[0].winner); assert.equal(s.matches[2].teamB, s.matches[1].winner); });
test('reset and rest periods block premature scheduling', () => { const s = setup(4); s.event.restMinutes = 10; createDraw(s, false); for (let i = 0; i < 2; i++) { assign(s, s.matches[i].id, i + 1, 1000000); start(s, s.matches[i].id, 1000000); result(s, s.matches[i].id, A_WINS, 1600000); } assert.equal(eligible(s, s.matches[2], 1600000), 'Rest period'); assert.equal(eligible(s, s.matches[2], 2200000), ''); s.event.restMinutes = 0; assert.throws(() => assign(s, 'M03', 1, 1600000), /reset/); assign(s, 'M03', 1, 1900000); assert.equal(s.matches[2].status, 'called'); });
test('event defaults follow the poster; settings are validated', () => {
  const s = emptyState(); assert.equal(s.event.date, '2026-11-15'); assert.equal(s.event.startTime, '09:00'); assert.equal(s.event.durationMinutes, 30);
  const base = { durationMinutes: 30, resetMinutes: 5, restMinutes: 0 };
  for (const startTime of ['9am', '24:00', '09:60']) assert.throws(() => updateSettings(emptyState(), { ...base, startTime }), /start time/);
  updateSettings(s, { ...base, startTime: '14:30', registrationOpen: true }); assert.equal(s.event.startTime, '14:30'); assert.equal(s.event.registrationOpen, true); assert.equal(s.event.maxTeams, 64, 'limits are kept when not sent');
  updateSettings(s, { ...base, startTime: '' }); assert.equal(s.event.startTime, '');
  for (const bad of [{ maxTeams: 1 }, { maxTeams: 129 }, { maxTeams: '' }, { maxTeamsPerParish: 0 }, { entryFee: -1 }, { entryFee: 2.5 }]) assert.throws(() => updateSettings(emptyState(), { ...base, ...bad }), /Invalid value/);
  for (const registrationDeadline of ['10/11/2026', '2026-13-45', 'soon']) assert.throws(() => updateSettings(emptyState(), { ...base, registrationDeadline }), /registration deadline/);
  updateSettings(s, { ...base, maxTeams: '32', maxTeamsPerParish: '2', entryFee: '750', registrationDeadline: '2026-11-12' });
  assert.deepEqual([s.event.maxTeams, s.event.maxTeamsPerParish, s.event.entryFee, s.event.registrationDeadline], [32, 2, 750, '2026-11-12']);
  updateSettings(s, { ...base, registrationDeadline: '' }); assert.equal(s.event.registrationDeadline, '', 'an empty deadline means none');
});
test('officials can end a board reset early; only a resetting, empty board can be marked ready', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  assert.throws(() => boardReady(s, 1, 60000), /match in progress/);
  result(s, 'M01', A_WINS, 600000); assert.equal(s.boards[0].availableAt, 900000);
  assert.throws(() => assign(s, 'M02', 1, 620000), /being reset/);
  boardReady(s, 1, 620000); assert.equal(s.boards[0].availableAt, 620000); assert.match(s.activity[0].message, /Board 1 reset early/);
  assign(s, 'M02', 1, 620000); assert.equal(s.matches[1].board, 1);
  assert.throws(() => boardReady(s, 2, 620000), /already available/); assert.throws(() => boardReady(s, 9, 620000), /not found/);
  assert.equal(s.matches[0].board, 1, 'the finished match keeps its board so the winner can be shown there');
});
test('admins can remove teams before the draw; removed IDs are never reused', () => {
  const s = setup(3); removeTeam(s, 'CAR-002');
  assert.deepEqual(s.teams.map(t => t.id), ['CAR-001', 'CAR-003']); assert.match(s.activity[0].message, /Team 2 \(CAR-002\) removed/);
  const t = addTeam(s, entry('Late Entry', 'P')); assert.equal(t.id, 'CAR-004');
  removeTeam(s, 'CAR-004'); assert.equal(addTeam(s, entry('Another', 'P')).id, 'CAR-005', 'even the newest ID is not reused');
  assert.throws(() => removeTeam(s, 'CAR-999'), /not found/);
  createDraw(s); assert.throws(() => removeTeam(s, 'CAR-001'), /after the draw/);
});
test('the practice event is the sample tournament with the real event details and is marked practice', () => {
  const p = practiceEvent({ ...emptyState().event, venue: 'Hall B', registrationOpen: true });
  assert.equal(p.practice, true); assert.equal(p.demo, true); assert.equal(p.teams.length, 16); assert.equal(p.event.venue, 'Hall B'); assert.equal(p.event.registrationOpen, false);
  assert.equal(publicState(p).teams[0].players[0].mobile, undefined);
});
test('walkover awards an unplayed match without check-in, starts no rest period, and can be undone', () => {
  const s = setup(4); createDraw(s, false); s.event.restMinutes = 10;
  const [m1, m2, final] = s.matches;
  assign(s, m2.id, 1, 1000); start(s, m2.id, 1000); result(s, m2.id, A_WINS, 601000);
  s.teams.find(t => t.id === m1.teamB).checkedIn = false; assert.equal(eligible(s, m1), 'Awaiting check-in');
  assert.throws(() => walkover(s, m1.id, 'CAR-999', ''), /which team/);
  walkover(s, m1.id, m1.teamA, ' Team B absent ', 700000, 'Asha Admin');
  assert.equal(m1.status, 'completed'); assert.equal(m1.winner, m1.teamA); assert.equal(m1.walkover, 'Team B absent'); assert.equal(m1.official, 'Asha Admin'); assert.equal(m1.gamesA, undefined);
  assert.equal(final.status, 'ready'); assert.deepEqual([final.teamA, final.teamB], [m1.teamA, m2.winner]);
  assert.equal(eligible(s, final, 1200000), 'Rest period', 'the played match still needs rest'); assert.equal(eligible(s, final, 1201000), '', 'a walkover does not start a rest period');
  assert.throws(() => walkover(s, m1.id, m1.teamA, ''), /not started/);
  undoWalkover(s, m1.id, 800000);
  assert.equal(m1.status, 'ready'); assert.equal(m1.winner, null); assert.equal(m1.walkover, undefined); assert.equal(final.status, 'waiting'); assert.equal(final.teamA, null);
  // A called match can be awarded too; its board is freed without a reset period.
  s.teams.find(t => t.id === m1.teamB).checkedIn = true; assign(s, m1.id, 2, 900000); walkover(s, m1.id, m1.teamB, '', 900000);
  assert.equal(m1.board, null); assert.equal(m1.walkover, 'Opponent did not show'); assert.equal(final.teamA, m1.teamB);
  assign(s, final.id, 2, 1300000); assert.equal(final.board, 2);
});
test('a recorded score can be corrected until the next round is called; the bracket is re-derived', () => {
  const s = setup(4); createDraw(s, false); s.event.resetMinutes = 0;
  const [m1, m2, final] = s.matches;
  assign(s, m1.id, 1, 0); start(s, m1.id, 0); result(s, m1.id, B_WINS, 600000, 'Omar Official');
  assert.equal(m1.winner, m1.teamB); assert.equal(m1.official, 'Omar Official');
  assign(s, m2.id, 2, 0); start(s, m2.id, 0); result(s, m2.id, A_WINS, 600000);
  assert.equal(final.status, 'ready'); assert.equal(final.teamA, m1.teamB);
  for (const bad of [{ gamesA: 3, gamesB: 0 }, { gamesA: '', gamesB: 1 }]) assert.throws(() => correctResult(s, m1.id, bad), /Games won/);
  for (const bad of [{ gamesA: 1, gamesB: 0, a: 10, b: 0 }, { gamesA: 1, gamesB: 1, a: '', b: 1 }]) assert.throws(() => correctResult(s, m1.id, bad), /whole numbers/);
  assert.throws(() => correctResult(s, m1.id, { gamesA: 1, gamesB: 1, a: 3, b: 3 }), /tie-break winner/);
  assert.equal(m1.winner, m1.teamB, 'a refused correction changes nothing'); assert.equal(final.status, 'ready');
  correctResult(s, m1.id, { gamesA: 2, gamesB: 1 }, 700000, 'Asha Admin');
  assert.equal(m1.winner, m1.teamA); assert.equal(m1.corrected, true); assert.equal(m1.official, 'Asha Admin'); assert.equal(m1.completedAt, 600000, 'the original time is kept');
  assert.equal(final.status, 'ready'); assert.deepEqual([final.teamA, final.teamB], [m1.teamA, m2.winner]); assert.match(s.activity[0].message, /M01 corrected/);
  // Corrected to a match that ran out of time: decided on coins left, then on the tie-break.
  correctResult(s, m1.id, { gamesA: 1, gamesB: 0, a: 4, b: 1 }); assert.equal(m1.winner, m1.teamB); assert.deepEqual([m1.coinsA, m1.coinsB], [4, 1]);
  correctResult(s, m1.id, { gamesA: 1, gamesB: 1, a: 2, b: 2, tieWinner: m1.teamA, reason: 'Sudden death' }); assert.equal(m1.winner, m1.teamA); assert.equal(m1.tieReason, 'Sudden death'); assert.equal(final.teamA, m1.teamA);
  correctResult(s, m1.id, B_WINS); assert.equal(m1.winner, m1.teamB); assert.deepEqual([m1.coinsA, m1.tieReason], [undefined, undefined], 'a win on games clears the coins and tie-break');
  assign(s, final.id, 1, 700000);
  assert.throws(() => correctResult(s, m1.id, A_WINS), /already on a board/);
  unassign(s, final.id); correctResult(s, m1.id, A_WINS); assert.equal(final.teamA, m1.teamA);
  assign(s, final.id, 1, 700000); start(s, final.id, 700000); result(s, final.id, A_WINS, 1300000);
  assert.throws(() => correctResult(s, m1.id, B_WINS), /already been played/);
  assert.throws(() => correctResult(s, 'M99', A_WINS), /Only a played/);
});
test('the action registry names every desk action and flags the admin-only ones', () => {
  assert.deepEqual(Object.keys(actions).sort(), ['assign', 'board-ready', 'checkin', 'correct-result', 'demo', 'draw', 'remove-team', 'reset', 'result', 'settings', 'start', 'unassign', 'undo-walkover', 'walkover']);
  assert.deepEqual(Object.entries(actions).filter(([, a]) => a.admin).map(([k]) => k).sort(), ['correct-result', 'demo', 'draw', 'remove-team', 'reset', 'settings', 'undo-walkover', 'walkover']);
  const s = setup(2); actions.draw.run(s, {}, {}); actions.assign.run(s, { id: 'M01', board: 1 }, { now: 0 }); actions.start.run(s, { id: 'M01' }, { now: 0 });
  actions.result.run(s, { id: 'M01', gamesA: 2, gamesB: 1 }, { now: 600000, official: 'Asha Admin' }); assert.equal(s.matches[0].official, 'Asha Admin');
  assert.equal(actions.settings.run(s, { name: 'Cup', venue: 'Hall', durationMinutes: 8, resetMinutes: 2, restMinutes: 0 }, {}), undefined); assert.equal(s.event.name, 'Cup'); assert.match(s.activity[0].message, /settings updated/);
  const fresh = actions.reset.run(s, { confirm: 'RESET' }, {}); assert.equal(fresh.teams.length, 0); assert.equal(fresh.event.name, 'Cup');
});
