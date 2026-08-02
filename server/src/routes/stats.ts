import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { guestNameFromKey, optionalAuth, userNameFromUsername } from '../middleware/auth';
import { asyncHandler, HttpError, validateParams, validateQuery } from '../middleware/common';
import { cached } from '../services/queryCache';
import { compareGuess, completeGuessFeedback, MAX_GUESSES } from '../services/gameService';
import { getPlayer, isDifficultyAvailable } from '../services/playerCache';
import { getPlayerPerformance } from '../services/playerPerformance';
import { GuessFeedback, Player } from '../types';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { globalStatsCacheKey, personalStatsCacheKey } from '../services/statsCache';
import { DIFFICULTY_LEVELS } from '../difficulties';

const router = Router();
router.use(optionalAuth);

type Owner = { user_id: number } | { guest_key: string };

function ownerFor(req: { user?: { id: number }; guestKey?: string }): Owner | null {
  if (req.user) return { user_id: req.user.id };
  if (req.guestKey) return { guest_key: req.guestKey };
  return null;
}

function identityKeyFor(req: { user?: { id: number }; guestKey?: string }): string | null {
  if (req.user) return `u:${req.user.id}`;
  return req.guestKey ? `g:${req.guestKey}` : null;
}

function identityDisplayId(row: {
  key?: unknown;
  name?: unknown;
  username?: unknown;
}): string {
  const key = typeof row.key === 'string' ? row.key : '';
  const storedName = typeof row.name === 'string' ? row.name : '';
  if (/^(访客|用户)#[0-9A-Z]{5}$/.test(storedName)) return storedName;
  if (key.startsWith('g:')) return guestNameFromKey(key.slice(2));
  if (key.startsWith('u:')) {
    const username = typeof row.username === 'string' && row.username
      ? row.username
      : storedName;
    return username ? userNameFromUsername(username) : '用户#未知';
  }
  return storedName || '未知对手';
}

function qualifiedOwner(owner: Owner, alias: string): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries(owner).map(([key, value]) => [`${alias}.${key}`, value])
  );
}

function singleSummary(row: any) {
  const totalGames = Number(row?.totalGames ?? 0);
  const wins = Number(row?.wins ?? 0);
  return {
    totalGames,
    wins,
    winRate: totalGames ? wins / totalGames : 0,
    avgGuesses: row?.avgGuesses != null ? Number(row.avgGuesses) : null,
    bestGuesses: row?.bestGuesses != null ? Number(row.bestGuesses) : null,
  };
}

function singleAggregate(query: ReturnType<typeof db>) {
  return query
    .whereNot('status', 'playing')
    .first()
    .count({ totalGames: 'id' })
    .sum({ wins: db.raw("case when status = 'won' then 1 else 0 end") })
    .avg({ avgGuesses: db.raw("case when status = 'won' then guess_count else null end") })
    .min({ bestGuesses: db.raw("case when status = 'won' then guess_count else null end") });
}

function multiAvgWinningGuesses(row: any): number | null {
  const winningRounds = Number(row?.winningRounds ?? 0);
  return winningRounds ? Number(row?.winningGuessSum ?? 0) / winningRounds : null;
}

function firstGuessPlayerId(value: unknown): number | null {
  try {
    const guesses = JSON.parse(String(value));
    if (!Array.isArray(guesses) || !guesses.length) return null;
    const first = guesses[0];
    const id = Number(
      typeof first === 'object' && first
        ? (first as { playerId?: unknown }).playerId
        : first
    );
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

async function firstGuessSummary(query: ReturnType<typeof db>) {
  const [rows, missingRows] = await Promise.all([
    query.clone()
      .where('first_guess_player_id', '>', 0)
      .select({ playerId: 'first_guess_player_id' })
      .count({ count: '*' })
      .groupBy('first_guess_player_id'),
    // During a rolling update, old instances may briefly insert rows without the new column.
    query.clone()
      .whereNull('first_guess_player_id')
      .where('guess_count', '>', 0)
      .whereNot('status', 'playing')
      .select('guesses'),
  ]) as unknown as [
    Array<{ playerId: unknown; count: unknown }>,
    Array<{ guesses: unknown }>,
  ];
  const counts = new Map<number, number>();
  for (const row of rows) {
    const playerId = Number(row.playerId);
    const count = Number(row.count);
    if (Number.isInteger(playerId) && playerId > 0 && count > 0) {
      counts.set(playerId, (counts.get(playerId) ?? 0) + count);
    }
  }
  for (const row of missingRows) {
    const playerId = firstGuessPlayerId(row.guesses);
    if (playerId) counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
  }
  const validCounts = Array.from(counts, ([playerId, count]) => ({ playerId, count }))
    .filter((row) => Boolean(getPlayer(row.playerId)));
  const total = validCounts.reduce((sum, row) => sum + row.count, 0);
  const top = validCounts
    .sort((a, b) => b.count - a.count || a.playerId - b.playerId)[0];
  if (!top || !total) return null;
  return {
    playerId: top.playerId,
    nickname: getPlayer(top.playerId)!.nickname,
    percentage: top.count / total,
  };
}

function answerView(target: Player) {
  return {
    id: target.id,
    nickname: target.nickname,
    team: target.team,
    nationality: target.nationality,
    region: target.region,
    age: target.age,
    role: target.role,
    majorChampionships: target.major_championships,
    majorAppearances: target.major_appearances,
    isActive: Boolean(target.is_active),
  };
}

async function globalStats(difficulties: string[]) {
  return cached(globalStatsCacheKey(difficulties), 60, async () => {
    const [single, multi, multiGuesses, users, firstGuess] = await Promise.all([
      singleAggregate(db('games').whereIn('mode', difficulties)),
      db('match_records').whereIn('db_type', difficulties).count({ total: 'id' }).first(),
      db('match_players as mp')
        .join('match_records as m', 'm.id', 'mp.match_id')
        .whereIn('m.db_type', difficulties)
        .first()
        .sum({ winningGuessSum: 'mp.winning_guess_sum' })
        .sum({ winningRounds: 'mp.winning_rounds' }),
      db('users').count({ total: 'id' }).first(),
      firstGuessSummary(db('games').whereIn('mode', difficulties)),
    ]);
    return {
      ...singleSummary(single),
      multiGames: Number(multi?.total ?? 0),
      multiAvgWinningGuesses: multiAvgWinningGuesses(multiGuesses),
      registeredUsers: Number(users?.total ?? 0),
      firstGuess,
    };
  });
}

async function personalStats(owner: Owner, identityKey: string, difficulties: string[]) {
  return cached(personalStatsCacheKey(identityKey, difficulties), 30, async () => {
    const [single, firstGuess, multi] = await Promise.all([
      singleAggregate(db('games').where(owner).whereIn('mode', difficulties)),
      firstGuessSummary(db('games').where(owner).whereIn('mode', difficulties)),
      db('match_players as mp')
        .join('match_records as m', 'm.id', 'mp.match_id')
        .where('mp.player_key', identityKey)
        .whereIn('m.db_type', difficulties)
        .first()
        .count({ total: 'mp.id' })
        .sum({ wins: db.raw('case when mp.is_winner then 1 else 0 end') })
        .sum({ winningGuessSum: 'mp.winning_guess_sum' })
        .sum({ winningRounds: 'mp.winning_rounds' }),
    ]);
    return {
      ...singleSummary(single),
      multiGames: Number(multi?.total ?? 0),
      multiWins: Number(multi?.wins ?? 0),
      multiAvgWinningGuesses: multiAvgWinningGuesses(multi),
      firstGuess,
    };
  });
}

const replayListQuery = z.object({
  type: z.enum(['single', 'multi']).default('single'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(5).max(30).default(15),
});
const statsSummaryQuery = z.object({
  difficulties: z.string().trim().min(1).max(128).optional(),
});
const replayIdParams = z.object({ id: z.coerce.number().int().positive() });

function safeGuessIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_GUESSES)
    .map((item) => Number(item))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function replayGuesses(target: Player, ids: number[]): GuessFeedback[] {
  return ids.flatMap((id) => {
    const guess = getPlayer(id);
    return guess ? [compareGuess(guess, target)] : [];
  });
}

/** 统计:当前身份的个人数据和全站聚合。回放列表独立分页查询。 */
router.get(
  '/me',
  rateLimit({
    name: 'stats-me',
    limit: 10,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateQuery(statsSummaryQuery),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const identityKey = identityKeyFor(req);
    if (!identityKey) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const available: string[] = DIFFICULTY_LEVELS
      .filter((difficulty) => difficulty.isEnabled && isDifficultyAvailable(difficulty.key))
      .map((difficulty) => difficulty.key);
    const raw = (req.query as unknown as z.infer<typeof statsSummaryQuery>).difficulties;
    const requested = raw
      ? [...new Set(raw.split(',').map((difficulty) => difficulty.trim()).filter(Boolean))]
      : available;
    if (!requested.length || requested.some((difficulty) => !available.includes(difficulty))) {
      throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    }
    const difficulties = available.filter((difficulty) => requested.includes(difficulty));
    const [personal, global] = await Promise.all([
      personalStats(owner, identityKey, difficulties),
      globalStats(difficulties),
    ]);

    res.json({ difficulties, personal, global });
  })
);

/** 个人回放列表。固定类型分页，避免跨大表合并和每页 count。 */
router.get(
  '/replays',
  rateLimit({
    name: 'stats-replay-list',
    limit: 20,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateQuery(replayListQuery),
  asyncHandler(async (req, res) => {
    const { type, page, pageSize } = req.query as unknown as z.infer<typeof replayListQuery>;
    const offset = (page - 1) * pageSize;

    if (type === 'single') {
      const owner = ownerFor(req);
      if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
      const rows = await db('games as g')
        .join('players as p', 'p.id', 'g.target_player_id')
        .where(qualifiedOwner(owner, 'g'))
        .whereNot('g.status', 'playing')
        .orderBy('g.finished_at', 'desc')
        .orderBy('g.id', 'desc')
        .offset(offset)
        .limit(pageSize + 1)
        .select(
          'g.id',
          'g.mode',
          'g.status',
          'g.guess_count as guessCount',
          'g.finished_at as finishedAt',
          'p.nickname as answer'
        );
      const hasNext = rows.length > pageSize;
      return res.json({
        type,
        page,
        pageSize,
        hasNext,
        items: rows.slice(0, pageSize).map((row) => ({ type: 'single', ...row })),
      });
    }

    const identityKey = identityKeyFor(req);
    if (!identityKey) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const rows = await db('match_players as me')
      .join('match_records as m', 'm.id', 'me.match_id')
      .where('me.player_key', identityKey)
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .offset(offset)
      .limit(pageSize + 1)
      .select(
        'm.id',
        'm.db_type as mode',
        'm.bo_type as boType',
        'm.created_at as finishedAt',
        'me.score as meScore',
        'me.is_winner as meWinner'
      );
    const visibleRows = rows.slice(0, pageSize);
    const matchIds = visibleRows.map((row) => Number(row.id));
    const opponents = matchIds.length
      ? await db('match_players as opponent')
        .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
        .whereIn('opponent.match_id', matchIds)
        .whereNot('opponent.player_key', identityKey)
        .select(
          'opponent.match_id as matchId',
          'opponent.player_key as key',
          'opponent.player_name as name',
          'opponent.score',
          'opponent.is_winner as isWinner',
          'opponent_user.username'
        )
      : [];
    const opponentByMatch = new Map(opponents.map((row) => [Number(row.matchId), row]));
    res.json({
      type,
      page,
      pageSize,
      hasNext: rows.length > pageSize,
      items: visibleRows.map((row) => ({
        type: 'multi',
        id: Number(row.id),
        mode: row.mode,
        boType: Number(row.boType),
        finishedAt: row.finishedAt,
        result: Boolean(row.meWinner)
          ? 'won'
          : Boolean(opponentByMatch.get(Number(row.id))?.isWinner)
            ? 'lost'
            : 'draw',
        me: { score: Number(row.meScore) },
        opponent: opponentByMatch.has(Number(row.id))
          ? {
              displayId: identityDisplayId(opponentByMatch.get(Number(row.id))!),
              score: Number(opponentByMatch.get(Number(row.id))!.score),
            }
          : null,
      })),
    });
  })
);

/** 最近单人对局回放详情，仅允许记录所属账号或访客读取。 */
router.get(
  '/games/:id/replay',
  rateLimit({
    name: 'stats-replay',
    limit: 15,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(replayIdParams),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const { id } = req.params as unknown as z.infer<typeof replayIdParams>;

    const game = await db('games')
      .where({ id, ...owner })
      .whereNot('status', 'playing')
      .first();
    if (!game) throw new HttpError(404, 'GAME_NOT_FOUND');
    const target = getPlayer(Number(game.target_player_id));
    if (!target) throw new HttpError(404, 'PLAYER_NOT_FOUND');

    let storedGuesses: unknown[] = [];
    try {
      const parsed = JSON.parse(String(game.guesses));
      if (Array.isArray(parsed)) storedGuesses = parsed;
    } catch {
      throw new HttpError(500, 'INTERNAL_ERROR');
    }
    const guesses = storedGuesses.flatMap((stored) => {
      if (typeof stored === 'number') {
        const guess = getPlayer(stored);
        return guess ? [compareGuess(guess, target)] : [];
      }
      if (!stored || typeof stored !== 'object' || !('playerId' in stored)) return [];
      const feedback = stored as GuessFeedback;
      return [completeGuessFeedback(feedback, getPlayer(feedback.playerId), target)];
    });

    res.json({
      id: game.id,
      mode: game.mode,
      status: game.status,
      guessCount: Number(game.guess_count),
      createdAt: game.created_at,
      finishedAt: game.finished_at,
      answer: answerView(target),
      guesses,
    });
  })
);

/** 回放对手战绩。对手由当前身份参与的指定对局唯一确定。 */
router.get(
  '/matches/:id/opponent-stats',
  rateLimit({
    name: 'stats-opponent-performance',
    limit: 10,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(replayIdParams),
  asyncHandler(async (req, res) => {
    const identityKey = identityKeyFor(req);
    if (!identityKey) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const { id } = req.params as unknown as z.infer<typeof replayIdParams>;

    const opponent = await db('match_players as me')
      .join('match_players as opponent', 'opponent.match_id', 'me.match_id')
      .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .where('me.match_id', id)
      .where('me.player_key', identityKey)
      .whereNot('opponent.player_key', identityKey)
      .first(
        'opponent.player_key as key',
        'opponent.player_name as name',
        'opponent.user_id as userId',
        'opponent_user.username'
      );
    if (!opponent) throw new HttpError(404, 'GAME_NOT_FOUND');

    res.json({
      displayId: identityDisplayId(opponent),
      stats: await getPlayerPerformance({
        key: String(opponent.key),
        userId: opponent.userId == null ? null : Number(opponent.userId),
        name: typeof opponent.name === 'string' ? opponent.name : '',
      }),
    });
  })
);

/** 多人回放详情，仅返回当前身份对应的我方与对方。 */
router.get(
  '/matches/:id/replay',
  rateLimit({
    name: 'stats-multi-replay',
    limit: 20,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(replayIdParams),
  asyncHandler(async (req, res) => {
    const identityKey = identityKeyFor(req);
    if (!identityKey) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const { id } = req.params as unknown as z.infer<typeof replayIdParams>;

    const match = await db('match_records as m')
      .join('match_players as me', 'me.match_id', 'm.id')
      .where('m.id', id)
      .where('me.player_key', identityKey)
      .first(
        'm.id',
        'm.db_type as mode',
        'm.bo_type as boType',
        'm.replay',
        'm.created_at as finishedAt',
        'me.score as meScore',
        'me.is_winner as meWinner'
      );
    if (!match) throw new HttpError(404, 'GAME_NOT_FOUND');
    const opponent = await db('match_players as opponent')
      .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .where('opponent.match_id', id)
      .whereNot('opponent.player_key', identityKey)
      .first(
        'opponent.player_key as key',
        'opponent.player_name as name',
        'opponent.score',
        'opponent.is_winner as isWinner',
        'opponent_user.username'
      );
    if (!opponent) throw new HttpError(404, 'GAME_NOT_FOUND');

    let storedRounds: unknown[] = [];
    try {
      const parsedReplay = JSON.parse(String(match.replay));
      if (Array.isArray(parsedReplay)) storedRounds = parsedReplay.slice(0, 30);
    } catch {
      throw new HttpError(500, 'INTERNAL_ERROR');
    }
    const rounds = storedRounds.flatMap((stored) => {
      if (!stored || typeof stored !== 'object') return [];
      const round = stored as Record<string, unknown>;
      const target = getPlayer(Number(round.targetPlayerId));
      if (!target) return [];
      const guessesByPlayer = round.guessesByPlayer;
      if (!guessesByPlayer || typeof guessesByPlayer !== 'object') return [];
      const guesses = guessesByPlayer as Record<string, unknown>;
      const winnerKey = typeof round.winnerKey === 'string' ? round.winnerKey : null;
      return [{
        round: Number(round.round),
        reason: typeof round.reason === 'string' ? round.reason : '',
        winner: winnerKey === identityKey ? 'me' : winnerKey === opponent.key ? 'opponent' : null,
        answer: answerView(target),
        me: { guesses: replayGuesses(target, safeGuessIds(guesses[identityKey])) },
        opponent: { guesses: replayGuesses(target, safeGuessIds(guesses[opponent.key])) },
      }];
    });

    res.json({
      id: Number(match.id),
      mode: match.mode,
      boType: Number(match.boType),
      finishedAt: match.finishedAt,
      result: Boolean(match.meWinner)
        ? 'won'
        : Boolean(opponent.isWinner)
          ? 'lost'
          : 'draw',
      me: { score: Number(match.meScore) },
      opponent: {
        displayId: identityDisplayId(opponent),
        score: Number(opponent.score),
      },
      rounds,
    });
  })
);

export default router;
