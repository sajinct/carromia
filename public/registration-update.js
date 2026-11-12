import { findCentre, idTypes } from './parishes.js';

// One allowlist for the local server and Pages desk. Files are staged separately.
export function updateRegistration(state, input) {
  const fail = (condition, message) => { if (condition) throw new Error(message); };
  const clean = (value, limit = 80) => String(value ?? '').trim().slice(0, limit);
  const mobile = value => /^\+?[\d\s()-]{7,20}$/.test(value);
  const team = state.teams.find(t => t.id === input.id);
  fail(!team, 'Team not found.');
  fail(input.expectedVersion !== (team.registrationVersion || 0), 'This registration changed while you were editing. Close the editor and reopen it to review the latest details.');
  const group = team.group ? state.teams.filter(t => t.group?.id === team.group.id) : [team];
  const centre = findCentre(input.forane, input.parish, input.centreType);
  const name = clean(input.name), primaryContact = Number(input.primaryContact), lunch = Number(input.lunch);
  const players = (Array.isArray(input.players) ? input.players : []).map(p => ({ name: clean(p?.name), mobile: clean(p?.mobile, 20), idType: idTypes.includes(p?.idType) ? p.idType : '', idLast4: clean(p?.idLast4, 4).toUpperCase() }));
  fail(!name, 'Enter a team name.');
  fail(state.teams.some(t => t.id !== team.id && t.name.toLowerCase() === name.toLowerCase()), 'That team name is already registered.');
  fail(!centre, 'Choose your forane or zone, then your parish or centre from the list.');
  fail(players.length !== 2 || players.some(p => !p.name || !mobile(p.mobile)), 'Enter exactly two players with valid mobile numbers.');
  fail(players.some(p => !p.idType || !/^[A-Z0-9]{4}$/.test(p.idLast4)), 'Choose each player’s ID proof and enter the last 4 letters or digits of its number.');
  fail(![0, 1].includes(primaryContact), 'Choose the primary contact player.');
  fail(!Number.isInteger(lunch) || lunch < 0 || lunch > 2, 'Book zero, one or two lunches.');
  fail(lunch < (team.lunchServed || 0), 'Lunch bookings cannot be reduced below the lunches already served.');
  const parishKey = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(church|parish)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (parishKey(centre.name) !== parishKey(team.parish)) {
    const elsewhere = state.teams.filter(t => !group.includes(t) && parishKey(t.parish) === parishKey(centre.name)).length;
    fail(elsewhere + group.length > (state.event.maxTeamsPerParish ?? 4), 'The selected parish would exceed its team limit.');
  }
  const coordinator = team.group ? { name: clean(input.coordinator?.name), mobile: clean(input.coordinator?.mobile, 20) } : null;
  fail(coordinator && (!coordinator.name || !mobile(coordinator.mobile)), 'Enter the parish coordinator’s name and a valid mobile number.');
  const txnRef = clean(input.payment?.txnRef, 30).replace(/\s+/g, '').toUpperCase();
  fail(!team.payment && (txnRef || input.payment?.screenshot), 'This registration has no payment record to update.');
  if (team.payment) {
    fail(txnRef && !/^[A-Z0-9]{6,30}$/.test(txnRef), 'Enter a UTR of 6 to 30 letters or digits.');
    fail(!txnRef && !team.payment.screenshot && !input.payment?.screenshot, 'Enter the UPI transaction number or add a payment screenshot.');
  }
  // Validate everything before mutating. Shared registration details stay consistent for a group.
  const shared = { forane: centre.group, parish: centre.name, centreType: centre.type };
  const affected = [];
  for (const member of group) {
    const next = { ...member, ...shared,
      ...(member.group ? { group: { ...member.group, coordinator: { ...coordinator } } } : {}),
      ...(member.payment ? { payment: { ...member.payment, txnRef, screenshot: Boolean(member.payment.screenshot || input.payment?.screenshot) } } : {}) };
    if (member === team) Object.assign(next, { name, players, primaryContact, lunch });
    const sharedChanged = ['forane', 'parish', 'centreType'].some(key => next[key] !== member[key])
      || next.group?.coordinator?.name !== member.group?.coordinator?.name || next.group?.coordinator?.mobile !== member.group?.coordinator?.mobile
      || next.payment?.txnRef !== member.payment?.txnRef || next.payment?.screenshot !== member.payment?.screenshot;
    if (member === team || input.payment?.screenshot || sharedChanged) {
      next.registrationVersion = (member.registrationVersion || 0) + 1;
      Object.assign(member, next); affected.push(member.id);
    }
  }
  return affected;
}
