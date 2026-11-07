/** Stored in each game's existing JSON, never in historical score fields. */
export interface RematchVotes {
  acceptedKeys: string[];
  requiredKeys: string[];
  nextId?: string;
  leftKeys?: string[];
}

export function voteRematch(previous: RematchVotes | undefined, eligible: string[], actor?: string, wanted?: boolean): RematchVotes {
  const requiredKeys = eligible.filter(key => !previous?.leftKeys?.includes(key));
  const accepted = new Set(previous?.acceptedKeys.filter(key => requiredKeys.includes(key)) ?? []);
  if (actor && wanted) accepted.add(actor);
  else if (actor) accepted.delete(actor);
  return { ...previous, requiredKeys, acceptedKeys: requiredKeys.filter(key => accepted.has(key)) };
}

export const rematchUnanimous = (votes: RematchVotes) => votes.requiredKeys.length >= 2
  && votes.requiredKeys.every(key => votes.acceptedKeys.includes(key));
