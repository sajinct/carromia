import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyState, seedDemo, start, roundWinner, nextRound, assign, publicState, registrationStatus, defaults } from '../lib/tournament.mjs';
import { overlayMatch, overlayClock, overlayMarkup, overlaySourceUrl, overlaySetupUrl } from '../public/overlay-view.js';

test('rehearsal teams can be generated after the real deadline without removing the saved cutoff', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-01-01T00:00:00Z') });
  const state = seedDemo();
  assert.equal(state.teams.length, 16);
  assert.equal(state.event.registrationDeadline, defaults.registrationDeadline);
  assert.equal(registrationStatus(emptyState()).open, false, 'real registration still respects the deadline');
});

test('overlay follows a board through timed rounds, the final result and the next match', () => {
  const state = seedDemo(), now = 1000000;
  const match = overlayMatch(state, 1);
  assert.equal(match.status, 'called');
  assert.equal(overlayClock(match, now).text, 'READY');
  start(state, match.id, now);
  assert.deepEqual(overlayClock(match, now + 1000), { text: '09:59', label: 'Round 1' });
  roundWinner(state, match.id, match.teamA, now + 300000);
  assert.deepEqual(overlayClock(match, now + 300000), { text: 'BREAK', label: 'Round 2 next' });
  nextRound(state, match.id, now + 310000);
  assert.deepEqual(overlayClock(match, now + 311000), { text: '09:59', label: 'Round 2' });
  roundWinner(state, match.id, match.teamA, now + 500000);
  assert.equal(overlayClock(match, now + 500000).text, 'FINAL');
  assert.match(overlayMarkup(publicState(state), 1), /WINNER ·/);
  assert.match(overlayMarkup(publicState(state), 1), /is-winner/);
  const next = state.matches.find(m => m.status === 'ready' && !m.board);
  assign(state, next.id, 1, now + 900000);
  assert.equal(overlayMatch(state, 1).id, next.id, 'newly called match replaces the previous winner');
});

test('round timeout stays at zero until the umpire decides; lost updates do not show a running clock', () => {
  const state = seedDemo(), match = overlayMatch(state, 1); start(state, match.id, 1000);
  assert.deepEqual(overlayClock(match, 601001), { text: '00:00', label: 'Time up · umpire deciding' });
  assert.equal(overlayClock(match, 10000, false).text, '—');
  const markup = overlayMarkup(state, 1, { connected: false });
  assert.match(markup, /UPDATES INTERRUPTED/); assert.match(markup, /Scores may be outdated/);
});

test('an idle board has no invented teams, scores or match timer', () => {
  const state = emptyState();
  assert.equal(overlayMatch(state, 4), null);
  assert.equal(overlayClock(null).label, 'Awaiting match');
  const markup = overlayMarkup(state, 4);
  assert.match(markup, /BOARD 04/); assert.match(markup, /Awaiting team/);
  assert.doesNotMatch(markup, /10:00|MATCH IN PLAY/);
});

test('completed matches are selected by latest finish and only from the selected board', () => {
  const state = { matches: [
    { id: 'older', board: 2, status: 'completed', completedAt: 1 },
    { id: 'newer', board: 2, status: 'completed', completedAt: 2 },
    { id: 'other-board', board: 1, status: 'playing' }
  ] };
  assert.equal(overlayMatch(state, 2).id, 'newer');
  state.matches.push({ id: 'called', board: 2, status: 'called' });
  assert.equal(overlayMatch(state, 2).id, 'called');
});

test('overlay escapes public content and never renders contact, ID, token or payment fields', () => {
  const state = seedDemo(), match = overlayMatch(state, 1);
  const team = state.teams.find(t => t.id === match.teamA);
  team.name = '<script>unsafe()</script>'; team.parish = 'A "quoted" parish';
  team.players[0].name = '<img onerror="unsafe()">'; team.payment = { txnRef: 'PRIVATE-UTR' };
  const markup = overlayMarkup(state, 1);
  assert.match(markup, /&lt;script&gt;/); assert.match(markup, /&quot;quoted&quot;/);
  assert.doesNotMatch(markup, /<script>|<img onerror|PRIVATE-UTR|9000000000|Aadhaar/);
  state.practice = true; assert.match(overlayMarkup(state, 1), /PRACTICE/);
});

test('overlay links work for local hosting, repository Pages and practice without carrying hash routes or secrets', () => {
  assert.equal(overlaySetupUrl('http://localhost:3000/admin/media', false), 'http://localhost:3000/overlay.html?practice=0');
  const setup = overlaySetupUrl('https://sajinct.github.io/carromia/#/admin/media', true, true);
  assert.equal(setup, 'https://sajinct.github.io/carromia/overlay.html?practice=1');
  assert.equal(overlaySourceUrl(setup, 2, true), 'https://sajinct.github.io/carromia/overlay.html?board=2&practice=1');
  assert.equal(overlaySourceUrl('https://example.org/overlay.html?token=private#route', 4), 'https://example.org/overlay.html?board=4&practice=0');
  for (const board of [0, 5, 'x']) assert.throws(() => overlaySourceUrl(setup, board));
});

test('browser source is isolated, transparent and contains no analytics or external players', () => {
  const html = readFileSync(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/overlay.css', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../public/overlay.js', import.meta.url), 'utf8');
  assert.match(html, /src="\.\/overlay.js"/); assert.match(css, /background:transparent/);
  assert.doesNotMatch(html, /app.js|analytics|iframe/);
  assert.match(runtime, /remoteApi\('public-state'\)/);
  assert.match(runtime, /credentials: 'omit'/);
});
