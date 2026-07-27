export const DIFFICULTY_LEVELS = [
  { key: 'beginner', sortOrder: 5, isEnabled: true },
  { key: 'easy', sortOrder: 10, isEnabled: true },
  { key: 'normal', sortOrder: 20, isEnabled: true },
] as const;

const DIFFICULTY_KEYS = new Set<string>(DIFFICULTY_LEVELS.map((difficulty) => difficulty.key));

export function isKnownDifficultyKey(key: string): boolean {
  return DIFFICULTY_KEYS.has(key);
}
