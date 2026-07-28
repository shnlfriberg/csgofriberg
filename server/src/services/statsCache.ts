import { DIFFICULTY_LEVELS } from '../difficulties';

const difficultyKeys = DIFFICULTY_LEVELS.map((difficulty) => difficulty.key);

function normalizedSelection(difficulties: readonly string[]): string[] {
  const selected = new Set(difficulties);
  return difficultyKeys.filter((difficulty) => selected.has(difficulty));
}

function selectionKey(difficulties: readonly string[]): string {
  return normalizedSelection(difficulties).join('+');
}

function allSelections(): string[][] {
  const selections: string[][] = [];
  for (let mask = 1; mask < (1 << difficultyKeys.length); mask += 1) {
    selections.push(difficultyKeys.filter((_, index) => Boolean(mask & (1 << index))));
  }
  return selections;
}

export function globalStatsCacheKey(difficulties: readonly string[]): string {
  return `stats:global:${selectionKey(difficulties)}`;
}

export function personalStatsCacheKey(identityKey: string, difficulties: readonly string[]): string {
  return `stats:personal:${identityKey}:${selectionKey(difficulties)}`;
}

export function allGlobalStatsCacheKeys(): string[] {
  return allSelections().map(globalStatsCacheKey);
}

export function allPersonalStatsCacheKeys(identityKey: string): string[] {
  return allSelections().map((difficulties) => personalStatsCacheKey(identityKey, difficulties));
}

export function globalStatsCacheKeysForDifficulty(difficulty: string): string[] {
  return allSelections()
    .filter((selection) => selection.includes(difficulty))
    .map(globalStatsCacheKey);
}

export function personalStatsCacheKeysForDifficulty(identityKey: string, difficulty: string): string[] {
  return allSelections()
    .filter((selection) => selection.includes(difficulty))
    .map((difficulties) => personalStatsCacheKey(identityKey, difficulties));
}
