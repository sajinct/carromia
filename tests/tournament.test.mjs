import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addTeam, createDraw, assign, start, roundWinner, nextRound, undoRound, eligible, updateSettings, boardReady, removeTeam, practiceEvent, publicState, walkover, undoWalkover, correctResult, unassign, actions, practiceMode, registrationStatus, parishKey, playerPhotos, upiQrImage, seedDemo, paymentProof, confirmPayment, checkIn, isConfirmed } from '../lib/tournament.mjs';
import { centres, groups, findCentre } from '../public/parishes.js';
import { centre, player, photo } from './registration-fixture.mjs';
// A team from the i-th parish or centre of the diocese register.
const entry = (name, i = 0) => ({ name, ...centre(i), adults: true, players: [player(`${name} A`, '9000000000', false), player(`${name} B`, '9000000001', false)] });
// An event without registration limits, so the draw and match tests can use any number of teams on any date.
function open() { const s = emptyState(); Object.assign(s.event, { maxTeams: 128, maxTeamsPerParish: 128, registrationDeadline: '' }); return s; }
function setup(n) { const s = open(); for (let i = 1; i <= n; i++) addTeam(s, entry(`Team ${i}`)).checkedIn = true; return s; }
const ROUND = 10 * 60000, A_WINS = ['A', 'A'], B_WINS = ['A', 'B', 'B'];
// Plays a started match to the end, one round per entry ('A' or 'B' won it), all marked at `at`.
function play(s, id, sides, at = 0, official) { const m = s.matches.find(m => m.id === id); sides.forEach((side, i) => { if (i) nextRound(s, id, at); roundWinner(s, id, m[`team${side}`], at, official); }); }
// A correction naming each round's winner.
const rounds = (m, sides) => Object.fromEntries(sides.map((side, i) => [`round${i + 1}`, m[`team${side}`]]));
test('registration requires exactly two valid players, unique team names and the 18+ confirmation', () => {
  const s = setup(1);
  assert.throws(() => addTeam(s, { ...entry('New'), players: [] }), /exactly two/); assert.throws(() => addTeam(s, entry('team 1')), /already registered/);
  assert.throws(() => addTeam(s, { ...entry('New'), adults: false }), /18 or older/); assert.throws(() => addTeam(s, { ...entry('New'), adults: 'yes' }), /18 or older/);
  assert.equal(s.teams.length, 1);
});
test('the diocese register: 53 parishes, 19 mass centres and 13 mission centres in 9 foranes and zones', () => {
  assert.equal(centres.length, 85); assert.equal(groups.length, 9);
  assert.deepEqual(['Parish', 'Mass Centre', 'Mission Centre'].map(type => centres.filter(c => c.type === type).length), [53, 19, 13]);
  assert.equal(centres.filter(c => c.group === 'Dharmaram Forane' && c.type === 'Parish').length, 10);
  // Honnamanakatte is both a mass centre and a mission centre; the type tells them apart.
  assert.equal(findCentre('Hinkal Forane', 'Honnamanakatte, Jyothi Vikas Centre', 'Mission Centre').type, 'Mission Centre');
  assert.equal(findCentre('Mandya Zone', 'Koramangala, Mary Matha Church'), null, 'a parish must be in the chosen forane');
});
test('registration records the parish or centre from the register and each player’s ID proof, not their photos', () => {
  const s = open();
  const t = addTeam(s, { ...entry('Pair'), forane: 'Mathikere Forane', parish: 'Vijayanagar, Mary Matha Church', players: [{ ...player('Anu', '9111111111'), idLast4: 'ab12' }, { ...player('Binu', '9222222222'), idType: 'Voter ID' }] });
  assert.deepEqual([t.forane, t.parish, t.centreType], ['Mathikere Forane', 'Vijayanagar, Mary Matha Church', 'Parish']);
  assert.deepEqual(t.players, [{ name: 'Anu', mobile: '9111111111', idType: 'Aadhaar', idLast4: 'AB12' }, { name: 'Binu', mobile: '9222222222', idType: 'Voter ID', idLast4: '1234' }]);
  assert.throws(() => addTeam(s, { ...entry('No parish'), parish: 'Somewhere Else' }), /Choose your forane or zone/);
  assert.throws(() => addTeam(s, { ...entry('No forane'), forane: '' }), /Choose your forane or zone/);
  assert.throws(() => addTeam(s, { ...entry('Bad ID'), players: [player('A'), { ...player('B'), idType: 'Library card' }] }), /ID proof/);
  assert.throws(() => addTeam(s, { ...entry('Short ID'), players: [player('A'), { ...player('B'), idLast4: '12' }] }), /last 4/);
  assert.throws(() => addTeam(s, { ...entry('Odd ID'), players: [player('A'), { ...player('B'), idLast4: '12-4' }] }), /last 4/);
  assert.equal(publicState(s).teams[0].players[0].idLast4, undefined, 'ID details stay private');
  // Photos (each with a thumbnail) are checked apart from the team, and kept out of the event.
  assert.deepEqual(playerPhotos({ players: [player('A'), player('B')] }), [{ photo, thumb: photo }, { photo, thumb: photo }]);
  assert.throws(() => playerPhotos({ players: [player('A'), { ...player('B'), thumb: '' }] }), /photo of each player/, 'a thumbnail is needed too');
  assert.throws(() => playerPhotos({ players: [player('A'), { ...player('B'), thumb: 'data:image/jpeg;base64,' + 'A'.repeat(200000) }] }), /photo of each player/, 'thumbnails stay small');
  assert.equal(playerPhotos({ players: [{ ...player('A'), photo: 'data:image/jpeg;base64,' + 'A'.repeat(4000000) }, player('B')] })[0].photo.length, 4000023, 'high-quality photos are allowed');
  assert.throws(() => playerPhotos({ players: [player('A'), player('B', '9', false)] }), /photo of each player/);
  assert.throws(() => playerPhotos({ players: [player('A'), { ...player('B'), photo: 'data:image/png;base64,AAAA' }] }), /photo of each player/);
  assert.throws(() => playerPhotos({ players: [player('A'), { ...player('B'), photo: 'data:image/jpeg;base64,' + 'A'.repeat(5600000) }] }), /photo of each player/);
  assert.ok(!JSON.stringify(s).includes('base64'));
  assert.ok(seedDemo().teams.every(t => findCentre(t.forane, t.parish, t.centreType) && t.players.every(p => p.idType && p.idLast4.length === 4)), 'sample teams use the register too');
});
test('event settings: payment at registration needs a UPI QR code; support contacts', () => {
  const s = open(), base = { name: 'Cup', venue: 'Hall', resetMinutes: 5, restMinutes: 0 }, qr = photo.replace('jpeg', 'png');
  assert.throws(() => updateSettings(open(), { ...base, paymentRequired: true }), /Upload the UPI QR code/);
  assert.throws(() => updateSettings(open(), { ...base, upiQr: 'data:image/gif;base64,AAAA' }), /PNG or JPEG/);
  assert.throws(() => updateSettings(open(), { ...base, upiId: 'not an id' }), /valid UPI ID/);
  assert.throws(() => updateSettings(open(), { ...base, contacts: [{ name: 'Fr. Joseph', phone: '12' }] }), /valid phone number/);
  assert.throws(() => updateSettings(open(), { ...base, contacts: [1, 2, 3, 4].map(i => ({ name: 'N' + i, phone: '9876543210' })) }), /up to 3/);
  updateSettings(s, { ...base, paymentRequired: true, upiQr: qr, upiId: 'carromia@okaxis', contacts: [{ name: ' Fr. Joseph ', phone: '9876543210' }, { name: '', phone: '' }] });
  assert.deepEqual([s.event.paymentRequired, s.event.upiQr, s.event.upiId, s.event.contacts], [true, qr, 'carromia@okaxis', [{ name: 'Fr. Joseph', phone: '9876543210' }]]);
  assert.throws(() => updateSettings(s, { ...base, upiQr: '' }), /Upload the UPI QR code/, 'the QR can’t be removed while payment is on');
  updateSettings(s, { ...base, paymentRequired: false, upiQr: '' }); assert.equal(s.event.paymentRequired, false);
  // The QR code is normally an uploaded file: its Storage address, or the Node server's.
  const file = 'main/upi-qr-0b6f7c1e-2a4d-4e8f-9c3b-5d6e7f8a9b0c.png';
  for (const url of [`https://vzxcqpgwvknonkhjinuk.supabase.co/storage/v1/object/public/event-assets/${file}`, `/api/assets/${file}`]) { updateSettings(s, { ...base, upiQr: url }); assert.equal(s.event.upiQr, url); }
  for (const url of ['https://example.org/qr.png', `https://x.supabase.co/storage/v1/object/public/team-files/${file}`, `/api/assets/../${file}`]) assert.throws(() => updateSettings(s, { ...base, upiQr: url }), /PNG or JPEG/);
  assert.equal(upiQrImage({ image: qr }), qr); assert.throws(() => upiQrImage({ image: photo }), /PNG or JPEG/);
});
test('payment at registration: pending until the desk confirms; pending teams can’t check in or play', () => {
  const s = open(); s.event.paymentRequired = true;
  assert.throws(() => addTeam(s, entry('No proof')), /transaction number or add a payment screenshot/);
  assert.throws(() => addTeam(s, { ...entry('Bad ref'), payment: { txnRef: '12-34' } }), /6 to 30 letters or digits/);
  assert.throws(() => paymentProof({ payment: { screenshot: 'data:image/png;base64,AAAA' } }), /payment screenshot/);
  const a = addTeam(s, { ...entry('By ref'), payment: { txnRef: ' 4123 5678 9012 ' } }), b = addTeam(s, { ...entry('By screenshot', 1), payment: { screenshot: photo } });
  assert.deepEqual([a.status, a.payment], ['pending', { amount: 500, txnRef: '412356789012', screenshot: false }]);
  assert.deepEqual([b.status, b.payment.screenshot, JSON.stringify(s).includes('base64')], ['pending', true, false]);
  assert.equal(registrationStatus(s).slotsLeft, 126, 'pending teams hold their slots');
  assert.throws(() => checkIn(s, { id: a.id }), /hasn’t been confirmed/);
  assert.throws(() => createDraw(s, false), /Confirm at least two teams/);
  confirmPayment(s, a.id, 1000, 'Omar Official');
  assert.deepEqual([a.status, a.confirmedAt, a.confirmedBy], ['confirmed', 1000, 'Omar Official']); assert.match(s.activity[0].message, /By ref payment confirmed by Omar Official/);
  assert.throws(() => confirmPayment(s, a.id), /already confirmed/);
  checkIn(s, { id: a.id }); assert.equal(a.checkedIn, true);
  // The draw leaves the pending team out.
  s.event.paymentRequired = false; const c = addTeam(s, entry('Free', 2)); assert.equal(c.status, 'confirmed');
  createDraw(s, false); const drawn = s.matches.flatMap(m => [m.teamA, m.teamB]);
  assert.ok(drawn.includes(a.id) && drawn.includes(c.id) && !drawn.includes(b.id)); assert.ok(s.activity.some(x => /1 team awaiting payment left out/.test(x.message)));
  assert.equal(isConfirmed({ id: 'CAR-009' }), true, 'teams saved before payments existed count as confirmed');
});
test('registration limits: team slots, teams per parish, deadline and lunch booking', () => {
  const s = emptyState(), before = Date.parse('2026-11-10T18:29:00Z'), after = Date.parse('2026-11-10T18:30:00Z');
  assert.deepEqual([s.event.maxTeams, s.event.maxTeamsPerParish, s.event.registrationDeadline, s.event.entryFee], [64, 4, '2026-11-10', 500]);
  // Spellings of one register entry count as the same parish, and are saved as the register has it.
  for (const parish of ['Dharmaram, St. Thomas Forane Church', 'dharmaram st thomas forane church', 'DHARMARAM, ST. THOMAS FORANE CHURCH.', ' Dharmaram St Thomas Forane Church ']) assert.equal(addTeam(s, { ...entry(`Thomas ${parish}`), forane: 'Dharmaram Forane', parish }, before).parish, 'Dharmaram, St. Thomas Forane Church');
  assert.equal(parishKey('St. Thomas Church'), 'st thomas');
  assert.throws(() => addTeam(s, { ...entry('Fifth'), forane: 'Dharmaram Forane', parish: 'Dharmaram, St. Thomas Forane Church' }, before), /Dharmaram, St\. Thomas Forane Church already has 4 teams registered/);
  assert.equal(addTeam(s, { ...entry('Other', 2), lunch: '2' }, before).lunch, 2);
  assert.deepEqual([addTeam(s, { ...entry('L1', 3), lunch: 9 }, before).lunch, addTeam(s, { ...entry('L2', 4), lunch: -1 }, before).lunch, addTeam(s, entry('L3', 5), before).lunch], [2, 0, 0]);
  // The deadline is the end of 10 November in India (18:30 UTC); practice events ignore it.
  assert.deepEqual(registrationStatus(s, before), { open: true, reason: '', slotsLeft: 56, maxTeams: 64 });
  assert.equal(registrationStatus(s, after).reason, 'Registration closed on 10 November 2026.'); assert.throws(() => addTeam(s, entry('Late', 6), after), /closed on 10 November 2026/);
  assert.equal(registrationStatus({ ...s, practice: true }, after).open, true);
  s.event.registrationDeadline = ''; assert.equal(registrationStatus(s, after).open, true);
  s.event.maxTeams = 8; assert.equal(registrationStatus(s, before).reason, 'All 8 team slots are taken. Registration is full.'); assert.throws(() => addTeam(s, entry('Ninth', 7), before), /Registration is full/);
  // Events saved before these settings existed use the defaults.
  const old = emptyState(); for (const key of ['maxTeams', 'maxTeamsPerParish', 'registrationDeadline', 'entryFee']) delete old.event[key];
  assert.equal(registrationStatus(old, before).slotsLeft, 64); assert.equal(registrationStatus(old, after).open, false);
});
test('draw handles every team count from 2 to 128 with one champion and n-1 actual matches', () => {
  for (let n = 2; n <= 128; n++) {
    const s = setup(n); createDraw(s, false); s.event.resetMinutes = 0; let clock = 1000000;
    while (s.matches.some(m => m.status !== 'completed')) { const m = s.matches.find(m => m.status === 'ready'); assert.ok(m, `No ready match for ${n} teams`); assign(s, m.id, 1, clock); start(s, m.id, clock); clock += 600000; play(s, m.id, B_WINS, clock); }
    assert.ok(s.matches.at(-1).winner); assert.equal(s.matches.filter(m => !m.bye).length, n - 1);
  }
});
test('registration closes and a second draw is rejected', () => { const s = setup(4); createDraw(s); assert.equal(s.event.registrationOpen, false); assert.throws(() => createDraw(s), /already exists/); assert.throws(() => addTeam(s, {}), /closed/); });
test('check-in and board occupancy are enforced', () => { const s = setup(4); createDraw(s, false); s.teams[0].checkedIn = false; assert.throws(() => assign(s, 'M01', 1), /check-in/); s.teams[0].checkedIn = true; assign(s, 'M01', 1); assert.throws(() => assign(s, 'M02', 1), /occupied/); assert.throws(() => assign(s, 'M01', 2), /Not ready/); });
test('a match is best of three 10-minute rounds; each round’s winner is marked, even before its time is up', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); const m = s.matches[0];
  assert.deepEqual([m.gamesPerMatch, m.gameMinutes, m.rounds, m.gamesA, m.gamesB], [3, 10, [{ startedAt: 0, endsAt: ROUND }], 0, 0]); assert.equal(m.endsAt, undefined);
  assert.throws(() => roundWinner(s, 'M01', 'CAR-999', 1000), /team that won the round/);
  assert.throws(() => roundWinner(s, 'M02', s.matches[1].teamA, 1000), /not in play/);
  roundWinner(s, 'M01', m.teamA, 240000, 'Omar Official');
  assert.deepEqual(m.rounds[0], { startedAt: 0, endsAt: ROUND, winner: m.teamA, endedAt: 240000, official: 'Omar Official' });
  assert.deepEqual([m.status, m.gamesA, m.gamesB], ['playing', 1, 0]); assert.match(s.activity[0].message, /M01 round 1: Team 1/);
  // The next round waits for an official to start it, on its own clock.
  assert.throws(() => roundWinner(s, 'M01', m.teamB, 250000), /Start round 2 first/);
  nextRound(s, 'M01', 300000); assert.deepEqual(m.rounds[1], { startedAt: 300000, endsAt: 300000 + ROUND });
  assert.throws(() => nextRound(s, 'M01', 310000), /Round 2 is still being played/);
  // Marked after the round's time ran out: the umpire decided it.
  roundWinner(s, 'M01', m.teamB, 300000 + ROUND + 30000); assert.deepEqual([m.status, m.gamesA, m.gamesB], ['playing', 1, 1]);
  nextRound(s, 'M01', 1000000); roundWinner(s, 'M01', m.teamB, 1200000, 'Omar Official');
  assert.deepEqual([m.status, m.winner, m.gamesA, m.gamesB, m.completedAt, m.official], ['completed', m.teamB, 1, 2, 1200000, 'Omar Official']);
  assert.equal(s.boards[0].availableAt, 1200000 + 5 * 60000, 'board reset starts when the match finishes'); assert.match(s.activity[0].message, /M01: Team 4 won \(2–1 in rounds\)/);
  assert.throws(() => roundWinner(s, 'M01', m.teamB, 1300000), /not in play/);
});
test('a team that wins the first two rounds wins; a match keeps the format it started with', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); const m = s.matches[0];
  updateSettings(s, { name: 'Cup', venue: 'Hall', resetMinutes: 5, restMinutes: 0, gamesPerMatch: 5, gameMinutes: 7 });
  play(s, 'M01', A_WINS, 500000); assert.deepEqual([m.status, m.winner, m.gamesA, m.gamesB, m.rounds.length], ['completed', m.teamA, 2, 0, 2]);
  assign(s, 'M02', 2, 0); start(s, 'M02', 0); const m2 = s.matches[1];
  assert.deepEqual([m2.gamesPerMatch, m2.rounds[0].endsAt], [5, 7 * 60000]); play(s, 'M02', ['A', 'A'], 1000); assert.equal(m2.status, 'playing', 'best of five needs three rounds');
  nextRound(s, 'M02', 2000); roundWinner(s, 'M02', m2.teamA, 3000); assert.equal(m2.status, 'completed');
});
test('the last round’s winner can be taken back while the match is in play', () => {
  const s = setup(2); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); const m = s.matches[0];
  assert.throws(() => undoRound(s, 'M01', 1000), /No round has been decided/);
  roundWinner(s, 'M01', m.teamA, 60000); undoRound(s, 'M01', 70000);
  assert.deepEqual([m.rounds, m.gamesA], [[{ startedAt: 0, endsAt: ROUND }], 0], 'round 1 plays on with its own timer'); assert.match(s.activity[0].message, /round 1 winner \(Team 1\) taken back/);
  roundWinner(s, 'M01', m.teamB, 80000); nextRound(s, 'M01', 90000); undoRound(s, 'M01', 100000);
  assert.deepEqual([m.rounds.length, m.rounds[0].winner, m.gamesB], [1, undefined, 0], 'a round started since is cancelled');
});
test('a match started before rounds existed carries on from round 1', () => {
  const s = setup(2); createDraw(s, false); assign(s, 'M01', 1, 0); const m = s.matches[0];
  Object.assign(m, { status: 'playing', startedAt: 0, endsAt: 30 * 60000 });
  assert.throws(() => roundWinner(s, 'M01', m.teamA, 1000), /Start round 1 first/);
  nextRound(s, 'M01', 2000); assert.deepEqual([m.gamesPerMatch, m.rounds[0].endsAt], [3, 2000 + ROUND]);
});
test('winner advances only after both predecessor matches are complete', () => { const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0); play(s, 'M01', A_WINS, 600000); assert.equal(s.matches[2].status, 'waiting'); assign(s, 'M02', 2, 0); start(s, 'M02', 0); play(s, 'M02', B_WINS, 600000); assert.equal(s.matches[2].status, 'ready'); assert.equal(s.matches[2].teamA, s.matches[0].winner); assert.equal(s.matches[2].teamB, s.matches[1].winner); });
test('reset and rest periods block premature scheduling', () => { const s = setup(4); s.event.restMinutes = 10; createDraw(s, false); for (let i = 0; i < 2; i++) { assign(s, s.matches[i].id, i + 1, 1000000); start(s, s.matches[i].id, 1000000); play(s, s.matches[i].id, A_WINS, 1600000); } assert.equal(eligible(s, s.matches[2], 1600000), 'Rest period'); assert.equal(eligible(s, s.matches[2], 2200000), ''); s.event.restMinutes = 0; assert.throws(() => assign(s, 'M03', 1, 1600000), /reset/); assign(s, 'M03', 1, 1900000); assert.equal(s.matches[2].status, 'called'); });
test('event defaults follow the poster; settings are validated', () => {
  const s = emptyState(); assert.equal(s.event.date, '2026-11-15'); assert.equal(s.event.startTime, '09:00'); assert.deepEqual([s.event.gamesPerMatch, s.event.gameMinutes], [3, 10]);
  const base = { resetMinutes: 5, restMinutes: 0 };
  for (const startTime of ['9am', '24:00', '09:60']) assert.throws(() => updateSettings(emptyState(), { ...base, startTime }), /start time/);
  updateSettings(s, { ...base, startTime: '14:30', registrationOpen: true }); assert.equal(s.event.startTime, '14:30'); assert.equal(s.event.registrationOpen, true); assert.equal(s.event.maxTeams, 64, 'limits are kept when not sent');
  updateSettings(s, { ...base, startTime: '' }); assert.equal(s.event.startTime, '');
  for (const bad of [{ maxTeams: 1 }, { maxTeams: 129 }, { maxTeams: '' }, { maxTeamsPerParish: 0 }, { entryFee: -1 }, { entryFee: 2.5 }, { gameMinutes: 0 }, { gameMinutes: 31 }]) assert.throws(() => updateSettings(emptyState(), { ...base, ...bad }), /Invalid value/);
  for (const gamesPerMatch of [0, 2, 4, 7, 'x']) assert.throws(() => updateSettings(emptyState(), { ...base, gamesPerMatch }), /1, 3 or 5/);
  updateSettings(s, { ...base, gamesPerMatch: '5', gameMinutes: '8' }); assert.deepEqual([s.event.gamesPerMatch, s.event.gameMinutes], [5, 8]);
  for (const registrationDeadline of ['10/11/2026', '2026-13-45', 'soon']) assert.throws(() => updateSettings(emptyState(), { ...base, registrationDeadline }), /registration deadline/);
  updateSettings(s, { ...base, maxTeams: '32', maxTeamsPerParish: '2', entryFee: '750', registrationDeadline: '2026-11-12' });
  assert.deepEqual([s.event.maxTeams, s.event.maxTeamsPerParish, s.event.entryFee, s.event.registrationDeadline], [32, 2, 750, '2026-11-12']);
  updateSettings(s, { ...base, registrationDeadline: '' }); assert.equal(s.event.registrationDeadline, '', 'an empty deadline means none');
});
test('officials can end a board reset early; only a resetting, empty board can be marked ready', () => {
  const s = setup(4); createDraw(s, false); assign(s, 'M01', 1, 0); start(s, 'M01', 0);
  assert.throws(() => boardReady(s, 1, 60000), /match in progress/);
  play(s, 'M01', A_WINS, 600000); assert.equal(s.boards[0].availableAt, 900000);
  assert.throws(() => assign(s, 'M02', 1, 620000), /being reset/);
  boardReady(s, 1, 620000); assert.equal(s.boards[0].availableAt, 620000); assert.match(s.activity[0].message, /Board 1 reset early/);
  assign(s, 'M02', 1, 620000); assert.equal(s.matches[1].board, 1);
  assert.throws(() => boardReady(s, 2, 620000), /already available/); assert.throws(() => boardReady(s, 9, 620000), /not found/);
  assert.equal(s.matches[0].board, 1, 'the finished match keeps its board so the winner can be shown there');
});
test('admins can remove teams before the draw; removed IDs are never reused', () => {
  const s = setup(3); removeTeam(s, 'CAR-002');
  assert.deepEqual(s.teams.map(t => t.id), ['CAR-001', 'CAR-003']); assert.match(s.activity[0].message, /Team 2 \(CAR-002\) removed/);
  const t = addTeam(s, entry('Late Entry', 8)); assert.equal(t.id, 'CAR-004');
  removeTeam(s, 'CAR-004'); assert.equal(addTeam(s, entry('Another', 8)).id, 'CAR-005', 'even the newest ID is not reused');
  assert.throws(() => removeTeam(s, 'CAR-999'), /not found/);
  createDraw(s); assert.throws(() => removeTeam(s, 'CAR-001'), /after the draw/);
});
test('the practice event is the sample tournament with the real event details and is marked practice', () => {
  const p = practiceEvent({ ...emptyState().event, venue: 'Hall B', registrationOpen: true });
  assert.equal(p.practice, true); assert.equal(p.demo, true); assert.equal(p.teams.length, 16); assert.equal(p.event.venue, 'Hall B'); assert.equal(p.event.registrationOpen, false);
  assert.equal(publicState(p).teams[0].players[0].mobile, undefined);
});
test('admins turn practice mode off and on from the real event, not from practice', () => {
  const s = open(); practiceMode(s, false, 1000); assert.equal(s.event.practiceOff, true); assert.match(s.activity[0].message, /Practice mode turned off for all devices/);
  assert.equal(publicState(s).event.practiceOff, true, 'every device can see it');
  practiceMode(s, true); assert.equal(s.event.practiceOff, false);
  assert.throws(() => practiceMode(practiceEvent(s.event), false), /Leave practice mode/);
});
test('walkover awards an unplayed match without check-in, starts no rest period, and can be undone', () => {
  const s = setup(4); createDraw(s, false); s.event.restMinutes = 10;
  const [m1, m2, final] = s.matches;
  assign(s, m2.id, 1, 1000); start(s, m2.id, 1000); play(s, m2.id, A_WINS, 601000);
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
test('a recorded score can be corrected round by round until the next round is called; the bracket is re-derived', () => {
  const s = setup(4); createDraw(s, false); s.event.resetMinutes = 0;
  const [m1, m2, final] = s.matches;
  assign(s, m1.id, 1, 0); start(s, m1.id, 0); play(s, m1.id, B_WINS, 600000, 'Omar Official');
  assert.equal(m1.winner, m1.teamB); assert.equal(m1.official, 'Omar Official');
  assign(s, m2.id, 2, 0); start(s, m2.id, 0); play(s, m2.id, A_WINS, 600000);
  assert.equal(final.status, 'ready'); assert.equal(final.teamA, m1.teamB);
  for (const bad of [{ round1: 'CAR-999', round2: m1.teamA }, { round1: m1.teamA, round3: m1.teamA }]) assert.throws(() => correctResult(s, m1.id, bad), /each round played, in order/);
  for (const bad of [[], ['A'], ['A', 'B'], ['A', 'A', 'B']]) assert.throws(() => correctResult(s, m1.id, rounds(m1, bad)), /wins 2 rounds/);
  assert.equal(m1.winner, m1.teamB, 'a refused correction changes nothing'); assert.equal(final.status, 'ready');
  correctResult(s, m1.id, rounds(m1, ['A', 'B', 'A']), 700000, 'Asha Admin');
  assert.equal(m1.winner, m1.teamA); assert.deepEqual([m1.gamesA, m1.gamesB, m1.rounds.map(r => r.winner)], [2, 1, [m1.teamA, m1.teamB, m1.teamA]]);
  assert.equal(m1.rounds[0].endedAt, 600000, 'round times are kept'); assert.equal(m1.corrected, true); assert.equal(m1.official, 'Asha Admin'); assert.equal(m1.completedAt, 600000, 'the original time is kept');
  assert.equal(final.status, 'ready'); assert.deepEqual([final.teamA, final.teamB], [m1.teamA, m2.winner]); assert.match(s.activity[0].message, /M01 corrected: Team 1 won \(2–1 in rounds\)/);
  correctResult(s, m1.id, rounds(m1, ['B', 'B'])); assert.deepEqual([m1.winner, m1.rounds.length], [m1.teamB, 2]);
  assign(s, final.id, 1, 700000);
  assert.throws(() => correctResult(s, m1.id, rounds(m1, A_WINS)), /already on a board/);
  unassign(s, final.id); correctResult(s, m1.id, rounds(m1, A_WINS)); assert.equal(final.teamA, m1.teamA);
  assign(s, final.id, 1, 700000); start(s, final.id, 700000); play(s, final.id, A_WINS, 1300000);
  assert.throws(() => correctResult(s, m1.id, rounds(m1, B_WINS)), /already been played/);
  assert.throws(() => correctResult(s, 'M99', {}), /Only a played/);
});
test('the action registry names every desk action and flags the admin-only ones', () => {
  assert.deepEqual(Object.keys(actions).sort(), ['assign', 'board-ready', 'checkin', 'confirm-payment', 'correct-result', 'demo', 'draw', 'next-round', 'practice-mode', 'remove-team', 'reset', 'round-winner', 'settings', 'start', 'unassign', 'undo-round', 'undo-walkover', 'walkover']);
  assert.deepEqual(Object.entries(actions).filter(([, a]) => a.admin).map(([k]) => k).sort(), ['correct-result', 'demo', 'draw', 'practice-mode', 'remove-team', 'reset', 'settings', 'undo-walkover', 'walkover']);
  const s = setup(2); actions.draw.run(s, {}, {}); actions.assign.run(s, { id: 'M01', board: 1 }, { now: 0 }); actions.start.run(s, { id: 'M01' }, { now: 0 });
  const m = s.matches[0]; actions['round-winner'].run(s, { id: 'M01', winner: m.teamA }, { now: 60000, official: 'Asha Admin' }); actions['undo-round'].run(s, { id: 'M01' }, { now: 70000 });
  actions['round-winner'].run(s, { id: 'M01', winner: m.teamA }, { now: 80000 }); actions['next-round'].run(s, { id: 'M01' }, { now: 90000 }); assert.equal(m.rounds[1].startedAt, 90000);
  actions['round-winner'].run(s, { id: 'M01', winner: m.teamA }, { now: 600000, official: 'Asha Admin' }); assert.equal(m.official, 'Asha Admin');
  assert.equal(actions.settings.run(s, { name: 'Cup', venue: 'Hall', gameMinutes: 8, resetMinutes: 2, restMinutes: 0 }, {}), undefined); assert.equal(s.event.name, 'Cup'); assert.match(s.activity[0].message, /settings updated/);
  const fresh = actions.reset.run(s, { confirm: 'RESET' }, {}); assert.equal(fresh.teams.length, 0); assert.equal(fresh.event.name, 'Cup');
});
