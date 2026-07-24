import type { TFunction } from 'i18next';

export function difficultyLabel(t: TFunction, key: string): string {
  return t(`difficulty.${key}`, { defaultValue: key });
}
