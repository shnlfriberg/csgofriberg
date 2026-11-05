import { z } from "zod";
import type { Career } from "./careers";
import { effectiveTenures } from "./tenures";

export type TimelinePlayer = {
  playerId: number;
  nickname: string;
  career: Career | null;
};

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
);
const instantSchema = z.string().datetime({ offset: true });

/** The source has calendar-day precision. Explicit instants are converted to
 * UTC dates; offset-free timestamps are rejected instead of using host time. */
export function timelineDate(at: string): string {
  if (daySchema.safeParse(at).success) return at;
  return daySchema.parse(new Date(instantSchema.parse(at)).toISOString().slice(0, 10));
}

export function teamsAt(tenures: Career["tenures"], at: string) {
  const day = timelineDate(at);
  const groups = new Map<string, ReturnType<typeof effectiveTenures>>();
  for (const tenure of effectiveTenures(tenures)) {
    if (tenure.start > day || tenure.end <= day) continue;
    const group = groups.get(tenure.teamId) ?? [];
    group.push(tenure);
    groups.set(tenure.teamId, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([teamId, evidence]) => ({
    teamId,
    team: evidence[0].team,
    evidence,
  }));
}

/** Query approved facts, not a frozen game graph. Empty results mean no
 * confirmed membership, never proof of unemployment. Duplicate database
 * records are combined by personKey before evaluating conflicts/loans. */
export function playerTimelineAt(players: TimelinePlayer[], playerId: number, at: string) {
  const day = timelineDate(at);
  const player = players.find(p => p.playerId === playerId);
  if (!player) return null;
  const people = new Map<string, TimelinePlayer[]>();
  for (const row of players) {
    if (!row.career) continue;
    const group = people.get(row.career.personKey) ?? [];
    group.push(row);
    people.set(row.career.personKey, group);
  }
  const key = player.career?.personKey ?? null;
  const own = key === null ? [] : people.get(key)!;
  const ownTeams = teamsAt(own.flatMap(p => p.career!.tenures), day);
  const teams = ownTeams.map(team => ({ ...team, teammates: [] as Array<{
    playerId: number;
    playerIds: number[];
    personKey: string;
    nickname: string;
    evidence: typeof team.evidence;
  }> }));
  const byTeam = new Map(teams.map(team => [team.teamId, team]));
  if (teams.length) for (const [personKey, group] of people) {
    if (personKey === key) continue;
    const sorted = [...group].sort((a, b) => a.playerId - b.playerId);
    for (const membership of teamsAt(group.flatMap(p => p.career!.tenures), day)) {
      byTeam.get(membership.teamId)?.teammates.push({
        playerId: sorted[0].playerId,
        playerIds: sorted.map(p => p.playerId),
        personKey,
        nickname: sorted[0].nickname,
        evidence: membership.evidence,
      });
    }
  }
  for (const team of teams) team.teammates.sort((a, b) => a.playerId - b.playerId);
  return {
    playerId,
    personKey: key,
    day,
    coverage: key === null ? "missing-career" as const :
      teams.length ? "confirmed" as const : "no-confirmed-team" as const,
    teams,
  };
}
