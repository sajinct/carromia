import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addTeam, createDraw, assign, start, result, eligible, updateSettings, boardReady, removeTeam, practiceEvent, publicState, walkover, undoWalkover, correctResult, unassign } from '../lib/tournament.mjs';
function setup(n) { const s = emptyState(); for (let i = 1; i <= n; i++) { const t = addTeam(s, { name: `Team ${i}`, parish: 'Parish', players: [{ name: `P${i} A`, mobile: '9000000000' }, { name: `P${i} B`, mobile: '9000000001' }] }); t.checkedIn = true; } return s; }
test('registration requires exactly two valid players and unique team names', () => { const s = setup(1); assert.throws(() => addTeam(s, { name: 'New', parish: 'Parish', players: [] }), /exactly two/); assert.throws(() => addTeam(s, { ...s.teams[0] }), /already registered/); assert.equal(s.teams.length, 1); });
test('draw handles every team count from 2 to 128 with one champion and n-1 actual matches', () => {
  for (let n = 2; n <= 128; n++) {
    const s = setup(n); createDraw(s, false); s.event.resetMinutes = 0; let clock = 1000000;
    while (s.matches.some(m => m.status !== 'completed')) { const m = s.matches.find(m => m.status === 'ready'); assert.ok(m, `No ready match for ${n} teams`); assign(s, m.id, 1, clock); start(s, m.id, clock); clock += 600000; result(s, m.id, { a: 1, b: 4 }, clock); }
    assert.ok(s.matches.at(-1).winner); assert.equal(s.matches.filter(m => !m.bye).length, n - 1);
  }
});
test('registration closes and a second draw is rejected', () => { const s = setup(4); createDraw(s); assert.equal(s.event.registrationOpen, false); assert.throws(() => createDraw(s), /already exists/); assert.throws(() => addTeam(s, {}), /closed/); });
test('check-in and board occupancy are enforced', () => { const s = setup(4); createDraw(s, false); s.teams[0].checkedIn = false; assert.throws(() => assign(s, 'M01', 1), /check-in/); s.teams[0].checkedIn = true; assign(s, 'M01', 1); assert.throws(() => assign(s, 'M02', 1), /occupied/); assert.throws(() => assign(s, 'M01', 2), /Not ready/); });
test('result cannot be recorded before timer expires or with invalid coin counts', () => { const s = setup(2); createDraw(s); assign(s, 'M01', 1, 0); start(s, 'M01', 0); assert.throws(() => result(s, 'M01', { a: 1, b: 2 }, 599999), /timer/); for (const a of [-1, 10, 1.5, '', null, undefined, 'NaN']) assert.throws(() => result(s, 'M01', { a, b: 2 }, 600000), /whole numbers/); });
test('tie holds the board and requires an explicit winner and reason', () => { const s = setup(2); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); result(s, 'M01', { a: 3, b: 3 }, 600000); const m = s.matches[0]; assert.equal(m.status, 'tiebreak'); assert.equal(m.winner, null); assert.throws(() => result(s, m.id, { a: 3, b: 3, tieWinner: m.teamA, reason: '' }, 600000), /official decision/); result(s, m.id, { a: 3, b: 3, tieWinner: m.teamB, reason: 'Committee-approved extra play' }, 600000); assert.equal(m.status, 'completed'); assert.equal(m.winner, m.teamB); });
test('winner advances only after both predecessor matches are complete', () => { const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); result(s, 'M01', { a: 1, b: 4 }, 600000); assert.equal(s.matches[2].status, 'waiting'); assign(s, 'M02', 2, 0); start(s, 'M02', 0); result(s, 'M02', { a: 6, b: 2 }, 600000); assert.equal(s.matches[2].status, 'ready'); assert.equal(s.matches[2].teamA, s.matches[0].winner); assert.equal(s.matches[2].teamB, s.matches[1].winner); });
test('reset and rest periods block premature scheduling', () => { const s = setup(4); s.event.restMinutes = 10; createDraw(s, false); for (let i = 0; i < 2; i++) { assign(s, s.matches[i].id, i + 1, 1000000); start(s, s.matches[i].id, 1000000); result(s, s.matches[i].id, { a: 1, b: 2 }, 1600000); } assert.equal(eligible(s, s.matches[2], 1600000), 'Rest period'); assert.equal(eligible(s, s.matches[2], 2200000), ''); s.event.restMinutes = 0; assert.throws(() => assign(s, 'M03', 1, 1600000), /reset/); assign(s, 'M03', 1, 1900000); assert.equal(s.matches[2].status, 'called'); });
test('a team that clears all its coins wins before the timer ends; other early results are refused', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  for (const [a, b] of [[1, 3], [2, 2], [0, 0]]) assert.throws(() => result(s, 'M01', { a, b }, 120000), /cleared all its coins/);
  assert.equal(s.matches[0].status, 'playing');
  result(s, 'M01', { a: 4, b: 0 }, 120000); const m = s.matches[0];
  assert.equal(m.status, 'completed'); assert.equal(m.winner, m.teamB); assert.equal(m.endedEarly, true); assert.equal(m.completedAt, 120000);
  assert.equal(s.boards[0].availableAt, 120000 + 5 * 60000, 'board reset starts from the early finish');
  assign(s, 'M02', 2, 0); start(s, 'M02', 0); result(s, 'M02', { a: 0, b: 3 }, 600000); assert.equal(s.matches[1].endedEarly, undefined, 'a 0 at full time is a normal result');
});
test('event defaults to the poster date and time; start time is validated', () => {
  const s = emptyState(); assert.equal(s.event.date, '2026-11-15'); assert.equal(s.event.startTime, '09:00');
  const base = { durationMinutes: 10, resetMinutes: 5, restMinutes: 0 };
  for (const startTime of ['9am', '24:00', '09:60']) assert.throws(() => updateSettings(emptyState(), { ...base, startTime }), /start time/);
  updateSettings(s, { ...base, startTime: '14:30', registrationOpen: true }); assert.equal(s.event.startTime, '14:30'); assert.equal(s.event.registrationOpen, true);
  updateSettings(s, { ...base, startTime: '' }); assert.equal(s.event.startTime, '');
});
test('officials can end a board reset early; only a resetting, empty board can be marked ready', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  assert.throws(() => boardReady(s, 1, 60000), /match in progress/);
  result(s, 'M01', { a: 1, b: 4 }, 600000); assert.equal(s.boards[0].availableAt, 900000);
  assert.throws(() => assign(s, 'M02', 1, 620000), /being reset/);
  boardReady(s, 1, 620000); assert.equal(s.boards[0].availableAt, 620000); assert.match(s.activity[0].message, /Board 1 reset early/);
  assign(s, 'M02', 1, 620000); assert.equal(s.matches[1].board, 1);
  assert.throws(() => boardReady(s, 2, 620000), /already available/); assert.throws(() => boardReady(s, 9, 620000), /not found/);
  assert.equal(s.matches[0].board, 1, 'the finished match keeps its board so the winner can be shown there');
});
test('admins can remove teams before the draw; removed IDs are never reused', () => {
  const s = setup(3); removeTeam(s, 'CAR-002');
  assert.deepEqual(s.teams.map(t => t.id), ['CAR-001', 'CAR-003']); assert.match(s.activity[0].message, /Team 2 \(CAR-002\) removed/);
  const t = addTeam(s, { name: 'Late Entry', parish: 'P', players: [{ name: 'A', mobile: '9000000000' }, { name: 'B', mobile: '9000000001' }] }); assert.equal(t.id, 'CAR-004');
  removeTeam(s, 'CAR-004'); assert.equal(addTeam(s, { name: 'Another', parish: 'P', players: [{ name: 'A', mobile: '9000000000' }, { name: 'B', mobile: '9000000001' }] }).id, 'CAR-005', 'even the newest ID is not reused');
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
  assign(s, m2.id, 1, 1000); start(s, m2.id, 1000); result(s, m2.id, { a: 1, b: 3 }, 601000);
  s.teams.find(t => t.id === m1.teamB).checkedIn = false; assert.equal(eligible(s, m1), 'Awaiting check-in');
  assert.throws(() => walkover(s, m1.id, 'CAR-999', ''), /which team/);
  walkover(s, m1.id, m1.teamA, ' Team B absent ', 700000, 'Asha Admin');
  assert.equal(m1.status, 'completed'); assert.equal(m1.winner, m1.teamA); assert.equal(m1.walkover, 'Team B absent'); assert.equal(m1.official, 'Asha Admin'); assert.equal(m1.coinsA, undefined);
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
  assign(s, m1.id, 1, 0); start(s, m1.id, 0); result(s, m1.id, { a: 4, b: 0 }, 600000, 'Omar Official');
  assert.equal(m1.winner, m1.teamB); assert.equal(m1.official, 'Omar Official');
  assign(s, m2.id, 2, 0); start(s, m2.id, 0); result(s, m2.id, { a: 2, b: 5 }, 600000);
  assert.equal(final.status, 'ready'); assert.equal(final.teamA, m1.teamB);
  for (const bad of [{ a: 10, b: 0 }, { a: '', b: 1 }]) assert.throws(() => correctResult(s, m1.id, bad), /whole numbers/);
  assert.throws(() => correctResult(s, m1.id, { a: 3, b: 3 }), /tie-break winner/);
  correctResult(s, m1.id, { a: 0, b: 4 }, 700000, 'Asha Admin');
  assert.equal(m1.winner, m1.teamA); assert.equal(m1.corrected, true); assert.equal(m1.official, 'Asha Admin'); assert.equal(m1.completedAt, 600000, 'the original time is kept');
  assert.equal(final.status, 'ready'); assert.deepEqual([final.teamA, final.teamB], [m1.teamA, m2.winner]); assert.match(s.activity[0].message, /M01 corrected/);
  correctResult(s, m1.id, { a: 2, b: 2, tieWinner: m1.teamB, reason: 'Replay won by B' }); assert.equal(m1.winner, m1.teamB); assert.equal(m1.tieReason, 'Replay won by B'); assert.equal(final.teamA, m1.teamB);
  assign(s, final.id, 1, 700000);
  assert.throws(() => correctResult(s, m1.id, { a: 0, b: 4 }), /already on a board/);
  unassign(s, final.id); correctResult(s, m1.id, { a: 0, b: 4 }); assert.equal(final.teamA, m1.teamA);
  assign(s, final.id, 1, 700000); start(s, final.id, 700000); result(s, final.id, { a: 1, b: 2 }, 1300000);
  assert.throws(() => correctResult(s, m1.id, { a: 4, b: 0 }), /already been played/);
  assert.throws(() => correctResult(s, 'M99', { a: 1, b: 2 }), /Only a played/);
});
