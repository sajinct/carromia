// Only supported social URLs become embeds; never accept pasted HTML.
export function socialLink(value, live = false) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('Enter a complete YouTube, Facebook or Instagram link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2000) throw new Error('Use a secure social media link without a custom port or login details.');
  const host = url.hostname.replace(/^www\./, '');
  let id;
  if (['youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:live|shorts|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('Use the link to a specific YouTube video or broadcast.');
    return { platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}`, embed: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1`, shape: 'video' };
  }
  if (['facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'].includes(host)) {
    if (url.pathname === '/') throw new Error('Use a Facebook post or video link.');
    url.hostname = host === 'fb.watch' ? host : 'www.facebook.com'; url.hash = '';
    const video = host === 'fb.watch' || /\/(?:videos|reel|watch|share\/v)(?:\/|$)/.test(url.pathname);
    return { platform: 'Facebook', url: url.href, embed: `https://www.facebook.com/plugins/${live || video ? 'video' : 'post'}.php?href=${encodeURIComponent(url.href)}&show_text=false&width=500`, shape: live || video ? 'video' : 'post' };
  }
  if (['instagram.com', 'm.instagram.com'].includes(host)) {
    const post = /^\/(p|reel|tv)\/([\w-]+)\/?$/.exec(url.pathname);
    if (post) { const canonical = `https://www.instagram.com/${post[1]}/${post[2]}/`; return { platform: 'Instagram', url: canonical, embed: live ? null : `${canonical}embed/`, shape: 'post' }; }
    if (live && /^\/[\w.]+\/live(?:\/[\w-]+)?\/?$/.test(url.pathname)) return { platform: 'Instagram', url: `https://www.instagram.com${url.pathname}`, embed: null, shape: 'video' };
    throw new Error(live ? 'Use an Instagram live broadcast link.' : 'Use an Instagram photo, video or reel link.');
  }
  throw new Error('Only YouTube, Facebook and Instagram links are supported.');
}

export function boardStream(state, boardId, matchId) {
  if (!state.media?.streamsEnabled) return null;
  const streams = state.media.streams || [];
  const stream = (matchId && streams.find(s => s.matchId === matchId)) || streams.find(s => !s.matchId && s.boardId === boardId);
  return stream?.enabled ? stream : null;
}

export function publicMedia(media = {}) {
  return { streamsEnabled: media.streamsEnabled === true, galleryEnabled: media.galleryEnabled === true,
    streams: media.streamsEnabled ? (media.streams || []).map(({ boardId, matchId, enabled, url }) => ({ boardId, matchId, enabled, url: enabled ? url : '' })) : [],
    gallery: media.galleryEnabled ? (media.gallery || []).filter(p => p.status === 'approved').map(({ id, url, title, kind, status }) => ({ id, url, title, kind, status })) : [] };
}
