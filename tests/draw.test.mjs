import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, createDraw, recreateDraw, assign, start, removeTeam, actions, refusal, publicState, practiceEvent, updateSettings, registrationStatus } from '../lib/tournament.mjs';
import { drawChangeToken, drawChangeBlocked, thirdPlaceMatch } from '../public/fixture.js';
import { canManageDraw, drawControls, recreateDrawDialog } from '../public/draw-view.js';

function setup(n = 19) {
  const state = emptyState();
  state.teams = Array.from({ length: n }, (_, i) => ({ id: `CAR-${String(i + 1).padStart(3, '0')}`, name: `Team ${i + 1}`, checkedIn: true, status: 'confirmed', checkinToken: `qr-${i}`, lunch: 2, lunchServed: 1, payment: { txnRef: `UTR-${i}`, screenshot: true }, players: [{ name: 'A', mobile: '9000000000' }, { name: 'B' }] }));
  createDraw(state, false);
  return state;
}
const input = (state, mode = 'recreate') => ({ mode, confirm: 'REDRAW', expectedDraw: drawChangeToken(state) });

test('recreate keeps registration data and settings, removes old calls and match streams, and creates a fresh playoff', () => {
  const state = setup(), ready = state.matches.find(m => m.status === 'ready');
  assign(state, ready.id, 2);
  state.boards[0].availableAt = 9000000;
  state.media = { streamsEnabled: true, boardLayout: [{ boardId: 1, visible: true, showInfo: false }], streams: [{ boardId: 1, matchId: null, url: 'board-link' }, { boardId: null, matchId: ready.id, url: 'old-match-link' }], eventStream: { title: 'Main', enabled: true, url: 'main-link' }, gallery: [{ id: 'photo' }] };
  state.teams.push({ id: 'CAR-020', status: 'pending', payment: { txnRef: 'PENDING' } });
  const before = structuredClone(state);
  actions.draw.run(state, input(state));
  assert.notEqual(state.drawId, before.drawId);
  assert.deepEqual(state.teams, before.teams); assert.deepEqual(state.event, before.event);
  assert.deepEqual(state.boards, before.boards.map(b => ({ ...b, availableAt: 0 })));
  assert.equal(state.matches.length, 32); assert.equal(state.matches.filter(m => m.bye).length, 13);
  assert.ok(state.matches.every(m => !['called', 'playing'].includes(m.status)));
  assert.ok(state.matches.every(m => m.teamA !== 'CAR-020' && m.teamB !== 'CAR-020'));
  assert.equal(thirdPlaceMatch(state).status, 'waiting');
  assert.deepEqual(state.media, { ...before.media, streams: [before.media.streams[0]] });
  assert.ok(state.activity.some(a => a.message === before.activity[0].message));
  assert.match(state.activity[0].message, /Draw recreated/);
});

test('clear draw allows team removal and a new draw without reopening registration or deleting team data', () => {
  const state = setup(), before = structuredClone(state);
  recreateDraw(state, input(state, 'clear'));
  assert.deepEqual(state.matches, []); assert.equal(state.drawId, null);
  assert.equal(state.event.registrationOpen, false); assert.deepEqual(state.teams, before.teams);
  assert.deepEqual(state.event, before.event);
  removeTeam(state, 'CAR-019'); createDraw(state, false);
  assert.equal(state.teams.length, 18); assert.ok(thirdPlaceMatch(state));
  assert.ok(state.matches.every(m => m.teamA !== 'CAR-019' && m.teamB !== 'CAR-019'));
});

test('invalid confirmations, stale rosters and too few teams leave the existing draw untouched', () => {
  for (const override of [{ confirm: '' }, { expectedDraw: '' }, { mode: 'reset' }]) {
    const state = setup(), before = structuredClone(state);
    assert.throws(() => recreateDraw(state, { ...input(state), ...override }));
    assert.deepEqual(state, before);
  }
  const state = setup(), old = input(state);
  state.teams[0].status = 'pending'; let before = structuredClone(state);
  assert.throws(() => recreateDraw(state, old), /team list has changed/); assert.deepEqual(state, before);
  state.teams.forEach((t, i) => { t.status = i ? 'pending' : 'confirmed'; }); before = structuredClone(state);
  assert.throws(() => recreateDraw(state, input(state)), /at least two/); assert.deepEqual(state, before);
  recreateDraw(state, input(state, 'clear')); assert.equal(state.matches.length, 0);
  assert.throws(() => recreateDraw(state, input(state)), /no draw/);
});

test('recreation and clearing are blocked after play or any non-bye result, including a walkover', () => {
  for (const recorded of [{ status: 'playing' }, { startedAt: 0 }, { status: 'completed', winner: 'CAR-001' }, { rounds: [{ startedAt: 0 }] }, { status: 'completed', walkover: 'Absent' }]) {
    for (const mode of ['clear', 'recreate']) {
      const state = setup(), match = state.matches.find(m => !m.bye);
      Object.assign(match, recorded); const before = structuredClone(state);
      assert.match(drawChangeBlocked(state), /locked/);
      assert.throws(() => recreateDraw(state, input(state, mode)), /locked/); assert.deepEqual(state, before);
    }
  }
});

test('old confirmations cannot replace a new draw; board calls invalidate confirmation, check-ins do not', () => {
  const state = setup(), old = input(state);
  recreateDraw(state, old); let before = structuredClone(state);
  assert.throws(() => recreateDraw(state, old), /has changed/); assert.deepEqual(state, before);
  const reviewed = input(state), ready = state.matches.find(m => m.status === 'ready');
  assign(state, ready.id, 1); before = structuredClone(state);
  assert.throws(() => recreateDraw(state, reviewed), /has changed/); assert.deepEqual(state, before);
  const current = input(state); state.teams[0].checkedIn = false;
  const decorated = { ...state, matches: state.matches.map(m => ({ ...m, blockedReason: 'Awaiting check-in' })) };
  assert.equal(drawChangeToken(decorated), current.expectedDraw);
  recreateDraw(state, current); assert.equal(state.teams[0].checkedIn, false);
});

test('saved draws predating draw IDs can be recreated, and 128-team confirmations fit the API limit', () => {
  const state = setup(); delete state.drawId;
  recreateDraw(state, input(state)); assert.ok(state.drawId);
  const large = setup(128);
  assert.ok(JSON.stringify(input(large)).length < 20000);
});

test('clearing a sample practice draw permits registration after the admin reopens it', () => {
  const state = practiceEvent(emptyState().event);
  recreateDraw(state, input(state, 'clear'));
  assert.equal(state.practice, true); assert.equal(state.demo, false); assert.equal(state.teams.length, 16);
  assert.equal(registrationStatus(state).open, false);
  updateSettings(state, { resetMinutes: 5, restMinutes: 0, registrationOpen: true });
  assert.equal(registrationStatus(state).open, true);
});

test('draw controls and confirmation are restricted by role and become locked once a match starts', () => {
  const state = setup(); state.user = { role: 'admin' };
  assert.match(drawControls(state), /Recreate draw/);
  assert.match(recreateDrawDialog(state), /pattern="REDRAW"/);
  assert.match(recreateDrawDialog(state), /name="mode"/);
  assert.match(recreateDrawDialog(state), /Registration stays closed/);
  assert.match(recreateDrawDialog(state), /Download backup/);
  const publicCopy = publicState(state); delete publicCopy.user;
  assert.equal(canManageDraw(publicCopy), false); assert.equal(drawControls(publicCopy), '');
  for (const role of ['official', 'umpire', 'checkin', 'lunch', 'media']) {
    state.user.role = role;
    assert.equal(drawControls(state), '');
    assert.match(refusal(actions.draw, state.user), /admin/);
  }
  state.user.role = 'official'; state.practice = true;
  assert.equal(canManageDraw(state), true); assert.equal(refusal(actions.draw, state.user, true), '');
  assert.doesNotMatch(recreateDrawDialog(state), /Download backup/);
  state.practice = false; state.user.role = 'admin';
  const match = state.matches.find(m => m.status === 'ready'); assign(state, match.id, 1, 0); start(state, match.id, 0);
  assert.match(drawControls(state), /disabled/); assert.doesNotMatch(recreateDrawDialog(state), /<form/);
});
