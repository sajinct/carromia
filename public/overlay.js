import { pagesMode, remoteApi, watch } from './runtime.js';
import { overlayMarkup, overlayMatch, overlayClock, overlaySourceUrl } from './overlay-view.js';

const query = new URLSearchParams(location.search), requested = query.get('board');
const sourceMode = requested !== null && /^[1-4]$/.test(requested);
let board = sourceMode ? Number(requested) : 1;
let state = { event: {}, teams: [], matches: [] }, connected = false, offset = 0, loading = null;
const setup = document.querySelector('#overlay-setup'), stage = document.querySelector('#overlay-stage');
const select = document.querySelector('#overlay-board'), output = document.querySelector('#overlay-url');
const feedback = document.querySelector('#overlay-feedback');
document.documentElement.dataset.mode = sourceMode ? 'source' : 'setup';
setup.hidden = sourceMode; stage.hidden = !sourceMode; select.value = String(board);
if (requested !== null && !sourceMode) feedback.textContent = 'Choose a board from 1 to 4 to generate an overlay URL.';

function render() {
  const practiceDisabled = pagesMode && query.get('practice') === '1' && state.practice !== true;
  const visible = practiceDisabled ? { ...state, practice: true, teams: [], matches: [] } : state;
  (sourceMode ? stage : document.querySelector('#overlay-preview')).innerHTML = overlayMarkup(visible, board, { now: Date.now() + offset, connected: connected && !practiceDisabled });
  document.title = `CARROMIA · Board ${board} stream overlay${state.practice ? ' · Practice' : ''}`;
  if (!sourceMode) {
    output.value = overlaySourceUrl(location.href, board, query.get('practice') === '1' || Boolean(state.practice));
    document.querySelector('#overlay-open').href = output.value;
    if (practiceDisabled && connected) feedback.textContent = 'Practice mode is turned off. Enable it from event settings to rehearse.';
  }
}

async function sync() {
  if (loading) return loading;
  loading = (async () => {
    let timeout;
    try {
      const sent = Date.now();
      const read = async () => {
        if (pagesMode) return remoteApi('public-state');
        const res = await fetch('/api/state', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('Tournament unavailable');
        return res.json();
      };
      state = await Promise.race([read(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Tournament timed out')), 10000); })]);
      if (Number.isFinite(state.serverTime)) offset = state.serverTime - (sent + Date.now()) / 2;
      connected = true;
    } catch { connected = false; }
    finally { clearTimeout(timeout); }
    render();
  })();
  try { await loading; } finally { loading = null; }
}

select.addEventListener('change', () => { board = Number(select.value); feedback.textContent = ''; render(); });
document.querySelector('#overlay-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(output.value); feedback.textContent = `Board ${board} browser source URL copied.`; }
  catch { output.focus(); output.select(); feedback.textContent = 'Select and copy the URL above.'; }
});
render();
await sync();
if (pagesMode) watch(sync);
else {
  const events = new EventSource('/api/events');
  events.onmessage = sync; events.onopen = sync;
  events.onerror = () => { connected = false; render(); };
  window.addEventListener('pagehide', () => events.close(), { once: true });
}
setInterval(sync, 15000);
setInterval(() => {
  const match = overlayMatch(state, board), clock = overlayClock(match, Date.now() + offset, connected);
  // Preserve the explicit practice-off state until a successful refresh.
  if (pagesMode && query.get('practice') === '1' && !state.practice) return;
  document.querySelectorAll('[data-overlay-time]').forEach(el => el.textContent = clock.text);
  document.querySelectorAll('[data-overlay-round]').forEach(el => el.textContent = clock.label);
}, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
