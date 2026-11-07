import { createHash } from 'crypto';
import { z } from 'zod';
import { locationSoloDelta, locationSoloView } from '@friberg/location-core';
import { HttpError } from '../middleware/common';
import type { SoloContext, SoloVariantAdapter } from '../services/soloGames';
import { abandonGame, answerGameWithBase, ownsSoloGame, readGame, startSoloGame } from './games';
import { answerSchema, bannedMapIdsSchema, difficultySchema } from './validation';
import type { GameView, MapDefinition } from './types';

/**
 * 图寻 单人 (random) on `/api/game` with `variant: 'location'`.
 *
 * Responses use the classic envelope (`gameId`, `mode` = difficulty, `variant`).
 * The page reports the map snapshot it holds in `X-Location-Maps`; the snapshot
 * is sent only when it differs, results carry map ids, and an accepted guess is
 * a delta on the version it was made for.
 */
export const KNOWN_MAPS_HEADER = 'x-location-maps';

const hashes = new WeakMap<readonly MapDefinition[], string>();
export function soloMapsHash(maps: readonly MapDefinition[]): string {
  let hash = hashes.get(maps);
  if (!hash) {
    hash = createHash('sha256').update(JSON.stringify(maps)).digest('hex').slice(0, 16);
    hashes.set(maps, hash);
  }
  return hash;
}

function present(ctx: SoloContext, view: GameView) {
  const hash = soloMapsHash(view.maps);
  return locationSoloView(view, hash, ctx.header(KNOWN_MAPS_HEADER) !== hash);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
  return parsed.data;
}

const startOptions = z.object({ bannedMapIds: bannedMapIdsSchema });

export const locationSoloAdapter: SoloVariantAdapter = {
  async start(ctx, mode, options) {
    const difficulty = parse(difficultySchema, mode);
    const { bannedMapIds } = parse(startOptions, options);
    return present(ctx, await startSoloGame(ctx.owner, difficulty, bannedMapIds));
  },
  owns: (id, owner) => ownsSoloGame(id, owner),
  async state(ctx, id) {
    return present(ctx, await readGame(id, ctx.owner));
  },
  async guess(ctx, id, body) {
    const { view, base } = await answerGameWithBase(id, ctx.owner, parse(answerSchema, body));
    // A replay or an already recorded game has no base: send the current view.
    return base === null ? present(ctx, view) : locationSoloDelta(view, base);
  },
  async exit(ctx, id) {
    await abandonGame(id, ctx.owner);
  },
};
