import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, seedDemo, updateMedia, publicState, refusal, actions, freshEvent, checkBoard, teamsFor, submitGallery } from '../lib/tournament.mjs';
import { socialLink, boardStream, boardDisplay, visibleLiveBoards, publicBoardLayout, publicEventStream } from '../public/social.js';
import { streamCard, streamOnlyBoard, eventStreamCard, liveBoardControls, galleryContent, mediaAdmin, renderMediaPage, gallerySubmissionForm } from '../public/media-view.js';
import { ruleSections, importantPhrases } from '../public/info.js';

const video = 'https://youtu.be/M7lc1UVf-VE';

test('main event stream has independent visibility, preserves its draft link when hidden and supports removal', () => {
  const state = seedDemo();
  assert.equal(eventStreamCard(state), '');
  updateMedia(state, { operation: 'settings', streamsEnabled: false, boardLayout: state.boards.map(b => ({ boardId: b.id, visible: false, showInfo: false })) });
  updateMedia(state, { operation: 'event-stream', title: 'Prize distribution', url: video, enabled: true });
  assert.deepEqual(visibleLiveBoards(state), []);
  let pub = publicState(state);
  assert.equal(pub.media.streamsEnabled, false); assert.equal(pub.media.eventStream.enabled, true);
  assert.match(eventStreamCard(pub), /Prize distribution/); assert.match(eventStreamCard(pub), /iframe/);
  assert.match(eventStreamCard(pub), /autoplay=1/); assert.match(eventStreamCard(pub), /mute=1/);
  const saved = state.media.eventStream.url;
  updateMedia(state, { operation: 'event-stream', enabled: false });
  assert.equal(state.media.eventStream.url, saved); assert.equal(eventStreamCard(publicState(state)), '');
  assert.deepEqual(publicState(state).media.eventStream, { enabled: false, title: '', url: '' });
  updateMedia(state, { operation: 'event-stream', enabled: true }); assert.match(eventStreamCard(state), /iframe/);
  updateMedia(state, { operation: 'event-stream', remove: true }); assert.equal(state.media.eventStream, undefined); assert.equal(eventStreamCard(state), '');
});

test('main event stream validates input, escapes titles and is managed only through the admin controls', () => {
  const state = seedDemo();
  for (const input of [{ enabled: true }, { enabled: true, url: 'javascript:alert(1)' }, { enabled: false, url: 'https://evil.example/live' }, { enabled: true, url: video, title: 'X'.repeat(121) }]) {
    const before = structuredClone(state); assert.throws(() => updateMedia(state, { operation: 'event-stream', ...input })); assert.deepEqual(state, before);
  }
  updateMedia(state, { operation: 'event-stream', enabled: true, url: video, title: '<script>unsafe()</script>' });
  assert.match(eventStreamCard(state), /&lt;script&gt;/); assert.doesNotMatch(eventStreamCard(state), /<script>/);
  state.user = { role: 'admin' }; assert.match(mediaAdmin(state), /id="event-stream-form"/); assert.match(mediaAdmin(state), /Show main event stream on Live boards/);
  state.user = { role: 'media', boards: [1] }; assert.doesNotMatch(mediaAdmin(state), /id="event-stream-form"|event-stream-remove/);
  assert.throws(() => checkBoard(state, { operation: 'event-stream' }, state.user), /Only an event admin/);
  assert.deepEqual(publicEventStream({ eventStream: { enabled: false, title: 'Hidden title', url: 'Hidden draft' } }), { enabled: false, title: '', url: '' });
});

test('rules no longer require thumb-only strokes', () => {
  assert.doesNotMatch(JSON.stringify(ruleSections), /thumbing-only|all strokes.*thumb/i);
  assert.ok(!importantPhrases.includes('thumbing-only'));
});

test('live layout defaults to every scorecard and permits a single stream-only board for the final', () => {
  const state = seedDemo(), before = structuredClone({ teams: state.teams, boards: state.boards, matches: state.matches });
  assert.deepEqual(visibleLiveBoards(state).map(b => b.id), [1, 2, 3, 4]);
  assert.deepEqual(boardDisplay(undefined, 1), { visible: true, showInfo: true });
  updateMedia(state, { operation: 'stream', boardId: 3, url: video, enabled: true });
  const layout = state.boards.map(b => ({ boardId: b.id, visible: b.id === 3, showInfo: false }));
  updateMedia(state, { operation: 'settings', streamsEnabled: true, boardLayout: layout });
  assert.deepEqual(visibleLiveBoards(publicState(state)).map(b => b.id), [3]);
  const html = streamOnlyBoard(state, 3, 'M03');
  assert.match(html, /id="board-3"/); assert.match(html, /iframe/); assert.match(html, /stream-only/);
  assert.doesNotMatch(html, /timer-area|board-team|round-strip|Baseline Brothers/);
  assert.deepEqual({ teams: state.teams, boards: state.boards, matches: state.matches }, before, 'display changes never affect desk scoring or fixtures');
  assert.deepEqual(publicState(state).media.boardLayout, layout);
  updateMedia(state, { operation: 'settings', streamsEnabled: true });
  assert.deepEqual(state.media.boardLayout, layout, 'older settings requests preserve layout');
});

test('hidden or unavailable stream-only boards are omitted; restoring info works without a stream', () => {
  const state = seedDemo();
  const layout = state.boards.map(b => ({ boardId: b.id, visible: b.id === 1, showInfo: false }));
  updateMedia(state, { operation: 'settings', streamsEnabled: true, boardLayout: layout });
  assert.deepEqual(visibleLiveBoards(state), [], 'no empty card when the info is off and no stream exists');
  updateMedia(state, { operation: 'stream', boardId: 1, url: video, enabled: true });
  assert.deepEqual(visibleLiveBoards(state).map(b => b.id), [1]);
  updateMedia(state, { operation: 'stream', matchId: 'M01', url: video, enabled: false });
  assert.deepEqual(visibleLiveBoards(state), [], 'disabled match override takes priority');
  layout[0].showInfo = true;
  updateMedia(state, { operation: 'settings', streamsEnabled: false, boardLayout: layout });
  assert.deepEqual(visibleLiveBoards(state).map(b => b.id), [1]);
  layout[0].visible = false; updateMedia(state, { operation: 'settings', boardLayout: layout });
  assert.deepEqual(visibleLiveBoards(state), [], 'turning off all boards is supported');
});

test('layout controls are per board, read-only for media managers, validated and public-safe', () => {
  const state = seedDemo();
  const controls = liveBoardControls(state);
  for (const b of state.boards) { assert.match(controls, new RegExp(`name="boardVisible${b.id}"`)); assert.match(controls, new RegExp(`name="boardInfo${b.id}"`)); }
  assert.match(liveBoardControls(state, true), /disabled/);
  for (const boardLayout of [{}, [{ boardId: 99, visible: true, showInfo: true }], [{ boardId: 1, visible: 'off', showInfo: true }], [{ boardId: 1, visible: true, showInfo: true }, { boardId: 1, visible: true, showInfo: true }]]) {
    const before = structuredClone(state); assert.throws(() => updateMedia(state, { operation: 'settings', boardLayout })); assert.deepEqual(state, before);
  }
  assert.deepEqual(publicBoardLayout({ boardLayout: [{ boardId: 2, visible: false, showInfo: false, secret: 'private' }, { boardId: 99, secret: 'private' }] }), [{ boardId: 2, visible: false, showInfo: false }]);
});
test('social embeds use supported HTTPS hosts and normalize specific posts', () => {
  for (const url of [video, 'https://www.youtube.com/live/M7lc1UVf-VE?feature=share', 'https://www.youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com/shorts/M7lc1UVf-VE']) assert.equal(socialLink(url).url, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  assert.match(socialLink(video).embed, /^https:\/\/www.youtube-nocookie.com\/embed\//);
  assert.match(socialLink('https://facebook.com/events/videos/123', true).embed, /plugins\/video.php/);
  assert.match(socialLink('https://facebook.com/user/posts/123').embed, /plugins\/post.php/);
  assert.equal(socialLink('https://instagram.com/p/ABC123/?igsh=track').embed, 'https://www.instagram.com/p/ABC123/embed/');
  assert.equal(socialLink('https://instagram.com/host/live/123', true).embed, null);
  for (const url of ['javascript:alert(1)', 'http://youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE', 'https://evil.test', 'https://user:pass@youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com:8080/watch?v=M7lc1UVf-VE', 'https://youtube.com/@channel', 'https://instagram.com/profile/']) assert.throws(() => socialLink(url));
});

test('board streams default off, match links override boards, and disabled matches stay hidden', () => {
  const state = seedDemo();
  assert.equal(streamCard(state, 1, 'M01'), '');
  updateMedia(state, { operation: 'stream', boardId: 1, url: video, enabled: true });
  assert.equal(boardStream(state, 1, 'M01'), null);
  updateMedia(state, { operation: 'settings', streamsEnabled: true, galleryEnabled: false });
  assert.equal(boardStream(state, 1, 'M01').boardId, 1);
  assert.equal(boardStream(state, 2, 'M02'), null);
  updateMedia(state, { operation: 'stream', matchId: 'M01', url: 'https://instagram.com/host/live/123', enabled: true });
  assert.match(streamCard(state, 1, 'M01'), /Open stream on Instagram/);
  assert.doesNotMatch(streamCard(state, 1, 'M01'), /iframe/);
  updateMedia(state, { operation: 'stream', matchId: 'M01', url: video, enabled: false });
  assert.equal(boardStream(publicState(state), 1, 'M01'), null);
  updateMedia(state, { operation: 'stream', matchId: 'M01', remove: true });
  assert.equal(boardStream(state, 1, 'M01').boardId, 1);
  assert.match(streamCard(state, 1, 'M01'), /iframe/);
  assert.throws(() => updateMedia(state, { operation: 'stream', boardId: 99, url: video }), /existing board/);
  assert.throws(() => updateMedia(state, { operation: 'stream', matchId: 'missing', url: video }), /existing board/);
  assert.equal(freshEvent(state, 'RESET').media, undefined);
});

test('live display autoplays muted YouTube and Facebook streams while gallery videos stay manual', () => {
  const state = seedDemo();
  updateMedia(state, { operation: 'settings', streamsEnabled: true, galleryEnabled: true });
  const playerUrl = html => new URL(/src="([^"]+)"/.exec(html)[1].replaceAll('&amp;', '&'));
  for (const [url, flag] of [[video, '1'], ['https://facebook.com/event/videos/123', 'true']]) {
    updateMedia(state, { operation: 'stream', boardId: 1, url, enabled: true });
    const html = streamCard(state, 1, 'M01'), player = playerUrl(html);
    assert.equal(player.searchParams.get('autoplay'), flag); assert.equal(player.searchParams.get('mute'), flag);
    assert.match(html, /loading="eager"/); assert.match(html, /allow="autoplay;/);
    updateMedia(state, { operation: 'add', url, title: 'Highlights', kind: 'video' });
    updateMedia(state, { operation: 'review', id: state.media.gallery[0].id, status: 'approved' });
  }
  const gallery = galleryContent(publicState(state));
  assert.match(gallery, /loading="lazy"/); assert.doesNotMatch(gallery, /autoplay=(?:1|true)|mute=(?:1|true)/);
  updateMedia(state, { operation: 'stream', matchId: 'M01', url: video, enabled: true });
  assert.equal(playerUrl(streamCard(state, 1, 'M01')).searchParams.get('autoplay'), '1');
  updateMedia(state, { operation: 'settings', streamsEnabled: false, galleryEnabled: true });
  assert.equal(streamCard(state, 1, 'M01'), '');
});

test('gallery publishes only approved links and excludes private review data', () => {
  const state = emptyState();
  updateMedia(state, { operation: 'settings', streamsEnabled: true, galleryEnabled: true });
  updateMedia(state, { operation: 'add', url: video, title: '<script>hello</script>', kind: 'video' }, 100);
  const id = state.media.gallery[0].id;
  assert.deepEqual(publicState(state).media.gallery, []);
  assert.throws(() => updateMedia(state, { operation: 'add', url: 'https://youtube.com/watch?v=M7lc1UVf-VE', title: 'Duplicate', kind: 'video' }), /already/);
  updateMedia(state, { operation: 'review', id, status: 'approved' });
  const pub = publicState(state);
  assert.equal(pub.media.gallery.length, 1); assert.equal(pub.media.gallery[0].addedAt, undefined);
  assert.match(galleryContent(pub), /&lt;script&gt;/); assert.doesNotMatch(galleryContent(pub), /<script>/);
  assert.match(mediaAdmin(state), /Streams &amp; gallery/);
  updateMedia(state, { operation: 'review', id, status: 'rejected' });
  assert.deepEqual(publicState(state).media.gallery, []);
  updateMedia(state, { operation: 'review', id, status: 'approved' });
  updateMedia(state, { operation: 'settings', galleryEnabled: false, streamsEnabled: false });
  assert.deepEqual(publicState(state).media.gallery, []);
  assert.deepEqual(publicState(state).media.streams, []);
  updateMedia(state, { operation: 'remove', id }); assert.equal(state.media.gallery.length, 0);
});

test('admins and assigned media staff manage media; officials may rehearse in practice', () => {
  for (const role of ['official', 'checkin', 'lunch', 'umpire']) assert.match(refusal(actions.media, { role }), /Only an event admin/);
  assert.equal(refusal(actions.media, { role: 'admin' }), '');
  assert.equal(refusal(actions.media, { role: 'media' }), '');
  assert.equal(refusal(actions.media, { role: 'official' }, true), '');
});

test('media refresh retains the same iframe node and avoids writing its unchanged src', t => {
  class Element {
    constructor(name, children = [], attrs = {}) { this.nodeType = 1; this.nodeName = this.tagName = name; this.childNodes = children; this.attrs = { ...attrs }; this.writes = []; children.forEach(n => n.parent = this); }
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
    hasAttribute(name) { return name in this.attrs; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.writes.push(name); this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
  }
  const text = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value });
  const make = score => new Element('DIV', [new Element('STRONG', [text(score)]), new Element('IFRAME', [], { src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE' })]);
  const root = make('0'), player = root.childNodes[1], previous = globalThis.document;
  globalThis.document = { createElement: () => ({ set innerHTML(value) { this.content = make(value); } }) };
  t.after(() => { globalThis.document = previous; });
  renderMediaPage(root, '1');
  assert.equal(root.childNodes[0].childNodes[0].nodeValue, '1');
  assert.equal(root.childNodes[1], player); assert.deepEqual(player.writes, []);
});


test('media managers manage assigned-board streams and the common gallery', () => {
  const state = seedDemo(), user = { role: 'media', boards: [1, 3] };
  const run = input => { assert.equal(refusal(actions.media, user), ''); checkBoard(state, input, user); updateMedia(state, input); };
  run({ operation: 'stream', boardId: 1, url: video, enabled: true });
  run({ operation: 'stream', matchId: 'M01', url: video, enabled: true });
  for (const input of [{ operation: 'stream', boardId: 2 }, { operation: 'stream', matchId: 'M02', boardId: 1 }, { operation: 'stream', matchId: 'M05', boardId: 1 }]) assert.throws(() => checkBoard(state, input, user), /assigned to you/);
  assert.throws(() => checkBoard(state, { operation: 'settings' }, user), /Only an event admin/);
  run({ operation: 'add', title: 'Shared gallery photo', kind: 'photo', url: 'https://instagram.com/p/SHARED/' });
  const id = state.media.gallery[0].id;
  assert.equal(state.media.gallery[0].boardId, undefined);
  updateMedia(state, { operation: 'add', title: 'Another contributor', kind: 'photo', url: 'https://instagram.com/p/OTHER/' });
  run({ operation: 'review', id: state.media.gallery[0].id, status: 'approved' });
  state.user = user;
  const html = mediaAdmin(state);
  assert.match(html, /Shared gallery photo/); assert.match(html, /Another contributor/);
  assert.doesNotMatch(html, /media-settings-form|value="M02"|data-board="2"|name="boardId"/);
  assert.equal(teamsFor(state.teams, 'media')[0].checkinToken, undefined);
  assert.equal(teamsFor(state.teams, 'media')[0].players[0].mobile, undefined);
  for (const [name, action] of Object.entries(actions)) if (name !== 'media') assert.notEqual(refusal(action, user), '', name);
  user.boards = [2];
  run({ operation: 'review', id, status: 'approved' });
  run({ operation: 'remove', id });
  assert.throws(() => run({ operation: 'stream', boardId: 1, remove: true }), /assigned to you/);
});


test('public gallery links enter the common queue as pending and appear only after approval', () => {
  const state = emptyState();
  assert.throws(() => submitGallery(state, { url: video, title: 'Moment', kind: 'video' }), /not accepting/);
  assert.doesNotMatch(galleryContent(state), /gallery-submit-invite/);
  assert.doesNotMatch(gallerySubmissionForm(state), /gallery-submit-form/);
  updateMedia(state, { operation: 'settings', galleryEnabled: true });
  assert.match(galleryContent(state), /href="\/gallery\/submit"/);
  assert.match(galleryContent(state), /data-link-qr="\/gallery\/submit"/);
  assert.match(gallerySubmissionForm(state), /id="gallery-submit-form"/);
  submitGallery(state, { url: video, title: 'A great match', kind: 'video', status: 'approved', source: 'official', boardId: 1 });
  const post = state.media.gallery[0];
  assert.equal(post.status, 'pending'); assert.equal(post.source, 'public'); assert.equal(post.boardId, undefined);
  assert.equal(publicState(state).media.gallery.length, 0);
  assert.match(mediaAdmin(state), /Public submission/);
  assert.throws(() => submitGallery(state, { url: video, title: 'Duplicate', kind: 'video' }), /already/);
  updateMedia(state, { operation: 'review', id: post.id, status: 'approved' });
  assert.equal(publicState(state).media.gallery.length, 1);
  assert.equal(publicState(state).media.gallery[0].source, undefined);
});
