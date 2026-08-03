export const MAX_TEAM_HISTORY_ITEMS = 50;
export const MAX_TEAM_HISTORY_NAME_LENGTH = 64;

export function normalizeTeamHistory(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((team): team is string => typeof team === 'string')
    .map((team) => team.trim())
    .filter(Boolean)
    .slice(0, MAX_TEAM_HISTORY_ITEMS);
}

export function serializeTeamHistory(value: unknown): string {
  return JSON.stringify(normalizeTeamHistory(value));
}
