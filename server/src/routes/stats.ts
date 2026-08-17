import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { guestNameFromKey, optionalAuth, userNameFromUsername } from '../middleware/auth';
import { asyncHandler, HttpError, validateParams, validateQuery } from '../middleware/common';
import { cached } from '../services/queryCache';
import { compareGuess, refreshGuessFeedback, MAX_GUESSES } from '../services/gameService';
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

async function firstGuessSummary(query: ReturnType<typeof db>) {
  const rows = await query.clone()
    .where('first_guess_player_id', '>', 0)
    .select({ playerId: 'first_guess_player_id' })
    .count({ count: '*' })
    .groupBy('first_guess_player_id') as unknown as Array<{ playerId: unknown; count: unknown }>;
  const counts = new Map<number, number>();
  for (const row of rows) {
    const playerId = Number(row.playerId);
    const count = Number(row.count);
    if (Number.isInteger(playerId) && playerId > 0 && count > 0) {
      counts.set(playerId, (counts.get(playerId) ?? 0) + count);
    }
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
      db('match_records').whereIn('db_type', difficulties).where('game_mode', 'classic').count({ total: 'id' }).first(),
      db('match_players as mp')
        .join('match_records as m', 'm.id', 'mp.match_id')
        .whereIn('m.db_type', difficulties)
        .where('m.game_mode', 'classic')
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
        .where('m.game_mode', 'classic')
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

function replayTeamScores(value: unknown): { a: number; b: number } | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return null;
    const lastRound = [...parsed].reverse().find((round) => round && typeof round === 'object' && 'teamScores' in round);
    if (!lastRound || typeof lastRound.teamScores !== 'object' || !lastRound.teamScores) return null;
    const scores = lastRound.teamScores as Record<string, unknown>;
    return { a: Number(scores.a) || 0, b: Number(scores.b) || 0 };
  } catch {
    return null;
  }
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
        'm.game_mode as gameMode',
        'm.total_rounds as totalRounds',
        'm.relay_solved_rounds as relaySolvedRounds',
        'm.winner_team as winnerTeam',
        'm.replay',
        'm.created_at as finishedAt',
        'me.score as meScore',
        'me.is_winner as meWinner',
        'me.team as meTeam'
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
          'opponent.team as team',
          'opponent.is_eliminated as isEliminated',
          'opponent.elimination_reason as eliminationReason',
          'opponent_user.username'
        )
      : [];
    const opponentsByMatch = new Map<number, typeof opponents>();
    for (const opponent of opponents) {
      const matchId = Number(opponent.matchId);
      const list = opponentsByMatch.get(matchId) ?? [];
      list.push(opponent);
      opponentsByMatch.set(matchId, list);
    }
    res.json({
      type,
      page,
      pageSize,
      hasNext: rows.length > pageSize,
      items: visibleRows.map((row) => {
        const teamScores = row.gameMode === 'relay2v2' ? replayTeamScores(row.replay) : null;
        return {
        type: 'multi',
        id: Number(row.id),
        mode: row.mode,
        boType: Number(row.boType),
        gameMode: row.gameMode === 'relay2v2' ? 'relay2v2' : row.gameMode === 'relay' ? 'relay' : 'classic',
        totalRounds: Number(row.totalRounds),
        relaySolvedRounds: Number(row.relaySolvedRounds),
        ...(teamScores ? { teamScores } : {}),
        finishedAt: row.finishedAt,
        result: row.gameMode === 'relay'
          ? 'cooperative'
          : row.gameMode === 'relay2v2'
          ? row.winnerTeam === row.meTeam ? 'won' : 'lost'
          : Boolean(row.meWinner)
          ? 'won'
          : (opponentsByMatch.get(Number(row.id)) ?? []).some((opponent) => Boolean(opponent.isWinner))
            ? 'lost'
            : 'draw',
        me: { score: Number(row.meScore) },
        participants: (opponentsByMatch.get(Number(row.id)) ?? []).map((opponent, index) => ({
          id: `p${index + 1}`,
          displayId: identityDisplayId(opponent),
          score: Number(opponent.score),
          isWinner: Boolean(opponent.isWinner),
          team: opponent.team ?? null,
          eliminated: Boolean(opponent.isEliminated),
          eliminationReason: opponent.eliminationReason ?? null,
        })),
        opponent: (opponentsByMatch.get(Number(row.id)) ?? []).length
          ? {
              displayId: identityDisplayId(opponentsByMatch.get(Number(row.id))![0]),
              score: Number(opponentsByMatch.get(Number(row.id))![0].score),
            }
          : null,
        };
      }),
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
      return [refreshGuessFeedback(feedback, getPlayer(feedback.playerId), target)];
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
        'm.game_mode as gameMode',
        'm.total_rounds as totalRounds',
        'm.relay_solved_rounds as relaySolvedRounds',
        'm.winner_team as winnerTeam',
        'm.replay',
        'm.created_at as finishedAt',
        'me.score as meScore',
        'me.is_winner as meWinner',
        'me.team as meTeam',
        'me.is_eliminated as meEliminated',
        'me.elimination_reason as meEliminationReason'
      );
    if (!match) throw new HttpError(404, 'GAME_NOT_FOUND');
    const participantRows = await db('match_players as opponent')
      .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .where('opponent.match_id', id)
      .whereNot('opponent.player_key', identityKey)
      .select(
        'opponent.player_key as key',
        'opponent.player_name as name',
        'opponent.score',
        'opponent.is_winner as isWinner',
        'opponent.team as team',
        'opponent.is_eliminated as isEliminated',
        'opponent.elimination_reason as eliminationReason',
        'opponent_user.username'
      );
    const opponent = participantRows[0];
    if (!opponent && match.gameMode === 'relay') throw new HttpError(404, 'GAME_NOT_FOUND');
    const participants = [{
      key: identityKey,
      id: 'me',
      displayId: 'me',
      score: Number(match.meScore),
      isMe: true,
      isWinner: Boolean(match.meWinner),
      team: match.meTeam ?? null,
      eliminated: Boolean(match.meEliminated),
      eliminationReason: match.meEliminationReason ?? null,
    }, ...participantRows.map((participant, index) => ({
      key: String(participant.key),
      id: `p${index + 1}`,
      displayId: identityDisplayId(participant),
      score: Number(participant.score),
      isMe: false,
      isWinner: Boolean(participant.isWinner),
      team: participant.team ?? null,
      eliminated: Boolean(participant.isEliminated),
      eliminationReason: participant.eliminationReason ?? null,
    }))];
    const participantIdByKey = new Map(participants.map((participant) => [participant.key, participant.id]));

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
      const sharedGuesses = Array.isArray(round.sharedGuesses)
        ? round.sharedGuesses.slice(0, 15).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const storedGuess = item as Record<string, unknown>;
          const guess = getPlayer(Number(storedGuess.playerId));
          if (!guess) return [];
          const actorKey = typeof storedGuess.actorKey === 'string' ? storedGuess.actorKey : '';
          const actor = participants.find((participant) => participant.key === actorKey);
          return [{
            actor: actorKey === identityKey ? 'me' as const : opponent && actorKey === opponent.key ? 'opponent' as const : null,
            actorDisplayId: actor?.displayId ?? null,
            feedback: compareGuess(guess, target),
            guessTime: Number.isFinite(Number(storedGuess.guessTime)) ? Number(storedGuess.guessTime) : null,
          }];
        })
        : [];
      const teamGuesses = Object.fromEntries((['a', 'b'] as const).map((team) => [team, Array.isArray((round.teamGuesses as Record<string, unknown> | undefined)?.[team])
        ? ((round.teamGuesses as Record<string, unknown>)[team] as unknown[]).slice(0, 15).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const storedGuess = item as Record<string, unknown>;
          const guess = getPlayer(Number(storedGuess.playerId));
          if (!guess) return [];
          const actorKey = typeof storedGuess.actorKey === 'string' ? storedGuess.actorKey : '';
          const actor = participants.find((participant) => participant.key === actorKey);
          return [{
            actor: actorKey === identityKey ? 'me' as const : opponent && actorKey === opponent.key ? 'opponent' as const : null,
            actorDisplayId: actor?.displayId ?? null,
            feedback: compareGuess(guess, target),
            guessTime: Number.isFinite(Number(storedGuess.guessTime)) ? Number(storedGuess.guessTime) : null,
          }];
        })
        : []])) as Record<'a' | 'b', unknown[]>;
      const teamScores = round.teamScores && typeof round.teamScores === 'object'
        ? {
          a: Number((round.teamScores as Record<string, unknown>).a) || 0,
          b: Number((round.teamScores as Record<string, unknown>).b) || 0,
        }
        : null;
      const winnerKey = typeof round.winnerKey === 'string' ? round.winnerKey : null;
      return [{
        round: Number(round.round),
        reason: typeof round.reason === 'string' ? round.reason : '',
        winner: winnerKey === identityKey ? 'me' : opponent && winnerKey === opponent.key ? 'opponent' : null,
        winnerTeam: round.winnerTeam === 'a' || round.winnerTeam === 'b' ? round.winnerTeam : null,
        winnerParticipantId: winnerKey ? participantIdByKey.get(winnerKey) ?? null : null,
        answer: answerView(target),
        me: { guesses: replayGuesses(target, safeGuessIds(guesses[identityKey])) },
        opponent: { guesses: replayGuesses(target, safeGuessIds(guesses[opponent?.key ?? ''])) },
        players: participants.map((participant) => ({
          participantId: participant.id,
          guesses: replayGuesses(target, safeGuessIds(guesses[participant.key])),
        })),
        sharedGuesses,
        teamGuesses,
        teamScores,
      }];
    });
    const finalTeamScores = (rounds.at(-1) as { teamScores?: { a: number; b: number } | null } | undefined)?.teamScores ?? undefined;

    res.json({
      id: Number(match.id),
      mode: match.mode,
      boType: Number(match.boType),
      gameMode: match.gameMode === 'relay2v2' ? 'relay2v2' : match.gameMode === 'relay' ? 'relay' : 'classic',
      totalRounds: Number(match.totalRounds),
      relaySolvedRounds: Number(match.relaySolvedRounds),
      ...(finalTeamScores ? { teamScores: finalTeamScores } : {}),
      finishedAt: match.finishedAt,
      result: match.gameMode === 'relay'
        ? 'cooperative'
        : match.gameMode === 'relay2v2'
        ? match.winnerTeam === match.meTeam ? 'won' : 'lost'
        : Boolean(match.meWinner)
        ? 'won'
        : participantRows.some((participant) => Boolean(participant.isWinner))
          ? 'lost'
          : 'draw',
      me: { score: Number(match.meScore) },
      opponent: opponent ? {
        displayId: identityDisplayId(opponent),
        score: Number(opponent.score),
      } : null,
      participants: participants.map(({ key: _key, ...participant }) => participant),
      winnerParticipantId: participants.find((participant) => participant.isWinner)?.id ?? null,
      rounds,
    });
  })
);

export default router;
