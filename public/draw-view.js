import { drawChangeBlocked, drawChangeToken } from './fixture.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const canManageDraw = state => state.user?.role === 'admin' || Boolean(state.practice && state.user?.role === 'official');
export function drawControls(state) {
  if (!canManageDraw(state)) return '';
  if (!state.matches.length) return '<button class="btn primary" data-action="draw">Create draw</button>';
  const blocked = drawChangeBlocked(state);
  return `<span class="draw-controls"><button class="btn outline" data-action="recreate-draw" ${blocked ? `disabled title="${esc(blocked)}"` : ''}>Recreate draw</button>${blocked ? '<small class="form-note">Draw locked after play starts.</small>' : ''}</span>`;
}
export function recreateDrawDialog(state) {
  if (!canManageDraw(state)) return '<h2>Only an event admin can change the draw.</h2>';
  const blocked = drawChangeBlocked(state);
  if (blocked) return `<h2>Draw locked</h2><p>${esc(blocked)}</p>`;
  if (!state.matches.length) return '<h2>No draw yet</h2><p>Create a new draw from the Bracket page.</p>';
  const confirmed = state.teams.filter(t => t.status !== 'pending').length, pending = state.teams.length - confirmed;
  return `<div class="eyebrow">BEFORE PLAY STARTS</div><h2>Recreate the draw?</h2><p>This clears the current fixtures, automatic byes and board calls. Team registrations, payment confirmations, photos, check-ins and lunch records are kept.</p><p>Board streams, the main event stream and live layout settings are kept. Links assigned to specific matches are removed because the match numbers will be reused.</p><p><strong>${confirmed} confirmed teams</strong> will enter a recreated draw.${pending ? ` ${pending} pending team${pending === 1 ? ' is' : 's are'} excluded.` : ''} Teams are shuffled again and a third-place playoff is included for four or more teams.</p><form id="redraw-form" data-draw-token="${esc(drawChangeToken(state))}"><label>What would you like to do?<select name="mode"><option value="recreate" ${confirmed < 2 ? 'disabled' : ''}>Recreate using the current confirmed teams</option><option value="clear" ${confirmed < 2 ? 'selected' : ''}>Clear draw to update teams first</option></select></label><p class="form-note">To add or remove teams, clear the draw first, update the team list, then create a new draw. Registration stays closed; reopen it in Event settings if needed, and check the registration deadline.</p><label>Type REDRAW to confirm<input name="confirm" required pattern="REDRAW" autocomplete="off"></label><p class="form-error" role="alert"></p><div class="dialog-actions">${state.user?.role === 'admin' ? '<button class="btn outline" type="button" data-action="backup">Download backup</button>' : ''}<button class="btn danger" type="submit">Confirm draw change</button></div></form>`;
}
