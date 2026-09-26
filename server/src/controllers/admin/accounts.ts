import { z } from 'zod';
import { db } from '../../db/knex';
import { userNameFromUsername } from '../../middleware/auth';
import { asyncHandler, HttpError } from '../../middleware/common';
import { getPlayerPerformance } from '../../services/playerPerformance';
import { DIFFICULTY_LEVELS } from '../../difficulties';
import { userListQuerySchema, userGameListQuerySchema, idParamsSchema } from '../../routes/adminSchemas';
import { matchPlayerDisplayId } from './helpers';
import { adminGameAnswerName } from './gameViews';

export const listUsers = asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof userListQuerySchema>;
    const { pageSize, search } = parsed;
    const query = db('users');
    if (search) {
      query.where((builder) => {
        builder.whereILike('username', `%${search}%`)
          .orWhereILike('display_id', `%${search}%`)
          .orWhereILike('email', `%${search}%`);
      });
    }
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.page, totalPages);
    const users = await query.clone()
      .select('id', 'username', 'display_id', 'role', 'leaderboard_hidden', 'matchmaking_restricted', 'email', 'email_verified_at', 'banned_at', 'created_at')
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
        leaderboardHidden: Boolean(user.leaderboard_hidden),
        matchmakingRestricted: Boolean(user.matchmaking_restricted),
        email: user.email ?? null,
        emailVerified: Boolean(user.email_verified_at),
        banned: Boolean(user.banned_at),
        createdAt: user.created_at,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  });

export const getUserStats = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const user = await db('users')
      .where({ id })
      .first('id', 'username', 'display_id', 'role', 'leaderboard_hidden', 'matchmaking_restricted', 'email', 'email_verified_at', 'banned_at', 'created_at');
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND');
    res.json({
      user: {
        id: Number(user.id),
        username: user.username,
        displayId: user.display_id || userNameFromUsername(user.username),
        role: user.role,
        leaderboardHidden: Boolean(user.leaderboard_hidden),
        matchmakingRestricted: Boolean(user.matchmaking_restricted),
        email: user.email ?? null,
        emailVerified: Boolean(user.email_verified_at),
        banned: Boolean(user.banned_at),
        createdAt: user.created_at,
      },
      stats: await getPlayerPerformance({
        key: `u:${user.id}`,
        userId: Number(user.id),
        name: user.username,
      }),
    });
  });

export const listUserGames = asyncHandler(async (req, res) => {
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
          'g.variant',
          'g.status',
          'g.guess_count as guessCount',
          'g.question_count as questionCount',
          'g.answer_snapshot',
          'g.finished_at as finishedAt',
          'p.nickname as answer'
        );
      return res.json({
        type,
        page,
        pageSize,
        hasNext: rows.length > pageSize,
        items: rows.slice(0, pageSize).map(({ answer_snapshot, ...row }) => ({
          type: 'single', ...row,
          answer: adminGameAnswerName({ ...row, answer_snapshot }),
        })),
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
        'm.game_mode as gameMode',
        'm.total_rounds as totalRounds',
        'm.relay_solved_rounds as relaySolvedRounds',
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
          gameMode: row.gameMode === 'relay' ? 'relay' : 'classic',
          totalRounds: Number(row.totalRounds),
          relaySolvedRounds: Number(row.relaySolvedRounds),
          finishedAt: row.finishedAt,
          result: row.gameMode === 'relay'
            ? 'cooperative'
            : Boolean(row.meWinner) ? 'won' : Boolean(opponent?.isWinner) ? 'lost' : 'draw',
          me: { score: Number(row.meScore) },
          opponent: opponent
            ? { displayId: matchPlayerDisplayId(opponent), score: Number(opponent.score) }
            : null,
        };
      }),
    });
  });

export const getUserLeaderboards = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const user = await db('users').where({ id }).first('id', 'leaderboard_hidden');
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND');

    const entries = await Promise.all(
      DIFFICULTY_LEVELS.filter((difficulty) => difficulty.isEnabled).flatMap((difficulty) =>
        (['single', 'multi'] as const).map(async (mode) => {
          const rows = mode === 'multi'
            ? await db('match_players as mp')
              .join('users as u', 'u.id', 'mp.user_id')
              .join('match_records as m', 'm.id', 'mp.match_id')
              .where('m.db_type', difficulty.key)
              .where('m.game_mode', 'classic')
              .where((builder) => builder.where('u.leaderboard_hidden', false).orWhere('u.id', id))
              .groupBy('u.id')
              .select('u.id')
              .count({ total: 'mp.id' })
              .sum({ wins: db.raw("case when mp.is_winner then 1 else 0 end") })
            : await db('games as g')
              .join('users as u', 'u.id', 'g.user_id')
              .where('g.mode', difficulty.key)
              .where('g.variant', 'classic')
              .whereNot('g.status', 'playing')
              .where((builder) => builder.where('u.leaderboard_hidden', false).orWhere('u.id', id))
              .groupBy('u.id')
              .select('u.id')
              .count({ total: 'g.id' })
              .sum({ wins: db.raw("case when g.status = 'won' then 1 else 0 end") })
              .avg({ avgGuesses: db.raw("case when g.status = 'won' then g.guess_count else null end") });
          const board = (rows as any[]).map((row) => ({
            id: Number(row.id),
            total: Number(row.total),
            wins: Number(row.wins ?? 0),
            winRate: Number(row.total) ? Number(row.wins ?? 0) / Number(row.total) : 0,
            avgGuesses: mode === 'single' && row.avgGuesses != null ? Number(row.avgGuesses) : null,
          })).sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.total - a.total || a.id - b.id);
          const index = board.findIndex((entry) => entry.id === id);
          const own = index >= 0 ? board[index] : null;
          return {
            mode,
            difficulty: difficulty.key,
            rank: index >= 0 ? index + 1 : null,
            totalRanked: board.length,
            total: own?.total ?? 0,
            wins: own?.wins ?? 0,
            winRate: own?.winRate ?? 0,
            avgGuesses: own?.avgGuesses ?? null,
          };
        })
      )
    );
    res.json({ leaderboardHidden: Boolean(user.leaderboard_hidden), entries });
  });

export const listGuests = asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof userListQuerySchema>;
    const query = db('guest_accounts');
    if (parsed.search) query.whereILike('display_id', `%${parsed.search}%`);
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / parsed.pageSize));
    const page = Math.min(parsed.page, totalPages);
    const guests = await query.clone().orderBy('last_seen_at', 'desc').limit(parsed.pageSize).offset((page - 1) * parsed.pageSize);
    res.json({
      guests: guests.map((guest) => ({ id: Number(guest.id), displayId: guest.display_id, banned: Boolean(guest.banned_at), createdAt: guest.created_at, lastSeenAt: guest.last_seen_at })),
      total, page, pageSize: parsed.pageSize, totalPages,
    });
  });

export const getGuestStats = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const guest = await db('guest_accounts').where({ id }).first();
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    res.json({ guest: { id, displayId: guest.display_id, banned: Boolean(guest.banned_at) }, stats: await getPlayerPerformance({ key: `g:${guest.guest_key}`, userId: null, name: guest.display_id }) });
  });

export const listGuestGames = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const parsed = req.query as unknown as z.infer<typeof userGameListQuerySchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key', 'display_id');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    const offset = (parsed.page - 1) * parsed.pageSize;
    if (parsed.type === 'single') {
      const rows = await db('games as g').join('players as p', 'p.id', 'g.target_player_id')
        .where('g.guest_key', guest.guest_key).whereNot('g.status', 'playing')
        .orderBy('g.finished_at', 'desc').orderBy('g.id', 'desc').offset(offset).limit(parsed.pageSize + 1)
        .select('g.id', 'g.mode', 'g.variant', 'g.status', 'g.guess_count as guessCount', 'g.question_count as questionCount', 'g.answer_snapshot', 'g.finished_at as finishedAt', 'p.nickname as answer');
      return res.json({ type: parsed.type, page: parsed.page, pageSize: parsed.pageSize, hasNext: rows.length > parsed.pageSize, items: rows.slice(0, parsed.pageSize).map(({ answer_snapshot, ...row }) => ({
        type: 'single', ...row,
        answer: adminGameAnswerName({ ...row, answer_snapshot }),
      })) });
    }
    const identityKey = `g:${guest.guest_key}`;
    const rows = await db('match_players as me').join('match_records as m', 'm.id', 'me.match_id')
      .where('me.player_key', identityKey).orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').offset(offset).limit(parsed.pageSize + 1)
      .select(
        'm.id',
        'm.db_type as mode',
        'm.bo_type as boType',
        'm.game_mode as gameMode',
        'm.total_rounds as totalRounds',
        'm.relay_solved_rounds as relaySolvedRounds',
        'm.created_at as finishedAt',
        'me.score as meScore',
        'me.is_winner as meWinner'
      );
    const visibleRows = rows.slice(0, parsed.pageSize);
    const matchIds = visibleRows.map((row) => Number(row.id));
    const opponents = matchIds.length ? await db('match_players as opponent').leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .whereIn('opponent.match_id', matchIds).whereNot('opponent.player_key', identityKey)
      .select('opponent.match_id as matchId', 'opponent.player_key as key', 'opponent.player_name as name', 'opponent.score', 'opponent.is_winner as isWinner', 'opponent_user.username') : [];
    const opponentByMatch = new Map(opponents.map((row) => [Number(row.matchId), row]));
    return res.json({ type: parsed.type, page: parsed.page, pageSize: parsed.pageSize, hasNext: rows.length > parsed.pageSize, items: visibleRows.map((row) => {
      const opponent = opponentByMatch.get(Number(row.id));
      return {
        type: 'multi',
        id: Number(row.id),
        mode: row.mode,
        boType: Number(row.boType),
        gameMode: row.gameMode === 'relay' ? 'relay' : 'classic',
        totalRounds: Number(row.totalRounds),
        relaySolvedRounds: Number(row.relaySolvedRounds),
        finishedAt: row.finishedAt,
        result: row.gameMode === 'relay'
          ? 'cooperative'
          : Boolean(row.meWinner) ? 'won' : Boolean(opponent?.isWinner) ? 'lost' : 'draw',
        me: { score: Number(row.meScore) },
        opponent: opponent
          ? { displayId: matchPlayerDisplayId(opponent), score: Number(opponent.score) }
          : null,
      };
    }) });
  });
