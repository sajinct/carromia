import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addTeam, createDraw, assign, start, result, eligible, updateSettings } from '../lib/tournament.mjs';
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
