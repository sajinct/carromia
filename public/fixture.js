// Placement matches share the scoring rules, but never decide the championship.
export const isThirdPlace = match => match?.placement === 3;
export const finalMatch = state => state.matches.find(m => m.roundName === 'Final' && !isThirdPlace(m));
export const thirdPlaceMatch = state => state.matches.find(isThirdPlace);
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
