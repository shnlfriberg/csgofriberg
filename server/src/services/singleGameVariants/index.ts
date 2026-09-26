import { HttpError } from '../../middleware/common';
import { isSingleGameVariant, type SingleGameVariant } from '../gameModes';
import { classicSingleGameHandler } from './classic';
import { turtleSoupSingleGameHandler } from './turtleSoup';
import type { SingleGameVariantHandler } from './types';

export type { SingleGameGuessInput, SingleGameVariantHandler } from './types';

const singleGameHandlers = {
  classic: classicSingleGameHandler,
  'turtle-soup': turtleSoupSingleGameHandler,
} satisfies Record<SingleGameVariant, SingleGameVariantHandler>;

export function getSingleGameHandler(variant: unknown): SingleGameVariantHandler {
  if (!isSingleGameVariant(variant)) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  return singleGameHandlers[variant];
}
