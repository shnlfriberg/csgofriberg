import type { Career } from "./careers";

export function tenureProjection(playerId: number, career: Career, ordinal: number) {
  const tenure = career.tenures[ordinal];
  return {
    player_id: playerId,
    ordinal,
    person_key: career.personKey,
    team_id: tenure.teamId,
    start_date: tenure.start,
    end_date: tenure.end,
    payload: JSON.stringify(tenure),
  };
}

