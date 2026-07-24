export interface DifficultyOption {
  key: string;
  sortOrder: number;
  enabled: boolean;
}

export const DIFFICULTIES: DifficultyOption[] = [
  { key: 'normal', sortOrder: 10, enabled: true },
  { key: 'easy', sortOrder: 20, enabled: true },
];

export const AVAILABLE_DIFFICULTIES = DIFFICULTIES
  .filter((difficulty) => difficulty.enabled)
  .sort((a, b) => a.sortOrder - b.sortOrder);
