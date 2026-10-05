import { socialLink, boardStream } from './social.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function embed(url, title, live = false) {
  let link; try { link = socialLink(url, live); } catch { return ''; }
  if (live && link.embed) {
    const player = new URL(link.embed), flag = link.platform === 'Facebook' ? 'true' : '1';
    player.searchParams.set('autoplay', flag); player.searchParams.set('mute', flag);
    link.embed = player.href;
  }
  return `${link.embed ? `<iframe class="social-embed ${link.shape}" src="${esc(link.embed)}" title="${esc(title)}" loading="${live ? 'eager' : 'lazy'}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>` : '<p class="form-note">Watch this broadcast on Instagram.</p>'}<a class="text-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${live ? 'Open stream' : 'View original'} on ${link.platform} ↗</a>${link.embed ? `<p class="form-note">${live ? 'Starts automatically, muted. Use the player controls for sound or press Play if autoplay is blocked. ' : ''}If the player is unavailable, open the original link.</p>` : ''}`;
}
export function streamCard(state, boardId, matchId) {
  const stream = boardStream(state, boardId, matchId);
  return stream ? `<section class="board-stream" aria-label="Board ${boardId} stream"><strong>Board ${boardId} · ${matchId || 'Live stream'}</strong>${embed(stream.url, `Board ${boardId} live stream`, true)}</section>` : '';
}
export function galleryContent(state) {
  const posts = state.media?.galleryEnabled ? (state.media.gallery || []).filter(p => p.status === 'approved') : [];
  return `<div class="gallery-intro"><div class="eyebrow">THE GAME. THE COMMUNITY.</div><h1>Photo &amp; video wall</h1><p>Moments from CARROMIA, shared on social media.</p></div>${posts.length ? `<div class="social-gallery">${posts.map(p => `<article class="panel gallery-item"><span class="badge neutral">${esc(p.kind === 'photo' ? 'Photo' : 'Video')}</span><h2>${esc(p.title)}</h2>${embed(p.url, p.title)}</article>`).join('')}</div>` : '<section class="panel empty"><h2>More moments to come.</h2><p>Approved photos and videos will appear here.</p></section>'}`;
}
export function mediaAdmin(state) {
  const media = state.media || {}, streams = media.streams || [], posts = media.gallery || [];
  const streamForm = (boardId, matchId = '') => {
    const stream = streams.find(s => matchId ? s.matchId === matchId : !s.matchId && s.boardId === boardId);
    return `<form class="media-stream-form" data-board="${boardId || ''}" data-match="${esc(matchId)}"><h3>${matchId ? `Match ${esc(matchId)}` : `Board ${boardId}`}</h3><label>Stream link<input name="url" type="url" maxlength="2000" value="${esc(stream?.url)}" placeholder="https://…"></label><label class="checkbox-label"><input type="checkbox" name="enabled" ${stream?.enabled ? 'checked' : ''}> Show this stream</label><p class="form-error" role="alert"></p><button class="btn outline small" type="submit">Save stream</button>${stream ? `<button class="btn outline small" type="button" data-action="media-remove-stream" data-board="${boardId || ''}" data-match="${esc(matchId)}">Remove link</button>` : ''}</form>`;
  };
  return `<div class="media-admin"><section class="panel settings-panel"><h2>Streams &amp; gallery</h2><form id="media-settings-form"><label class="checkbox-label"><input name="streamsEnabled" type="checkbox" ${media.streamsEnabled ? 'checked' : ''}> Show board streams on Live boards</label><label class="checkbox-label"><input name="galleryEnabled" type="checkbox" ${media.galleryEnabled ? 'checked' : ''}> Enable the public photo &amp; video wall</label><p class="form-error" role="alert"></p><button class="btn primary small" type="submit">Save display settings</button></form><p class="form-note">Broadcast using YouTube or Facebook, then paste the specific broadcast link below. Instagram live links open on Instagram. Content must be public and allow embedding. Turning streams off keeps the normal board view.</p><a class="text-link" href="/live" target="_blank">Preview Live boards ↗</a> · <a class="text-link" href="/gallery" target="_blank">Preview gallery ↗</a></section><section class="panel settings-panel"><h2>Board streams</h2><p>Board links stay with the board for successive matches. A match link takes priority; a disabled match link hides the stream for that match.</p><div class="media-stream-grid">${state.boards.map(b => streamForm(b.id)).join('')}</div></section><section class="panel settings-panel"><h2>Match streams</h2><form id="media-match-form"><div class="form-row"><label>Match<select name="matchId" required><option value="">Choose match</option>${state.matches.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${esc(m.roundName)}</option>`).join('')}</select></label><label>Stream link<input name="url" type="url" maxlength="2000" required></label></div><label class="checkbox-label"><input name="enabled" type="checkbox" checked> Show this stream</label><p class="form-error" role="alert"></p><button class="btn outline small" type="submit">Save match stream</button></form><div class="media-stream-grid">${streams.filter(s => s.matchId).map(s => streamForm(null, s.matchId)).join('')}</div></section><section class="panel settings-panel"><h2>Add a gallery link</h2><p>New links are pending until approved. Approval publishes them when the gallery is enabled.</p><form id="gallery-add-form"><label>Title<input name="title" maxlength="120" required></label><div class="form-row"><label>Social media link<input name="url" type="url" maxlength="2000" required></label><label>Media type<select name="kind"><option value="photo">Photo</option><option value="video">Video</option></select></label></div><p class="form-error" role="alert"></p><button class="btn primary small" type="submit">Add for review</button></form></section><section class="panel settings-panel"><h2>Gallery approvals (${posts.length})</h2>${posts.length ? posts.map(p => `<article class="gallery-review"><div><strong>${esc(p.title)}</strong> <span class="badge neutral">${esc(p.status)}</span><p><a href="${esc(socialLink(p.url).url)}" target="_blank" rel="noopener noreferrer">Review original ↗</a> · ${esc(p.kind)}</p></div><div class="media-review-actions">${[['approved', 'Approve'], ['pending', 'Hide / pending'], ['rejected', 'Reject']].filter(([s]) => s !== p.status).map(([s, label]) => `<button class="btn outline tiny" data-action="gallery-review" data-id="${esc(p.id)}" data-status="${s}">${label}</button>`).join('')}<button class="btn danger tiny" data-action="gallery-remove" data-id="${esc(p.id)}">Remove</button></div></article>`).join('') : '<p>No links added yet.</p>'}</section></div>`;
}

// Update existing nodes in place so board updates never detach unchanged video players.
export function renderMediaPage(root, html) {
  const template = document.createElement('template'); template.innerHTML = html;
  const patch = (parent, desired) => {
    const wanted = [...desired.childNodes];
    for (let i = 0; i < wanted.length; i++) {
      const next = wanted[i], current = parent.childNodes[i];
      if (!current) { parent.append(next.cloneNode(true)); continue; }
      if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); continue; }
      if (current.nodeType !== 1) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; continue; }
      for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      if (current.tagName !== 'IFRAME') patch(current, next);
    }
    while (parent.childNodes.length > wanted.length) parent.lastChild.remove();
  };
  patch(root, template.content);
}
