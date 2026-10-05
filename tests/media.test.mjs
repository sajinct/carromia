import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, seedDemo, updateMedia, publicState, refusal, actions, freshEvent, checkBoard, teamsFor } from '../lib/tournament.mjs';
import { socialLink, boardStream } from '../public/social.js';
import { streamCard, galleryContent, mediaAdmin, renderMediaPage } from '../public/media-view.js';

const video = 'https://youtu.be/M7lc1UVf-VE';
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
