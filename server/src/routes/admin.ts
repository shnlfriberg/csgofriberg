import { Router } from 'express';
import type { Server } from 'socket.io';
import { z } from 'zod';
import { db } from '../db/knex';
import {
  guestNameFromKey,
  requireAuth,
  requireAdmin,
  userNameFromUsername,
} from '../middleware/auth';
import {
  validateBody,
  validateParams,
  validateQuery,
  asyncHandler,
  HttpError,
} from '../middleware/common';
import { invalidatePlayerCache } from '../services/playerCache';
import { invalidateCached } from '../services/queryCache';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { publishResourceVersion } from '../services/resourceVersion';
import { getPlayerPerformance } from '../services/playerPerformance';
import { compareGuess, completeGuessFeedback, MAX_GUESSES } from '../services/gameService';
import { getPlayer } from '../services/playerCache';
import { isKnownDifficultyKey } from '../difficulties';
import type { GuessFeedback, Player } from '../types';

const router = Router();
router.use(requireAuth, requireAdmin);
const adminReadLimit = rateLimit({
  name: 'admin-read',
  limit: 60,
  windowSeconds: 60,
  key: requestIdentity,
  failClosed: true,
});
const adminWriteLimit = rateLimit({
  name: 'admin-write',
  limit: 30,
  windowSeconds: 60,
  key: requestIdentity,
  failClosed: true,
});
const adminImportLimit = rateLimit({
  name: 'admin-import',
  limit: 10,
  windowSeconds: 60,
  key: requestIdentity,
  failClosed: true,
});
const adminResourceBroadcastLimit = rateLimit({
  name: 'admin-resource-broadcast',
  limit: 5,
  windowSeconds: 60,
  key: requestIdentity,
  failClosed: true,
});
const playerRoles = ['Rifler', 'AWPer', 'Coach'] as const;
const difficultyKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const difficultyListSchema = z.array(difficultyKeySchema)
  .min(1)
  .max(20)
  .refine((keys) => new Set(keys).size === keys.length);

const playerSchema = z.object({
  nickname: z.string().trim().min(1).max(64),
  nationality: z.string().trim().min(1).max(64),
  region: z.string().trim().max(32).default(''),
  team: z.string().trim().max(64).default(''),
  age: z.number().int().min(10).max(100),
  role: z.enum(playerRoles).default('Rifler'),
  major_championships: z.number().int().min(0).default(0),
  major_appearances: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  is_enabled: z.boolean().default(true),
  difficulties: difficultyListSchema.optional(),
});
const importedPlayerSchema = playerSchema.extend({
  is_enabled: z.boolean().optional(),
  is_easy: z.boolean().optional(),
});
const playerUpdateSchema = playerSchema.partial()
  .refine((values) => Object.keys(values).length > 0);
const playerImportSchema = z.object({
  players: z.array(importedPlayerSchema)
    .min(1)
    .max(1000)
    .refine((players) => new Set(players.map((player) => player.nickname)).size === players.length),
});

async function assertDifficultyKeys(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.some((key) => !isKnownDifficultyKey(key))) {
    throw new HttpError(400, 'INVALID_DIFFICULTY');
  }
}

async function replacePlayerDifficulties(
  executor: typeof db,
  playerId: number,
  keys: string[]
): Promise<void> {
  const unique = [...new Set(keys)];
  await executor('player_difficulties').where({ player_id: playerId }).del();
  if (unique.length) {
    await executor('player_difficulties').insert(
      unique.map((key) => ({ player_id: playerId, difficulty_key: key }))
    );
  }
}

const playerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  search: z.string().trim().max(100).default(''),
});
const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  search: z.string().trim().max(64).default(''),
});
const userGameListQuerySchema = z.object({
  type: z.enum(['single', 'multi']).default('single'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(5).max(30).default(10),
});
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const userGameReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  gameId: z.coerce.number().int().positive(),
});
const userMatchReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  matchId: z.coerce.number().int().positive(),
});

function matchPlayerDisplayId(row: { key?: unknown; name?: unknown; username?: unknown }): string {
  const key = typeof row.key === 'string' ? row.key : '';
  const name = typeof row.name === 'string' ? row.name : '';
  if (/^(访客|用户)#[0-9A-Z]{5}$/.test(name)) return name;
  if (key.startsWith('g:')) return guestNameFromKey(key.slice(2));
  if (key.startsWith('u:')) {
    const username = typeof row.username === 'string' && row.username ? row.username : name;
    return username ? userNameFromUsername(username) : '用户#未知';
  }
  return name || '未知对手';
}

function replayAnswer(target: Player) {
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

router.get(
  '/users',
  adminReadLimit,
  validateQuery(userListQuerySchema),
  asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof userListQuerySchema>;
    const { pageSize, search } = parsed;
    const query = db('users');
    if (search) {
      query.where((builder) => {
        builder.whereILike('username', `%${search}%`)
          .orWhereILike('display_id', `%${search}%`);
      });
    }
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.page, totalPages);
    const users = await query.clone()
      .select('id', 'username', 'display_id', 'role', 'created_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({
      users: users.map((user) => ({
        id: Number(user.id),
        username: user.username,
        displayId: user.display_id || userNameFromUsername(user.username),
        role: user.role,
        createdAt: user.created_at,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  })
);

router.get(
  '/users/:id/stats',
  adminReadLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const user = await db('users')
      .where({ id })
      .first('id', 'username', 'display_id', 'role', 'created_at');
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND');
    res.json({
      user: {
        id: Number(user.id),
        username: user.username,
        displayId: user.display_id || userNameFromUsername(user.username),
        role: user.role,
        createdAt: user.created_at,
      },
      stats: await getPlayerPerformance({
        key: `u:${user.id}`,
        userId: Number(user.id),
        name: user.username,
      }),
    });
  })
);

router.get(
  '/users/:id/games',
  adminReadLimit,
  validateParams(idParamsSchema),
  validateQuery(userGameListQuerySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const parsed = req.query as unknown as z.infer<typeof userGameListQuerySchema>;
    if (!(await db('users').where({ id }).first('id'))) throw new HttpError(404, 'USER_NOT_FOUND');
    const { type, page, pageSize } = parsed;
    const offset = (page - 1) * pageSize;

    if (type === 'single') {
      const rows = await db('games as g')
        .join('players as p', 'p.id', 'g.target_player_id')
        .where('g.user_id', id)
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
      return res.json({
        type,
        page,
        pageSize,
        hasNext: rows.length > pageSize,
        items: rows.slice(0, pageSize).map((row) => ({ type: 'single', ...row })),
      });
    }

    const identityKey = `u:${id}`;
    const rows = await db('match_players as me')
      .join('match_records as m', 'm.id', 'me.match_id')
      .where('me.user_id', id)
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
      items: visibleRows.map((row) => {
        const opponent = opponentByMatch.get(Number(row.id));
        return {
          type: 'multi',
          id: Number(row.id),
          mode: row.mode,
          boType: Number(row.boType),
          finishedAt: row.finishedAt,
          result: Boolean(row.meWinner) ? 'won' : Boolean(opponent?.isWinner) ? 'lost' : 'draw',
          me: { score: Number(row.meScore) },
          opponent: opponent
            ? { displayId: matchPlayerDisplayId(opponent), score: Number(opponent.score) }
            : null,
        };
      }),
    });
  })
);

router.get(
  '/users/:userId/games/:gameId/replay',
  adminReadLimit,
  validateParams(userGameReplayParamsSchema),
  asyncHandler(async (req, res) => {
    const { userId, gameId } = req.params as unknown as z.infer<typeof userGameReplayParamsSchema>;
    const game = await db('games')
      .where({ id: gameId, user_id: userId })
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
      id: Number(game.id),
      mode: game.mode,
      status: game.status,
      guessCount: Number(game.guess_count),
      createdAt: game.created_at,
      finishedAt: game.finished_at,
      answer: replayAnswer(target),
      guesses,
    });
  })
);

router.get(
  '/users/:userId/matches/:matchId/replay',
  adminReadLimit,
  validateParams(userMatchReplayParamsSchema),
  asyncHandler(async (req, res) => {
    const { userId, matchId } = req.params as unknown as z.infer<typeof userMatchReplayParamsSchema>;
    const match = await db('match_records as m')
      .join('match_players as me', 'me.match_id', 'm.id')
      .where('m.id', matchId)
      .where('me.user_id', userId)
      .first(
        'm.id',
        'm.db_type as mode',
        'm.bo_type as boType',
        'm.replay',
        'm.created_at as finishedAt',
        'me.id as mePlayerId',
        'me.player_key as meKey',
        'me.score as meScore',
        'me.is_winner as meWinner'
      );
    if (!match) throw new HttpError(404, 'GAME_NOT_FOUND');
    const opponent = await db('match_players as opponent')
      .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .where('opponent.match_id', matchId)
      .whereNot('opponent.id', match.mePlayerId)
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
      const parsed = JSON.parse(String(match.replay));
      if (Array.isArray(parsed)) storedRounds = parsed.slice(0, 30);
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
        winner: winnerKey === match.meKey ? 'me' : winnerKey === opponent.key ? 'opponent' : null,
        answer: replayAnswer(target),
        me: { guesses: replayGuesses(target, safeGuessIds(guesses[match.meKey])) },
        opponent: { guesses: replayGuesses(target, safeGuessIds(guesses[opponent.key])) },
      }];
    });
    res.json({
      id: Number(match.id),
      mode: match.mode,
      boType: Number(match.boType),
      finishedAt: match.finishedAt,
      result: Boolean(match.meWinner) ? 'won' : Boolean(opponent.isWinner) ? 'lost' : 'draw',
      me: { score: Number(match.meScore) },
      opponent: {
        displayId: matchPlayerDisplayId(opponent),
        score: Number(opponent.score),
      },
      rounds,
    });
  })
);

router.get(
  '/players',
  adminReadLimit,
  validateQuery(playerListQuerySchema),
  asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof playerListQuerySchema>;
    const { pageSize, search } = parsed;
    const query = db('players');
    if (search) {
      query.where((builder) => {
        builder.whereILike('nickname', `%${search}%`)
          .orWhereILike('nationality', `%${search}%`)
          .orWhereILike('region', `%${search}%`)
          .orWhereILike('team', `%${search}%`);
      });
    }
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.page, totalPages);
    const players = await query.clone()
      .orderBy('nickname')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const playerIds = players.map((player) => Number(player.id));
    const memberships = playerIds.length
      ? await db('player_difficulties')
        .whereIn('player_id', playerIds)
        .orderBy('difficulty_key')
        .select('player_id', 'difficulty_key')
      : [];
    const difficultiesByPlayer = new Map<number, string[]>();
    for (const membership of memberships) {
      const list = difficultiesByPlayer.get(Number(membership.player_id)) ?? [];
      list.push(String(membership.difficulty_key));
      difficultiesByPlayer.set(Number(membership.player_id), list);
    }
    res.json({
      players: players.map((player) => ({
        ...player,
        difficulties: difficultiesByPlayer.get(Number(player.id)) ?? [],
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  })
);

router.post(
  '/players',
  adminWriteLimit,
  validateBody(playerSchema),
  asyncHandler(async (req, res) => {
    const exists = await db('players').where({ nickname: req.body.nickname }).first();
    if (exists) throw new HttpError(409, 'NICKNAME_TAKEN');
    const difficulties = req.body.difficulties ?? ['normal'];
    await assertDifficultyKeys(difficulties);
    const { difficulties: _difficulties, ...values } = req.body;
    const id = await db.transaction(async (trx) => {
      const [createdId] = await trx('players')
        .insert(values)
        .returning('id')
        .then((rows) => rows.map((r: any) => (typeof r === 'object' ? r.id : r)));
      await replacePlayerDifficulties(trx as typeof db, Number(createdId), difficulties);
      return Number(createdId);
    });
    await invalidatePlayerCache();
    res.json({ id });
  })
);

router.put(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(playerUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { difficulties, ...values } = req.body;
    if (difficulties) await assertDifficultyKeys(difficulties);
    await db.transaction(async (trx) => {
      const exists = await trx('players').where({ id }).first('id');
      if (!exists) throw new HttpError(404, 'PLAYER_NOT_FOUND');
      if (Object.keys(values).length) await trx('players').where({ id }).update(values);
      if (difficulties) await replacePlayerDifficulties(trx as typeof db, id, difficulties);
    });
    await invalidatePlayerCache();
    res.json({ ok: true });
  })
);

router.delete(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const player = await db('players').where({ id }).first();
    if (!player) throw new HttpError(404, 'PLAYER_NOT_FOUND');
    if (Boolean(player.is_enabled)) throw new HttpError(409, 'PLAYER_MUST_BE_DISABLED');
    const used = await db('games').where({ target_player_id: id }).first();
    if (used) throw new HttpError(409, 'PLAYER_HAS_HISTORY');
    const count = await db('players').where({ id }).del();
    if (!count) throw new HttpError(404, 'PLAYER_NOT_FOUND');
    await invalidatePlayerCache();
    res.json({ ok: true });
  })
);

/** JSON 批量导入,按昵称 upsert */
router.post(
  '/players/import',
  adminImportLimit,
  validateBody(playerImportSchema),
  asyncHandler(async (req, res) => {
    let created = 0;
    let updated = 0;
    await db.transaction(async (trx) => {
      const nicknames = req.body.players.map((p: { nickname: string }) => p.nickname);
      const existing = await trx('players')
        .whereIn('nickname', nicknames)
        .select('id', 'nickname', 'is_enabled');
      const existingNames = new Set(existing.map((p: any) => p.nickname));
      const existingEnabled = new Map(
        existing.map((p: any) => [p.nickname, Boolean(p.is_enabled)])
      );
      updated = req.body.players.filter((p: { nickname: string }) => existingNames.has(p.nickname)).length;
      created = req.body.players.length - updated;
      const desiredDifficulties = new Map<string, string[] | null>();
      const importedPlayers = req.body.players.map((player: any) => {
        const { difficulties, is_easy, ...values } = player;
        const desired = difficulties
          ?? (is_easy !== undefined ? ['normal', ...(is_easy ? ['easy'] : [])] : null)
          ?? (existingNames.has(player.nickname) ? null : ['normal']);
        desiredDifficulties.set(player.nickname, desired);
        return {
          ...values,
          is_enabled: player.is_enabled ?? existingEnabled.get(player.nickname) ?? true,
        };
      });
      const difficultyKeys = [...new Set(
        [...desiredDifficulties.values()].flatMap((keys) => keys ?? [])
      )];
      await assertDifficultyKeys(difficultyKeys);
      const chunkSize = 200;
      for (let index = 0; index < importedPlayers.length; index += chunkSize) {
        await trx('players')
          .insert(importedPlayers.slice(index, index + chunkSize))
          .onConflict('nickname')
          .merge();
      }
      const savedPlayers = await trx('players').whereIn('nickname', nicknames).select('id', 'nickname');
      const replacementIds: number[] = [];
      const replacementMemberships: Array<{ player_id: number; difficulty_key: string }> = [];
      for (const player of savedPlayers) {
        const difficulties = desiredDifficulties.get(String(player.nickname));
        if (difficulties) {
          const playerId = Number(player.id);
          replacementIds.push(playerId);
          replacementMemberships.push(
            ...[...new Set(difficulties)].map((difficultyKey) => ({
              player_id: playerId,
              difficulty_key: difficultyKey,
            }))
          );
        }
      }
      if (replacementIds.length) {
        await trx('player_difficulties').whereIn('player_id', replacementIds).del();
        for (let index = 0; index < replacementMemberships.length; index += 500) {
          await trx('player_difficulties').insert(replacementMemberships.slice(index, index + 500));
        }
      }
    });
    await invalidatePlayerCache();
    res.json({ created, updated });
  })
);

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(128),
  content: z.string().trim().min(1).max(10000),
});

router.post(
  '/announcements',
  adminWriteLimit,
  validateBody(announcementSchema),
  asyncHandler(async (req, res) => {
    const [id] = await db('announcements')
      .insert(req.body)
      .returning('id')
      .then((rows) => rows.map((r: any) => (typeof r === 'object' ? r.id : r)));
    await invalidateCached('announcements');
    res.json({ id });
  })
);

router.delete(
  '/announcements/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const count = await db('announcements').where({ id }).del();
    if (!count) throw new HttpError(404, 'NOT_FOUND');
    await invalidateCached('announcements');
    res.json({ ok: true });
  })
);

router.post(
  '/resource-version/broadcast',
  adminResourceBroadcastLimit,
  validateBody(z.object({
    version: z.string().trim().regex(/^\d{13}$/),
  })),
  asyncHandler(async (req, res) => {
    const io = req.app.get('io') as Server | undefined;
    if (!io) throw new HttpError(503, 'SERVICE_UNAVAILABLE');
    const notice = await publishResourceVersion(req.body.version);
    io.emit('resource:version', notice);
    res.json(notice);
  })
);

export default router;
