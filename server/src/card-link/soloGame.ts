import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import type { SoloVariantAdapter } from '../services/soloGames';
import { identityKeys } from './claims';
import { commandMatch, controlMatch, createMatch, readView } from './matches';
import { notifyMatch } from './socket';
import { commandSchema, variantSchema } from './validation';
import type { MatchView } from './views';

/**
 * 卡牌连接 单人 (practice) on `/api/game` with `variant: 'card-link'`.
 *
 * The classic envelope renames the match fields that clash with it: `gameId`
 * is the match id, `mode` the difficulty and `hand` the hand mode (the match's
 * own `variant`). A command answers with the seat patch while the phase is
 * unchanged, the full view otherwise. SQL stays authoritative and Socket pushes
 * keep their original format.
 */
type CardSeatPatch = { id: string; baseRevision: number } & Record<string, unknown>;

export function cardSoloView(view: MatchView) {
  const { id, difficulty, variant, ...rest } = view;
  return { gameId: id, mode: difficulty, variant: 'card-link' as const, hand: variant, ...rest };
}

function presentCommand(result: MatchView | CardSeatPatch) {
  if ('baseRevision' in result) {
    const { id, ...patch } = result as CardSeatPatch;
    return { gameId: id, variant: 'card-link' as const, ...patch };
  }
  return cardSoloView(result as MatchView);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
  return parsed.data;
}

const difficultySchema = z.enum(['easy', 'normal', 'hard']);
const startOptions = z.object({
  hand: variantSchema.default('unlimited'),
  duration: z.union([z.literal(0), z.literal(120), z.literal(180), z.literal(300)]).default(0),
});

async function leave(id: string, owner: Parameters<typeof controlMatch>[1]) {
  // Leaving is idempotent (a retired seat stays retired), so no client key is needed.
  await controlMatch(id, owner, 'leave', randomUUID());
  void notifyMatch(id).catch(() => undefined);
}

export const cardSoloAdapter: SoloVariantAdapter = {
  async start(ctx, mode, options) {
    const difficulty = parse(difficultySchema, mode);
    const { hand, duration } = parse(startOptions, options);
    const { id } = await createMatch(ctx.owner, 'practice', hand, difficulty, duration, null, { resume: true });
    return cardSoloView(await readView(id, ctx.owner));
  },
  async owns(id, owner) {
    const row = await db('card_seats as s')
      .join('card_matches as m', 'm.id', 's.match_id')
      .where('s.match_id', id)
      .whereIn('s.identity_key', await identityKeys(owner))
      .first('m.scene');
    return row?.scene === 'practice';
  },
  async state(ctx, id) {
    return cardSoloView(await readView(id, ctx.owner));
  },
  async command(ctx, id, body) {
    const result = await commandMatch(id, ctx.owner, parse(commandSchema, body), { compact: true });
    void notifyMatch(id).catch(() => undefined);
    return presentCommand(result as MatchView | CardSeatPatch);
  },
  async giveup(ctx, id) {
    await leave(id, ctx.owner);
    return cardSoloView(await readView(id, ctx.owner));
  },
  async exit(ctx, id) {
    await leave(id, ctx.owner);
  },
};
