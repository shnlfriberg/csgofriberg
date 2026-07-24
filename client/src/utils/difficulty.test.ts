import { describe, expect, it } from 'vitest';
import { Flame, Gamepad2 } from 'lucide-react';
import i18n from '../i18n';
import {
  difficultyColor,
  difficultyDescription,
  difficultyIcon,
  difficultyLabel,
} from './difficulty';

describe('difficulty helpers', () => {
  it('maps known difficulties to distinct icons and colors', () => {
    expect(difficultyIcon('easy')).toBe(Gamepad2);
    expect(difficultyIcon('normal')).toBe(Flame);
    expect(difficultyIcon('unknown')).toBe(Gamepad2);

    expect(difficultyColor('easy')).toBe('var(--success)');
    expect(difficultyColor('normal')).toBe('var(--accent)');
    expect(difficultyColor('unknown')).toBe('var(--primary)');
  });

  it('resolves localized labels and descriptions', () => {
    const t = i18n.t.bind(i18n);
    expect(difficultyLabel(t, 'easy')).toBe('简单版');
    expect(difficultyDescription(t, 'easy')).toBe('知名选手池 · 快速上手');
    expect(difficultyDescription(t, 'missing')).toBe('');
  });
});