export interface DifficultyOption {
  key: string;
  sortOrder: number;
  enabled: boolean;
  recommended?: boolean;
}

export const DIFFICULTIES: DifficultyOption[] = [
  { key: 'easy', sortOrder: 10, enabled: true, recommended: true },
  { key: 'normal', sortOrder: 20, enabled: true },
];

export const AVAILABLE_DIFFICULTIES = DIFFICULTIES
  .filter((difficulty) => difficulty.enabled)
  .sort((a, b) => a.sortOrder - b.sortOrder);
