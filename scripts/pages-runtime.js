import { seedDemo, assign, start, result, eligible, log, fail, updateSettings } from './tournament-browser.js';

export const pagesMode = true;
const key = 'carromia-pages-demo-v2';
function read() {
  try { const data = JSON.parse(localStorage.getItem(key)); if (data?.version === 1 && data.demo === true) return data; } catch {}
  return seedDemo();
}
let state = read();
function save() { localStorage.setItem(key, JSON.stringify(state)); }
save();
export async function demoApi(path, input = {}) {
  state = read();
  if (path === 'state') return { ...structuredClone(state), isAdmin: true, localDemo: false, serverTime: Date.now(), matches: state.matches.map(m => ({ ...m, blockedReason: eligible(state, m) })) };
  if (path === 'backup') return structuredClone(state);
  const before = structuredClone(state);
  try {
    switch (path) {
      case 'assign': assign(state, input.id, input.board); break;
      case 'start': start(state, input.id); break;
      case 'result': result(state, input.id, input); break;
      case 'checkin': {
        const team = state.teams.find(t => t.id === input.id); fail(!team, 'Team not found.');
        fail(input.checkedIn === false && state.matches.some(m => ['called', 'playing', 'tiebreak'].includes(m.status) && [m.teamA, m.teamB].includes(team.id)), 'This team is assigned to a board.');
        team.checkedIn = input.checkedIn !== false; log(state, `${team.name} ${team.checkedIn ? 'checked in' : 'check-in removed'}`); break;
      }
      case 'unassign': {
        const m = state.matches.find(m => m.id === input.id); fail(!m || m.status !== 'called', 'Only called matches can return to the queue.');
        m.status = 'ready'; m.board = null; log(state, `${m.id} returned to queue`); break;
      }
      case 'settings': updateSettings(state, input); log(state, 'Demo settings updated in this browser'); break;
      case 'reset': fail(input.confirm !== 'RESET', 'Type RESET to reset the demo.'); state = seedDemo(); break;
      case 'logout': return { ok: true };
      default: throw new Error('This is a public demo. Real registration and shared event management need a hosted backend.');
    }
    save(); return { ok: true };
  } catch (error) { state = before; throw error; }
}
