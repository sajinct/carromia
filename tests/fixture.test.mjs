import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { emptyState, createDraw, assign, start, roundWinner, nextRound, correctResult, walkover, undoWalkover, unassign, eligible, publicState } from '../lib/tournament.mjs';
import { finalMatch, thirdPlaceMatch, participantLabel } from '../public/fixture.js';
import { overlayMarkup } from '../public/overlay-view.js';

function draw(n = 4) {
  const state = emptyState();
  state.teams = Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}`, players: [], parish: 'Parish', checkedIn: true }));
  state.event.resetMinutes = 0;
  createDraw(state, false);
  return state;
}
function play(state, match, side = 'A', at = 1000000, board = 1) {
  assign(state, match.id, board, at); start(state, match.id, at);
  roundWinner(state, match.id, match[`team${side}`], at + 1);
  nextRound(state, match.id, at + 2);
  roundWinner(state, match.id, match[`team${side}`], at + 3);
}
function semifinals(state) { const [a, b] = state.matches; play(state, a); play(state, b, 'B', 2000000); return [a, b]; }
const correction = (match, side) => ({ round1: match[`team${side}`], round2: match[`team${side}`] });

test('third-place waits for both semifinal losers and can be played before the final', () => {
  const state = draw(), final = finalMatch(state), third = thirdPlaceMatch(state), [a, b] = state.matches;
  assert.equal(participantLabel(state, third, 0, id => id), `Loser of ${a.id}`);
  play(state, a);
  assert.equal(third.status, 'waiting'); assert.equal(final.status, 'waiting');
  assert.equal(participantLabel(state, third, 0, id => id), a.teamB);
  assert.equal(participantLabel(state, final, 0, id => id), a.teamA);
  play(state, b, 'B', 2000000);
  assert.deepEqual([third.teamA, third.teamB, third.status], [a.teamB, b.teamA, 'ready']);
  assert.deepEqual([final.teamA, final.teamB, final.status], [a.teamA, b.teamB, 'ready']);
  play(state, third, 'B', 3000000);
  assert.equal(third.winner, b.teamA); assert.equal(final.winner, null);
  play(state, final, 'A', 4000000);
  assert.equal(final.winner, a.teamA); assert.equal(third.winner, b.teamA);
  assert.equal(thirdPlaceMatch(publicState(state)).winner, third.winner);
});

test('third-place uses the same check-in, rest period, scoring and board overlay as other matches', () => {
  const state = draw(); semifinals(state); const third = thirdPlaceMatch(state);
  state.event.restMinutes = 10;
  assert.equal(eligible(state, third, 2000003), 'Rest period');
  state.teams.find(t => t.id === third.teamA).checkedIn = false;
  assert.equal(eligible(state, third, 3000000), 'Awaiting check-in');
  state.teams.find(t => t.id === third.teamA).checkedIn = true;
  assign(state, third.id, 1, 3000000); start(state, third.id, 3000000);
  const overlay = overlayMarkup(publicState(state), 1, { now: 3000001 });
  assert.match(overlay, /Third-place playoff/); assert.match(overlay, /Team/);
});

test('semifinal corrections update both final and playoff and refuse atomically once either is on a board or completed', () => {
  for (const target of ['final', 'third']) {
    const state = draw(), [a] = semifinals(state), final = finalMatch(state), third = thirdPlaceMatch(state);
    correctResult(state, a.id, correction(a, 'B'));
    assert.equal(final.teamA, a.teamB); assert.equal(third.teamA, a.teamA);
    const next = target === 'final' ? final : third;
    assign(state, next.id, 1, 3000000);
    let before = structuredClone(state);
    assert.throws(() => correctResult(state, a.id, correction(a, 'A')), /already on a board/);
    assert.deepEqual(state, before);
    unassign(state, next.id); correctResult(state, a.id, correction(a, 'A'));
    assert.equal(final.teamA, a.teamA); assert.equal(third.teamA, a.teamB);
    play(state, next, 'A', 4000000);
    before = structuredClone(state);
    assert.throws(() => correctResult(state, a.id, correction(a, 'B')), /already been played/);
    assert.deepEqual(state, before);
  }
});

test('semifinal walkovers populate and undo both placement matches; playoff walkovers never affect the champion', () => {
  const state = draw(), [a, b] = state.matches, final = finalMatch(state), third = thirdPlaceMatch(state);
  walkover(state, a.id, a.teamA, 'Absent'); walkover(state, b.id, b.teamB, 'Absent');
  assert.deepEqual([third.teamA, third.teamB], [a.teamB, b.teamA]);
  undoWalkover(state, a.id);
  assert.equal(third.status, 'waiting'); assert.equal(third.teamA, null); assert.equal(final.status, 'waiting');
  walkover(state, a.id, a.teamB, 'Absent');
  assert.equal(third.teamA, a.teamA); assert.equal(final.teamA, a.teamB);
  walkover(state, third.id, third.teamA, 'Absent');
  const before = structuredClone(state);
  assert.throws(() => undoWalkover(state, a.id), /already been played/); assert.deepEqual(state, before);
  assert.equal(final.winner, null);
  undoWalkover(state, third.id); assert.equal(third.status, 'ready'); assert.equal(final.status, 'ready');
});

test('19-team draw has 13 byes and 19 actual matches, including exactly one third-place playoff', () => {
  const state = draw(19);
  assert.equal(state.matches.filter(m => m.bye).length, 13);
  assert.equal(state.matches.filter(m => !m.bye).length, 19);
  assert.equal(state.matches.filter(m => m.placement === 3).length, 1);
  assert.equal(finalMatch(state).id, 'M31'); assert.equal(thirdPlaceMatch(state).id, 'M32');
  assert.deepEqual(thirdPlaceMatch(state).sources, ['M29', 'M30']);
});

test('public results and bracket distinguish a playoff winner from the champion, including older draws', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const extract = name => { const from = source.indexOf(`function ${name}(`); return source.slice(from, source.indexOf('\nfunction ', from + 1)); };
  const state = draw(); semifinals(state); const final = finalMatch(state), third = thirdPlaceMatch(state);
  const context = {
    state, finalMatch, thirdPlaceMatch, participantLabel,
    name: id => state.teams.find(t => t.id === id)?.name || '', team: id => state.teams.find(t => t.id === id),
    esc: value => String(value), icon: () => '', badge: label => label,
    completed: () => state.matches.filter(m => m.status === 'completed' && !m.bye),
    publicHeader: () => '', boardsNow: () => '', footer: () => '', resultSearch: '', time: () => '', teamText: id => id.toLowerCase()
  };
  runInNewContext(`${extract('resultRow')}\n${extract('resultCard')}\n${extract('publicResultList')}\n${extract('bracketView')}\n${extract('publicResultsPage')}\nthis.render = publicResultsPage; this.bracket = bracketView; this.results = publicResultList;`, context);
  play(state, third, 'B', 3000000);
  let html = context.render();
  assert.doesNotMatch(html, /<span>CHAMPIONS<\/span>/);
  assert.match(html, new RegExp(`THIRD PLACE</span><h2>${context.name(third.winner)}`));
  assert.match(context.results(), /Third-place playoff<small>1 result/);
  assert.doesNotMatch(context.results(), /<h2>Final/);
  play(state, final, 'A', 4000000);
  html = context.render();
  assert.match(html, new RegExp(`CHAMPIONS</span><h2>${context.name(final.winner)}`));
  assert.match(html, /Third-place playoff<small>1 matches/);
  assert.match(html, /Final<small>1 matches/);
  const list = context.results();
  assert.match(list, /<h2>Final<small>1 result/);
  assert.match(list, /<h2>Third-place playoff<small>1 result/);
  assert.ok(list.indexOf('<h2>Final') < list.indexOf('<h2>Third-place playoff'));
  context.resultSearch = third.teamA.toLowerCase();
  assert.doesNotMatch(context.results(), /<h2>Final/);
  state.matches = state.matches.filter(m => m !== third);
  assert.equal(finalMatch(state), final); assert.equal(thirdPlaceMatch(state), undefined);
  assert.doesNotMatch(context.bracket(), /THIRD PLACE/);
});
