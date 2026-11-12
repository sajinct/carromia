// Presentation only: overlays use the public event and never change a match.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function overlaySourceUrl(base, board, practice = false) {
  if (![1, 2, 3, 4].includes(Number(board))) throw new Error('Choose a board from 1 to 4.');
  const url = new URL(base);
  url.hash = ''; url.search = '';
  url.searchParams.set('board', String(Number(board)));
  url.searchParams.set('practice', practice ? '1' : '0');
  return url.href;
}

export function overlaySetupUrl(base, pagesMode, practice = false) {
  const url = new URL(pagesMode ? './overlay.html' : '/overlay.html', base);
  url.searchParams.set('practice', practice ? '1' : '0');
  return url.href;
}

export function overlayMatch(state, board) {
  const matches = (state.matches || []).filter(m => m.board === Number(board));
  return matches.find(m => m.status === 'playing')
    || matches.find(m => m.status === 'called')
    || matches.filter(m => m.status === 'completed' && !m.bye).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0]
    || null;
}

export function overlayClock(match, now = Date.now(), connected = true) {
  if (!connected || !match) return { text: '—', label: !connected ? 'Updates interrupted' : 'Awaiting match' };
  if (match.status === 'completed') return { text: 'FINAL', label: match.walkover ? 'Walkover' : 'Match complete' };
  if (match.status === 'called') return { text: 'READY', label: 'Players called' };
  const round = match.rounds?.at(-1), number = (match.rounds?.length || 0) + (round?.winner ? 1 : 0);
  if (!round || round.winner) return { text: 'BREAK', label: `Round ${number || 1} next` };
  const seconds = Math.max(0, Math.ceil((round.endsAt - now) / 1000));
  return { text: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, label: seconds ? `Round ${number}` : 'Time up · umpire deciding' };
}

export function overlayMarkup(state, board, { now = Date.now(), connected = true } = {}) {
  const match = overlayMatch(state, board), clock = overlayClock(match, now, connected);
  const rounds = match?.gamesPerMatch ?? state.event?.gamesPerMatch ?? 3;
  const side = (id, key) => {
    const team = state.teams?.find(t => t.id === id), winner = Boolean(id && match?.winner === id);
    const score = match?.status === 'playing' || match?.status === 'completed' ? match[key] ?? 0 : 0;
    return `<div class="overlay-team${winner ? ' is-winner' : ''}"><div class="overlay-team-text"><strong class="overlay-team-name" title="${esc(team?.name)}">${esc(team?.name || 'Awaiting team')}</strong><span class="overlay-players">${team?.players?.map(p => esc(p.name)).join(' &amp; ') || 'The next match will appear automatically'}</span><span class="overlay-parish" title="${esc(team?.parish)}">${esc(team?.parish || 'CARROMIA · Open doubles')}</span></div><div class="overlay-score"><strong>${match ? (match.walkover ? '—' : score) : '—'}</strong><span>Rounds won</span></div></div>`;
  };
  const winner = match?.winner && state.teams?.find(t => t.id === match.winner);
  return `<section class="match-overlay${!connected ? ' is-disconnected' : ''}" aria-label="Board ${Number(board)} match scoreboard" data-clarity-mask="true">
    <header class="overlay-header"><div class="overlay-brand"><img src="./icon.svg" width="28" height="28" alt=""><strong>${esc(state.event?.name || 'CARROMIA')} <span>${esc(state.event?.year || '')}</span></strong></div><div class="overlay-match-meta"><b>BOARD ${String(Number(board)).padStart(2, '0')}</b><span>${match ? `${esc(match.roundName)} · ${esc(match.id)}` : 'Next match coming up'}</span></div><span class="overlay-status">${state.practice ? 'PRACTICE · ' : ''}${!connected ? 'UPDATES INTERRUPTED' : match?.status === 'playing' ? 'MATCH IN PLAY' : match?.status === 'completed' ? 'FINAL RESULT' : 'STANDING BY'}</span></header>
    <div class="overlay-scoreboard">${side(match?.teamA, 'gamesA')}<div class="overlay-clock"><strong data-overlay-time>${esc(clock.text)}</strong><span data-overlay-round>${esc(clock.label)}</span></div>${side(match?.teamB, 'gamesB')}</div>
    <footer class="overlay-footer"><span>${!connected ? 'Scores may be outdated · reconnecting…' : winner ? `WINNER · ${esc(winner.name)}${match.walkover ? ' · WALKOVER' : ''}` : `BEST OF ${rounds} · FIRST TO ${Math.ceil(rounds / 2)} WINS`}</span><span>THE GAME. THE COMMUNITY.</span></footer>
  </section>`;
}
