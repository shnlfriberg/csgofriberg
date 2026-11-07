import { type Variant } from '@friberg/card-link-core';
import { z } from 'zod';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { cardDirectory } from './directory';
import { loadGraph } from './graphs';
import { cached } from '../services/queryCache';
import { identityKeys } from './claims';
import { decodeReplay } from './replay';
import { seatId } from './views';
import type { Owner } from './types';
import { variantSchema } from './validation';
import { replaySummary, replaySummarySchema } from './replaySummary';

export const statsQuery = z.object({ variant: variantSchema.default('unlimited') }).strict();
export const replaysQuery = statsQuery.extend({
  scene: z.enum(['all', 'practice', 'daily', 'friend', 'ranked']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
async function aggregate(variant: Variant, keys?: string[]) {
  const query = db('card_participants').where({ variant });
  if (keys) query.whereIn('identity_key', keys);
  const rows = await query.groupBy('scene').select('scene')
    .countDistinct({ games: 'match_id' }).count({ entries: '*' })
    .sum({ solved: 'solved', hops: 'hops', elapsed: 'elapsed' }) as unknown as { scene: string; games: string | number; entries: string | number; solved: string | number; hops: string | number; elapsed: string | number }[];
  const modes = Object.fromEntries(rows.map(row => [row.scene, Number(row.games)]));
  let games = 0, entries = 0, rounds = 0, solved = 0, hops = 0, elapsed = 0;
  for (const row of rows) {
    games += Number(row.games); entries += Number(row.entries);
    rounds += Number(row.entries) * (['friend', 'ranked'].includes(row.scene) ? 3 : 1);
    solved += Number(row.solved); hops += Number(row.hops); elapsed += Number(row.elapsed);
  }
  return { games, entries, rounds, solved, modes, solveRate: rounds ? solved / rounds : null,
    averageHops: solved ? hops / solved : null, averageElapsed: solved ? elapsed / solved : null };
}
export async function cardStats(owner: Owner, variant: Variant) {
  const keys = await identityKeys(owner);
  const [personal, global, rating] = await Promise.all([
    aggregate(variant, keys),
    cached(`card:stats:v1:${variant}`, 60, () => aggregate(variant)),
    owner.userId ? db('card_ratings').where({ user_id: owner.userId, variant }).first() : null,
  ]);
  return { personal, global, rating: rating ? Number(rating.rating) : null };
}
export async function cardReplays(owner: Owner, options: z.infer<typeof replaysQuery>) {
  const query = db('card_participants as p').join('card_results as r', 'r.match_id', 'p.match_id')
    .whereIn('p.identity_key', await identityKeys(owner)).where('p.variant', options.variant);
  if (options.scene !== 'all') query.where('p.scene', options.scene);
  const rows = await query.orderBy('r.created_at', 'desc').orderBy('p.match_id').orderBy('p.identity_key')
    .offset((options.page - 1) * 15).limit(16)
    .select('p.match_id', 'p.identity_key', 'p.variant', 'p.scene', 'p.solved', 'p.hops', 'p.elapsed', 'r.created_at', 'p.replay_summary');
  const visible = rows.slice(0, 15);
  const summaries = visible.map(row => {
    try { return replaySummarySchema.safeParse(JSON.parse(row.replay_summary)); } catch { return null; }
  });
  const legacyIds = visible.filter((_row, index) => !summaries[index]?.success).map(row => row.match_id);
  const legacy = legacyIds.length ? await db('card_results').whereIn('match_id', legacyIds).select('match_id', 'payload') : [];
  const oldPayloads = new Map(legacy.map(row => [String(row.match_id), row.payload]));
  return { hasNext: rows.length > 15, items: visible.map((row, index) => {
    const parsed = summaries[index];
    const summary = parsed?.success ? parsed.data : replaySummary(decodeReplay(oldPayloads.get(String(row.match_id))!), row.identity_key);
    // No identity keys or stored payloads are exposed by the list endpoint.
    return { id: String(row.match_id), variant: row.variant, scene: row.scene,
      ...summary,
      solved: Number(row.solved), hops: Number(row.hops),
      elapsed: Number(row.elapsed), finishedAt: Number(row.created_at) };
  }) };
}

/** One settled match of this identity (or its claimed guest keys) with the evidence of every saved path. */
export async function cardReplayDetail(id: string, owner: Owner) {
  if (!(await db('card_participants').where({ match_id: id }).whereIn('identity_key', await identityKeys(owner)).first()))
    throw new HttpError(404, 'CARD_MATCH_NOT_FOUND');
  const row = await db('card_results').where({ match_id: id }).first();
  const result = decodeReplay(row.payload);
  const g = await loadGraph(result.match.graphVersion);
  return {
    ...result,
    playersDirectory: await cardDirectory(g.data.players, result.match.variant),
    evidence: g.data.edges.filter((e) =>
      result.players.some((p: { results: ({ path: number[] } | null)[] }) =>
        p.results.some((r) =>
          r?.path.some(
            (pid, i) =>
              i > 0 &&
              ((pid === e.a && r.path[i - 1] === e.b) ||
                (pid === e.b && r.path[i - 1] === e.a)),
          ),
        ),
      ),
    ),
  };
}

