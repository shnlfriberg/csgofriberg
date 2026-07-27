import type { TFunction } from 'i18next';
import type { LucideIcon } from 'lucide-react';
import { Flame, Gamepad2, GraduationCap } from 'lucide-react';

export function difficultyLabel(t: TFunction, key: string): string {
  return t(`difficulty.${key}`, { defaultValue: key });
}

export function difficultyDescription(t: TFunction, key: string): string {
  return t(`difficulty.${key}Description`, { defaultValue: '' });
}

const DIFFICULTY_ICONS: Record<string, LucideIcon> = {
  beginner: GraduationCap,
  easy: Gamepad2,
  normal: Flame,
};

export function difficultyIcon(key: string): LucideIcon {
  return DIFFICULTY_ICONS[key] ?? Gamepad2;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: 'var(--primary)',
  easy: 'var(--success)',
  normal: 'var(--accent)',
};

export function difficultyColor(key: string): string {
  return DIFFICULTY_COLORS[key] ?? 'var(--primary)';
}
