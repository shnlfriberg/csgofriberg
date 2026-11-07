import { DIFFICULTY_LEVELS } from '../difficulties';
import type { SingleGameVariant } from './gameModes';

const variants: SingleGameVariant[] = ['classic', 'turtle-soup'];

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

export function globalStatsCacheKey(difficulties: readonly string[], variant: SingleGameVariant = 'classic'): string {
  return `stats:global:v4:${variant}:${selectionKey(difficulties)}`;
}

export function personalStatsCacheKey(identityKey: string, difficulties: readonly string[], variant: SingleGameVariant = 'classic'): string {
  return `stats:personal:v3:${identityKey}:${variant}:${selectionKey(difficulties)}`;
}

export function allGlobalStatsCacheKeys(): string[] {
  return variants.flatMap((variant) => allSelections().map((selection) => globalStatsCacheKey(selection, variant)));
}

export function allPersonalStatsCacheKeys(identityKey: string): string[] {
  return variants.flatMap((variant) => allSelections().map((difficulties) => personalStatsCacheKey(identityKey, difficulties, variant)));
}

export function globalStatsCacheKeysForDifficulty(difficulty: string, variant: SingleGameVariant = 'classic'): string[] {
  return allSelections()
    .filter((selection) => selection.includes(difficulty))
    .map((selection) => globalStatsCacheKey(selection, variant));
}

export function personalStatsCacheKeysForDifficulty(identityKey: string, difficulty: string, variant: SingleGameVariant = 'classic'): string[] {
  return allSelections()
    .filter((selection) => selection.includes(difficulty))
    .map((difficulties) => personalStatsCacheKey(identityKey, difficulties, variant));
}
