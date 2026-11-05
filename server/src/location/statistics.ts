import { z } from 'zod';
import { db } from '../db/knex';
import { difficultySchema } from './validation';
import type { Difficulty, LocationReplayPage, LocationStatsResponse, LocationStatsSummary } from './types';
import { acceptedSubmissionCount } from './submissions';

export const locationStatsQuery = z.object({
  difficulties: z.string().default('easy,normal,hard')
    .transform((value) => [...new Set(value.split(','))])
    .pipe(z.array(difficultySchema).min(1).max(3)),
});
export const locationReplaysQuery = locationStatsQuery.extend({
  type: z.enum(['single', 'multi']).default('single'),
  mode: z.enum(['all', 'random', 'daily']).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

async function summary(difficulties: Difficulty[], owner?: string): Promise<LocationStatsSummary> {
  const rank = db.ref('rank');
  const retired = db.ref('retired');
  const query = db('location_results').whereIn('difficulty', difficulties);
  if (owner) query.where({ identity_key: owner });
  // Aggregate in SQL instead of loading screenshot and map snapshots for every game.
  const rows = await query.select('mode').groupBy('mode')
    .count({ entries: '*' }).countDistinct({ games: 'game_id' })
    .sum({ scoreSum: 'score' }).max({ best: 'score' })
    .sum({ wins: db.raw("case when mode = 'multiplayer' and cast((?) as integer) = 1 and coalesce(cast((?) as text), 'false') not in ('true', '1') then 1 else 0 end", [rank, retired]) }) as unknown as Array<{
      mode: string; entries: number | string; games: number | string;
      scoreSum: number | string; best: number | string; wins: number | string;
    }>;
  const random = rows.find((row) => row.mode === 'random');
  const daily = rows.find((row) => row.mode === 'daily');
  const multi = rows.find((row) => row.mode === 'multiplayer');
  const singleGames = Number(random?.entries || 0) + Number(daily?.entries || 0);
  return {
    acceptedSubmissions: await acceptedSubmissionCount(owner),
    singleGames,
    randomGames: Number(random?.entries || 0),
    dailyGames: Number(daily?.entries || 0),
    averageScore: singleGames ? Math.round((Number(random?.scoreSum || 0) + Number(daily?.scoreSum || 0)) / singleGames) : null,
    bestScore: singleGames ? Math.max(Number(random?.best || 0), Number(daily?.best || 0)) : null,
    multiGames: Number(multi?.games || 0),
    multiEntries: Number(multi?.entries || 0),
    multiWins: Number(multi?.wins || 0),
    multiAverageScore: Number(multi?.entries) ? Math.round(Number(multi?.scoreSum) / Number(multi?.entries)) : null,
  };
}

export async function locationStatistics(owner: string, difficulties: Difficulty[]): Promise<LocationStatsResponse> {
  const revision = String((await db('location_catalog_revision').where({ id: 2 }).first())?.revision ?? -1);
  const key = [...difficulties].sort().join(',');
  let cached = globalSummaries.get(key);
  if (!cached || cached.revision !== revision || revision === '-1') {
    cached = { revision, value: summary(difficulties) };
    globalSummaries.set(key, cached);
    void cached.value.catch(() => { if (globalSummaries.get(key) === cached) globalSummaries.delete(key); });
  }
  const [personal, global] = await Promise.all([summary(difficulties, owner), cached.value]);
  return { difficulties, personal, global };
}
const globalSummaries = new Map<string, { revision: string; value: Promise<LocationStatsSummary> }>();

export async function locationReplays(owner: string, query: z.infer<typeof locationReplaysQuery>): Promise<LocationReplayPage> {
  const request = db('location_results').where({ identity_key: owner }).whereIn('difficulty', query.difficulties);
  if (query.type === 'multi') request.where({ mode: 'multiplayer' });
  else if (query.mode === 'all') request.whereIn('mode', ['random', 'daily']);
  else request.where({ mode: query.mode });
  const rows = await request.orderBy('finished_at', 'desc').orderBy('game_id', 'desc')
    .limit(query.pageSize + 1).offset((query.page - 1) * query.pageSize)
    .select('game_id', 'mode', 'difficulty', 'score', 'finished_at', 'rank', 'retired');
  return {
    page: query.page, pageSize: query.pageSize, hasNext: rows.length > query.pageSize,
    items: rows.slice(0, query.pageSize).map((row) => {
      return { gameId: row.game_id, mode: row.mode, difficulty: row.difficulty,
        totalScore: Number(row.score), finishedAt: Number(row.finished_at),
        rank: row.rank == null ? null : Number(row.rank), retired: [true, 1, 'true', '1'].includes(row.retired) };
    }),
  };
}
