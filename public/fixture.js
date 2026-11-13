// Placement matches share the scoring rules, but never decide the championship.
export const isThirdPlace = match => match?.placement === 3;
export const finalMatch = state => state.matches.find(m => m.roundName === 'Final' && !isThirdPlace(m));
export const thirdPlaceMatch = state => state.matches.find(isThirdPlace);
export function drawChangeBlocked(state) {
  return state.matches.some(m => m.status === 'playing' || m.startedAt != null || m.rounds?.length || (m.status === 'completed' && !m.bye))
    ? 'The draw is locked because a match has started or a result has been recorded.' : '';
}
// Ignore screen-only fields such as blockedReason. Include the roster and draw identity so
// an old confirmation cannot replace another admin's new draw, even if the pairings repeat.
export function drawChangeToken(state) {
  return JSON.stringify([state.drawId ?? null, state.matches.map(m => [m.id, m.teamA, m.teamB, m.sources, m.status, m.board, m.winner, Boolean(m.bye)]), state.teams.filter(t => t.status !== 'pending').map(t => t.id).sort()]);
}
export function sourceTeam(match, source) {
  if (source?.status !== 'completed' || !source.winner) return null;
  return isThirdPlace(match) ? [source.teamA, source.teamB].find(id => id && id !== source.winner) ?? null : source.winner;
}
export function participantLabel(state, match, side, name) {
  const id = match[side === 0 ? 'teamA' : 'teamB'];
  if (id) return name(id);
  const sourceId = match.sources[side];
  if (!sourceId) return 'Bye';
  const source = state.matches.find(m => m.id === sourceId), resolved = sourceTeam(match, source);
  return resolved ? name(resolved) : source?.status === 'completed' ? 'Bye' : `${isThirdPlace(match) ? 'Loser' : 'Winner'} of ${sourceId}`;
}
