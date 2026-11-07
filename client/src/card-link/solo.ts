import type { Difficulty, Variant } from '@friberg/card-link-core';
import type { Patch } from './state';
import type { View } from './types';

/**
 * 卡牌连接 单人 (practice) on the shared single-player API `/api/game`.
 * The classic envelope renames the match fields that clash with it: `gameId`
 * is the match id, `mode` the difficulty and `hand` the hand mode. These
 * helpers turn the responses back into the match View and seat Patch used by
 * the page and the Socket pushes.
 */
export type SoloCardView = Omit<View, 'id' | 'difficulty' | 'variant'> & {
  gameId: string;
  mode: Difficulty;
  variant: 'card-link';
  hand: Variant;
};
export type SoloCardPatch = Omit<Patch, 'id'> & { gameId: string; variant: 'card-link' };

export function fromSoloView(data: SoloCardView): View {
  const { gameId, mode, variant: _variant, hand, ...rest } = data;
  return { ...rest, id: gameId, difficulty: mode, variant: hand };
}

export function fromSoloPatch(data: SoloCardPatch): Patch {
  const { gameId, variant: _variant, ...rest } = data;
  return { ...rest, id: gameId };
}

export function isSoloPatch(data: SoloCardView | SoloCardPatch): data is SoloCardPatch {
  return 'baseRevision' in data;
}
