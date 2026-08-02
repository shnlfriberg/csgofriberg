import { Router } from 'express';
import type { Server } from 'socket.io';
import { z } from 'zod';
import { db } from '../db/knex';
import {
  guestNameFromKey,
  requireAuth,
  requireAdmin,
  userNameFromUsername,
  invalidateAuthUser,
} from '../middleware/auth';
import {
  validateBody,
  validateParams,
  validateQuery,
  asyncHandler,
  HttpError,
} from '../middleware/common';
import { invalidateCached } from '../services/queryCache';
import { allLeaderboardCacheKeys } from '../services/leaderboardCache';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { publishResourceVersion } from '../services/resourceVersion';
import { getPlayerPerformance } from '../services/playerPerformance';
import { compareGuess, completeGuessFeedback, MAX_GUESSES } from '../services/gameService';
import { getDifficultyPlayers, getEnabledPlayers, getPlayer } from '../services/playerCache';
import type { GuessFeedback, Player } from '../types';
import { DIFFICULTY_LEVELS } from '../difficulties';
import { analyzeGameChoices, AnalysisRoundInput } from '../services/userGameAnalysis';
import {
  createPlayer,
  deletePlayer,
  importPlayers,
  playerImportSchema,
  playerSchema,
  playerUpdateSchema,
  updatePlayer,
} from '../services/playerMutations';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/apiTokens';
import { cacheMatchmakingRestriction } from '../services/matchmakingRestriction';
import { cancelQueue, moveQueuedIdentityToPool } from '../services/roomStore';
import { redis, redisKey } from '../redis';

const router = Router();
router.use(requireAuth, requireAdmin);
const adminReadLimit = rateLimit({
  name: 'admin-read',
  limit: 120,
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
const userLeaderboardVisibilitySchema = z.object({ hidden: z.boolean() });
const userMatchmakingRestrictionSchema = z.object({ restricted: z.boolean() });
const banSchema = z.object({ banned: z.boolean() });
const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
const userGameReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  gameId: z.coerce.number().int().positive(),
});
const userMatchReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  matchId: z.coerce.number().int().positive(),
});
const reportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(['all', 'pending', 'resolved', 'dismissed']).default('all'),
  reporterFilter: z.enum(['all', 'multiple', 'single']).default('all'),
  search: z.string().trim().max(64).default(''),
});
const reportParamsSchema = z.object({ reportId: z.coerce.number().int().positive() });
const reportIdentityKeySchema = z.string().trim().min(3).max(80)
  .refine((key) => key.startsWith('u:') || key.startsWith('g:'));
const reportUpdateSchema = z.object({
  status: z.enum(['pending', 'resolved', 'dismissed']),
  adminNote: z.string().trim().max(500).default(''),
});
const reportBatchUpdateSchema = reportUpdateSchema.extend({
  reportedKey: reportIdentityKeySchema,
});
const reportSelectedUpdateSchema = reportUpdateSchema.extend({
  reportIds: z.array(z.number().int().positive()).min(1).max(100),
});
const reportWhitelistSchema = z.object({
  reportedKey: reportIdentityKeySchema,
  adminNote: z.string().trim().max(500).default(''),
});
const reportWhitelistParamsSchema = z.object({
  reportedKey: reportIdentityKeySchema,
});
const reportQuickDismissSchema = z.object({
  adminNote: z.string().trim().min(1).max(500),
  reportedKeys: z.array(reportIdentityKeySchema).min(1).max(100),
});
const reportLowRiskDismissSchema = z.object({
  adminNote: z.string().trim().min(1).max(500),
  reportedKeys: z.array(reportIdentityKeySchema).min(1).max(10),
});

const REPORT_LOW_RISK_MAX_SIMILARITY = 60;
const REPORT_LOW_RISK_MIN_AVERAGE_GUESSES = 4.5;

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

function replayGuessesWithTimes(target: Player, guessIds: unknown, guessTimes: unknown) {
  const ids = Array.isArray(guessIds) ? guessIds.slice(0, MAX_GUESSES) : [];
  const times = Array.isArray(guessTimes) ? guessTimes : [];
  const guesses: GuessFeedback[] = [];
  const normalizedTimes: Array<number | null> = [];
  let previousGuessAt = 0;
  let previousTimeKnown = true;
  for (const [index, value] of ids.entries()) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    const guess = getPlayer(id);
    if (!guess) continue;
    guesses.push(compareGuess(guess, target));
    const time = times[index];
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      normalizedTimes.push(null);
      previousTimeKnown = false;
      continue;
    }
    const currentGuessAt = Math.floor(time);
    normalizedTimes.push(previousTimeKnown ? Math.max(0, currentGuessAt - previousGuessAt) : null);
    previousGuessAt = currentGuessAt;
    previousTimeKnown = true;
  }
  return { guesses, guessTimes: normalizedTimes };
}

function reportIdentityDisplay(row: { key?: unknown; name?: unknown; username?: unknown }): string {
  return matchPlayerDisplayId(row);
}

function pendingReporterFilterQuery(filter: 'multiple' | 'single') {
  return db('match_reports')
    .where('status', 'pending')
    .select('reported_key')
    .groupBy('reported_key')
    .havingRaw(filter === 'multiple'
      ? 'count(distinct reporter_key) >= 2'
      : 'count(distinct reporter_key) = 1');
}

async function reportReviewSignals(identityKey: string) {
  const multiRows = await db('match_records as m')
    .join('match_players as mp', 'mp.match_id', 'm.id')
    .where('mp.player_key', identityKey)
    .orderBy('m.created_at', 'desc')
    .limit(10)
    .select('m.id', 'm.db_type as mode', 'm.replay', 'm.created_at as finishedAt', 'mp.player_key as playerKey');
  const inputs: AnalysisRoundInput[] = [];
  const relevantPlayerIds = new Set<number>();
  const winningGuessCounts: number[] = [];
  for (const row of multiRows) {
    let rounds: unknown = [];
    try { rounds = JSON.parse(String(row.replay)); } catch { rounds = []; }
    if (!Array.isArray(rounds)) continue;
    for (const value of rounds.slice(0, 30)) {
      if (!value || typeof value !== 'object') continue;
      const stored = value as Record<string, unknown>;
      const guessesByPlayer = stored.guessesByPlayer;
      const rawGuesses = guessesByPlayer && typeof guessesByPlayer === 'object'
        ? (guessesByPlayer as Record<string, unknown>)[String(row.playerKey || identityKey)]
        : [];
      const guessIds = safeGuessIds(rawGuesses);
      if (stored.winnerKey === identityKey && Array.isArray(rawGuesses)) {
        winningGuessCounts.push(rawGuesses.length);
      }
      const targetPlayerId = Number(stored.targetPlayerId);
      if (!Number.isInteger(targetPlayerId) || targetPlayerId <= 0) continue;
      relevantPlayerIds.add(targetPlayerId);
      guessIds.forEach((playerId) => relevantPlayerIds.add(playerId));
      inputs.push({
        source: 'multi',
        recordId: Number(row.id),
        mode: String(row.mode),
        finishedAt: String(row.finishedAt),
        round: Number(stored.round),
        targetPlayerId,
        guessPlayerIds: guessIds,
      });
    }
  }
  inputs.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || b.recordId - a.recordId);
  const allEnabledPlayers = getEnabledPlayers();
  const playersById = new Map(allEnabledPlayers.map((player) => [player.id, player]));
  for (const playerId of relevantPlayerIds) {
    const player = getPlayer(playerId);
    if (player) playersById.set(playerId, player);
  }
  const difficultyPools = new Map(
    DIFFICULTY_LEVELS.map((difficulty) => [difficulty.key, getDifficultyPlayers(difficulty.key)])
  );
  const analysis = await analyzeGameChoices(inputs, playersById, difficultyPools, allEnabledPlayers);
  return {
    similarityIndex: analysis.summary.similarityIndex,
    recentAverageWinningGuesses: winningGuessCounts.length
      ? winningGuessCounts.reduce((sum, count) => sum + count, 0) / winningGuessCounts.length
      : null,
  };
}

router.get(
  '/reports',
  adminReadLimit,
  validateQuery(reportListQuerySchema),
  asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof reportListQuerySchema>;
    const base = db('match_reports as r')
      .join('match_records as m', 'm.id', 'r.match_id')
      .leftJoin('match_players as reporter', function () {
        this.on('reporter.match_id', '=', 'r.match_id').andOn('reporter.player_key', '=', 'r.reporter_key');
      })
      .leftJoin('users as reporter_user', 'reporter_user.id', 'reporter.user_id')
      .leftJoin('match_players as reported', function () {
        this.on('reported.match_id', '=', 'r.match_id').andOn('reported.player_key', '=', 'r.reported_key');
      })
      .leftJoin('users as reported_user', 'reported_user.id', 'reported.user_id')
      .leftJoin('report_whitelist as whitelist', 'whitelist.identity_key', 'r.reported_key');
    if (parsed.status !== 'all') base.where('r.status', parsed.status);
    if (parsed.reporterFilter !== 'all') {
      base.whereIn('r.reported_key', pendingReporterFilterQuery(parsed.reporterFilter));
    }
    if (parsed.search) {
      const pattern = `%${parsed.search}%`;
      base.where((builder) => {
        builder
          .whereILike('reporter.player_name', pattern)
          .orWhereILike('reporter.player_key', pattern)
          .orWhereILike('reporter_user.username', pattern)
          .orWhereILike('reporter_user.display_id', pattern)
          .orWhereILike('reported.player_name', pattern)
          .orWhereILike('reported.player_key', pattern)
          .orWhereILike('reported_user.username', pattern)
          .orWhereILike('reported_user.display_id', pattern);
      });
    }
    const countRow = await base.clone().count({ count: 'r.id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / parsed.pageSize));
    const page = Math.min(parsed.page, totalPages);
    const rows = await base.clone()
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .offset((page - 1) * parsed.pageSize)
      .limit(parsed.pageSize)
      .select(
        'r.id', 'r.match_id as matchId', 'r.reporter_key as reporterKey', 'r.reported_key as reportedKey',
        'r.description', 'r.status', 'r.admin_note as adminNote', 'r.created_at as createdAt',
        'r.handled_at as handledAt', 'm.room_id as roomId', 'm.db_type as mode', 'm.bo_type as boType',
        'm.created_at as matchCreatedAt',
        'reporter.player_name as reporterName', 'reporter_user.username as reporterUsername',
        'reported.player_name as reportedName', 'reported_user.username as reportedUsername',
        'whitelist.identity_key as whitelistKey'
      );
    const reportedKeys = [...new Set(rows.map((row) => String(row.reportedKey)))];
    const pendingCounts = new Map<string, { reports: number; reporters: number }>();
    if (reportedKeys.length) {
      const countRows = await db('match_reports')
        .select('reported_key as reportedKey')
        .whereIn('reported_key', reportedKeys)
        .where('status', 'pending')
        .groupBy('reported_key')
        .count({ reports: 'id' })
        .countDistinct({ reporters: 'reporter_key' });
      for (const row of countRows as Array<{ reportedKey?: unknown; reports?: string | number; reporters?: string | number }>) {
        pendingCounts.set(String(row.reportedKey), {
          reports: Number(row.reports ?? 0),
          reporters: Number(row.reporters ?? 0),
        });
      }
    }
    res.json({
      reports: rows.map((row) => ({
        id: Number(row.id), matchId: Number(row.matchId), roomId: row.roomId, mode: row.mode, boType: Number(row.boType),
        reporterKey: row.reporterKey, reportedKey: row.reportedKey,
        reporter: reportIdentityDisplay({ key: row.reporterKey, name: row.reporterName, username: row.reporterUsername }),
        reported: reportIdentityDisplay({ key: row.reportedKey, name: row.reportedName, username: row.reportedUsername }),
        description: row.description ?? '', status: row.status, adminNote: row.adminNote ?? '',
        createdAt: row.createdAt, handledAt: row.handledAt, matchCreatedAt: row.matchCreatedAt,
        pendingForReported: pendingCounts.get(String(row.reportedKey))?.reports ?? 0,
        pendingReporterCount: pendingCounts.get(String(row.reportedKey))?.reporters ?? 0,
        whitelisted: Boolean(row.whitelistKey),
      })),
      total, page, pageSize: parsed.pageSize, totalPages,
    });
  })
);

router.post(
  '/reports/quick-dismiss/single-reporter',
  adminWriteLimit,
  validateBody(reportQuickDismissSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportQuickDismissSchema>;
    const rows = await pendingReporterFilterQuery('single')
      .whereIn('reported_key', [...new Set(body.reportedKeys)])
      .orderByRaw('min(created_at) asc')
      .limit(body.reportedKeys.length);
    const reportedKeys = rows.map((row) => String(row.reported_key));
    const updated = reportedKeys.length
      ? await db('match_reports')
        .where('status', 'pending')
        .whereIn('reported_key', reportedKeys)
        .update({
          status: 'dismissed',
          admin_note: body.adminNote,
          handled_by_user_id: req.user!.id,
          handled_at: db.fn.now(),
        })
      : 0;
    res.json({
      ok: true,
      targetCount: reportedKeys.length,
      updated,
    });
  })
);

router.post(
  '/reports/quick-dismiss/low-risk',
  adminWriteLimit,
  validateBody(reportLowRiskDismissSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportLowRiskDismissSchema>;
    const rows = await db('match_reports')
      .where('status', 'pending')
      .whereIn('reported_key', [...new Set(body.reportedKeys)])
      .select('reported_key')
      .groupBy('reported_key')
      .orderBy('reported_key');
    const reportedKeys = rows.map((row) => String(row.reported_key));
    let dismissedTargets = 0;
    let updated = 0;
    for (const reportedKey of reportedKeys) {
      const signals = await reportReviewSignals(reportedKey);
      if (
        signals.similarityIndex >= REPORT_LOW_RISK_MAX_SIMILARITY
        || signals.recentAverageWinningGuesses == null
        || signals.recentAverageWinningGuesses <= REPORT_LOW_RISK_MIN_AVERAGE_GUESSES
      ) continue;
      const dismissed = await db('match_reports')
        .where({ reported_key: reportedKey, status: 'pending' })
        .update({
          status: 'dismissed',
          admin_note: body.adminNote,
          handled_by_user_id: req.user!.id,
          handled_at: db.fn.now(),
        });
      if (dismissed) dismissedTargets += 1;
      updated += Number(dismissed);
    }
    res.json({
      ok: true,
      scannedTargets: reportedKeys.length,
      dismissedTargets,
      updated,
    });
  })
);

router.patch(
  '/reports/batch-selected',
  adminWriteLimit,
  validateBody(reportSelectedUpdateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportSelectedUpdateSchema>;
    const updated = await db('match_reports')
      .whereIn('id', [...new Set(body.reportIds)])
      .update({
        status: body.status,
        admin_note: body.adminNote,
        handled_by_user_id: req.user!.id,
        handled_at: body.status === 'pending' ? null : db.fn.now(),
      });
    res.json({ ok: true, updated, status: body.status, adminNote: body.adminNote });
  })
);

router.patch(
  '/reports/batch',
  adminWriteLimit,
  validateBody(reportBatchUpdateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportBatchUpdateSchema>;
    const updated = await db('match_reports')
      .where({ reported_key: body.reportedKey, status: 'pending' })
      .update({
        status: body.status,
        admin_note: body.adminNote,
        handled_by_user_id: req.user!.id,
        handled_at: body.status === 'pending' ? null : db.fn.now(),
      });
    res.json({ ok: true, reportedKey: body.reportedKey, status: body.status, adminNote: body.adminNote, updated });
  })
);

router.post(
  '/reports/whitelist',
  adminWriteLimit,
  validateBody(reportWhitelistSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportWhitelistSchema>;
    const result = await db.transaction(async (trx) => {
      const participant = await trx('match_players as reported')
        .leftJoin('users as reported_user', 'reported_user.id', 'reported.user_id')
        .where('reported.player_key', body.reportedKey)
        .orderBy('reported.id', 'desc')
        .first('reported.player_name as name', 'reported_user.username as username');
      const displayName = reportIdentityDisplay({
        key: body.reportedKey,
        name: participant?.name,
        username: participant?.username,
      });
      await trx('report_whitelist')
        .insert({
          identity_key: body.reportedKey,
          display_name: displayName,
          admin_note: body.adminNote,
          created_by_user_id: req.user!.id,
        })
        .onConflict('identity_key')
        .merge({
          display_name: displayName,
          admin_note: body.adminNote,
          created_by_user_id: req.user!.id,
        });
      const dismissed = await trx('match_reports')
        .where({ reported_key: body.reportedKey, status: 'pending' })
        .update({
          status: 'dismissed',
          admin_note: body.adminNote,
          handled_by_user_id: req.user!.id,
          handled_at: trx.fn.now(),
        });
      return { displayName, dismissed };
    });
    res.json({ ok: true, reportedKey: body.reportedKey, ...result });
  })
);

router.delete(
  '/reports/whitelist/:reportedKey',
  adminWriteLimit,
  validateParams(reportWhitelistParamsSchema),
  asyncHandler(async (req, res) => {
    const { reportedKey } = req.params as unknown as z.infer<typeof reportWhitelistParamsSchema>;
    const removed = await db('report_whitelist').where({ identity_key: reportedKey }).del();
    res.json({ ok: true, reportedKey, removed });
  })
);

router.get(
  '/reports/:reportId/reported-identity',
  adminReadLimit,
  validateParams(reportParamsSchema),
  asyncHandler(async (req, res) => {
    const { reportId } = req.params as unknown as z.infer<typeof reportParamsSchema>;
    const report = await db('match_reports').where({ id: reportId }).first('reported_key');
    if (!report) throw new HttpError(404, 'REPORT_NOT_FOUND');
    const reportedKey = String(report.reported_key);
    if (reportedKey.startsWith('u:')) {
      const id = Number(reportedKey.slice(2));
      if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'USER_NOT_FOUND');
      const user = await db('users')
        .where({ id })
        .first('id', 'username', 'display_id', 'role', 'leaderboard_hidden', 'matchmaking_restricted', 'email', 'email_verified_at', 'banned_at', 'created_at');
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND');
      return res.json({
        type: 'user',
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
      });
    }
    if (reportedKey.startsWith('g:')) {
      const guest = await db('guest_accounts')
        .where({ guest_key: reportedKey.slice(2) })
        .first('id', 'display_id', 'banned_at', 'matchmaking_restricted', 'created_at', 'last_seen_at');
      if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
      return res.json({
        type: 'guest',
        guest: {
          id: Number(guest.id),
          displayId: guest.display_id,
          banned: Boolean(guest.banned_at),
          matchmakingRestricted: Boolean(guest.matchmaking_restricted),
          createdAt: guest.created_at,
          lastSeenAt: guest.last_seen_at,
        },
      });
    }
    throw new HttpError(404, 'USER_NOT_FOUND');
  })
);

router.patch(
  '/reports/:reportId',
  adminWriteLimit,
  validateParams(reportParamsSchema),
  validateBody(reportUpdateSchema),
  asyncHandler(async (req, res) => {
    const { reportId } = req.params as unknown as z.infer<typeof reportParamsSchema>;
    const body = req.body as z.infer<typeof reportUpdateSchema>;
    const updated = await db('match_reports').where({ id: reportId }).update({
      status: body.status,
      admin_note: body.adminNote,
      handled_by_user_id: req.user!.id,
      handled_at: body.status === 'pending' ? null : db.fn.now(),
    });
    if (!updated) throw new HttpError(404, 'REPORT_NOT_FOUND');
    res.json({ ok: true, id: reportId, status: body.status, adminNote: body.adminNote });
  })
);

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
      const storedTimes = round.guessTimesByPlayer && typeof round.guessTimesByPlayer === 'object'
        ? round.guessTimesByPlayer as Record<string, unknown>
        : {};
      const winnerKey = typeof round.winnerKey === 'string' ? round.winnerKey : null;
      return [{
        round: Number(round.round),
        reason: typeof round.reason === 'string' ? round.reason : '',
        winner: winnerKey === match.meKey ? 'me' : winnerKey === opponent.key ? 'opponent' : null,
        answer: replayAnswer(target),
        me: replayGuessesWithTimes(target, guesses[match.meKey], storedTimes[match.meKey]),
        opponent: replayGuessesWithTimes(target, guesses[opponent.key], storedTimes[opponent.key]),
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

router.get(
  '/users/:id/leaderboards',
  adminReadLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
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
              .where((builder) => builder.where('u.leaderboard_hidden', false).orWhere('u.id', id))
              .groupBy('u.id')
              .select('u.id')
              .count({ total: 'mp.id' })
              .sum({ wins: db.raw("case when mp.is_winner then 1 else 0 end") })
            : await db('games as g')
              .join('users as u', 'u.id', 'g.user_id')
              .where('g.mode', difficulty.key)
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
  })
);

router.get(
  '/users/:id/analysis',
  adminReadLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    if (!(await db('users').where({ id }).first('id'))) throw new HttpError(404, 'USER_NOT_FOUND');
    const identityKey = `u:${id}`;
    const multiRows = await db('match_records as m')
      .join('match_players as mp', 'mp.match_id', 'm.id')
      .where('mp.user_id', id)
      .orderBy('m.created_at', 'desc')
      .limit(10)
      .select('m.id', 'm.db_type as mode', 'm.replay', 'm.created_at as finishedAt', 'mp.player_key as playerKey');
    const inputs: AnalysisRoundInput[] = [];
    const relevantPlayerIds = new Set<number>();
    for (const row of multiRows) {
      let rounds: unknown = [];
      try { rounds = JSON.parse(String(row.replay)); } catch { rounds = []; }
      if (!Array.isArray(rounds)) continue;
      for (const value of rounds.slice(0, 30)) {
        if (!value || typeof value !== 'object') continue;
        const stored = value as Record<string, unknown>;
        const guessesByPlayer = stored.guessesByPlayer;
        const guessIds = guessesByPlayer && typeof guessesByPlayer === 'object'
          ? safeGuessIds((guessesByPlayer as Record<string, unknown>)[String(row.playerKey || identityKey)])
          : [];
        const targetPlayerId = Number(stored.targetPlayerId);
        if (!Number.isInteger(targetPlayerId) || targetPlayerId <= 0) continue;
        relevantPlayerIds.add(targetPlayerId);
        guessIds.forEach((playerId) => relevantPlayerIds.add(playerId));
        inputs.push({
          source: 'multi', recordId: Number(row.id), mode: String(row.mode),
          finishedAt: String(row.finishedAt), round: Number(stored.round),
          targetPlayerId, guessPlayerIds: guessIds,
        });
      }
    }
    inputs.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || b.recordId - a.recordId);
    const allEnabledPlayers = getEnabledPlayers();
    const playersById = new Map(allEnabledPlayers.map((player) => [player.id, player]));
    for (const playerId of relevantPlayerIds) {
      const player = getPlayer(playerId);
      if (player) playersById.set(playerId, player);
    }
    const difficultyPools = new Map(
      DIFFICULTY_LEVELS.map((difficulty) => [difficulty.key, getDifficultyPlayers(difficulty.key)])
    );
    const analysis = await analyzeGameChoices(inputs, playersById, difficultyPools, allEnabledPlayers);
    res.json({
      summary: analysis.summary,
      limitations: {
        hasGuessTiming: false,
        usesCurrentPlayerData: true,
        statement: 'RISK_SIGNAL_NOT_PROOF',
      },
    });
  })
);

router.get(
  '/guests/:id/analysis',
  adminReadLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    const identityKey = `g:${guest.guest_key}`;
    const multiRows = await db('match_records as m')
      .join('match_players as mp', 'mp.match_id', 'm.id')
      .where('mp.player_key', identityKey)
      .orderBy('m.created_at', 'desc')
      .limit(10)
      .select('m.id', 'm.db_type as mode', 'm.replay', 'm.created_at as finishedAt', 'mp.player_key as playerKey');
    const inputs: AnalysisRoundInput[] = [];
    const relevantPlayerIds = new Set<number>();
    for (const row of multiRows) {
      let rounds: unknown = [];
      try { rounds = JSON.parse(String(row.replay)); } catch { rounds = []; }
      if (!Array.isArray(rounds)) continue;
      for (const value of rounds.slice(0, 30)) {
        if (!value || typeof value !== 'object') continue;
        const stored = value as Record<string, unknown>;
        const guessesByPlayer = stored.guessesByPlayer;
        const guessIds = guessesByPlayer && typeof guessesByPlayer === 'object'
          ? safeGuessIds((guessesByPlayer as Record<string, unknown>)[String(row.playerKey || identityKey)])
          : [];
        const targetPlayerId = Number(stored.targetPlayerId);
        if (!Number.isInteger(targetPlayerId) || targetPlayerId <= 0) continue;
        relevantPlayerIds.add(targetPlayerId);
        guessIds.forEach((playerId) => relevantPlayerIds.add(playerId));
        inputs.push({
          source: 'multi', recordId: Number(row.id), mode: String(row.mode),
          finishedAt: String(row.finishedAt), round: Number(stored.round), targetPlayerId, guessPlayerIds: guessIds,
        });
      }
    }
    inputs.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || b.recordId - a.recordId);
    const allEnabledPlayers = getEnabledPlayers();
    const playersById = new Map(allEnabledPlayers.map((player) => [player.id, player]));
    for (const playerId of relevantPlayerIds) {
      const player = getPlayer(playerId);
      if (player) playersById.set(playerId, player);
    }
    const difficultyPools = new Map(DIFFICULTY_LEVELS.map((difficulty) => [difficulty.key, getDifficultyPlayers(difficulty.key)]));
    const analysis = await analyzeGameChoices(inputs, playersById, difficultyPools, allEnabledPlayers);
    res.json({
      summary: analysis.summary,
      limitations: { hasGuessTiming: false, usesCurrentPlayerData: true, statement: 'RISK_SIGNAL_NOT_PROOF' },
    });
  })
);

router.get(
  '/players/export',
  adminReadLimit,
  asyncHandler(async (_req, res) => {
    const [players, memberships] = await Promise.all([
      db('players')
        .select(
          'id',
          'nickname',
          'nationality',
          'region',
          'team',
          'age',
          'role',
          'major_championships',
          'major_appearances',
          'is_active',
          'is_enabled'
        )
        .orderBy('nickname'),
      db('player_difficulties')
        .orderBy('difficulty_key')
        .select('player_id', 'difficulty_key'),
    ]);
    const difficultiesByPlayer = new Map<number, string[]>();
    for (const membership of memberships) {
      const playerId = Number(membership.player_id);
      const difficulties = difficultiesByPlayer.get(playerId) ?? [];
      difficulties.push(String(membership.difficulty_key));
      difficultiesByPlayer.set(playerId, difficulties);
    }
    const exportedPlayers = players.map((player) => ({
      nickname: String(player.nickname),
      nationality: String(player.nationality),
      region: String(player.region),
      team: String(player.team),
      age: Number(player.age),
      role: String(player.role),
      major_championships: Number(player.major_championships),
      major_appearances: Number(player.major_appearances),
      difficulties: difficultiesByPlayer.get(Number(player.id)) ?? [],
      is_active: Boolean(player.is_active),
      is_enabled: Boolean(player.is_enabled),
    }));
    res.attachment('players.json').json(exportedPlayers);
  })
);

router.post(
  '/players',
  adminWriteLimit,
  validateBody(playerSchema),
  asyncHandler(async (req, res) => {
    res.json({ id: await createPlayer(req.body) });
  })
);

router.put(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(playerUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await updatePlayer(id, req.body);
    res.json({ ok: true });
  })
);

router.delete(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await deletePlayer(id);
    res.json({ ok: true });
  })
);

/** JSON 批量导入,按昵称 upsert */
router.post(
  '/players/import',
  adminImportLimit,
  validateBody(playerImportSchema),
  asyncHandler(async (req, res) => {
    res.json(await importPlayers(req.body.players));
  })
);

router.patch(
  '/users/:id/leaderboard-visibility',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(userLeaderboardVisibilitySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { hidden } = req.body as z.infer<typeof userLeaderboardVisibilitySchema>;
    const updated = await db('users').where({ id }).update({ leaderboard_hidden: hidden });
    if (!updated) throw new HttpError(404, 'USER_NOT_FOUND');
    await invalidateCached(
      ...allLeaderboardCacheKeys()
    );
    res.json({ id, leaderboardHidden: hidden });
  })
);

router.patch(
  '/users/:id/matchmaking-restriction',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(userMatchmakingRestrictionSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { restricted } = req.body as z.infer<typeof userMatchmakingRestrictionSchema>;
    const updated = await db('users').where({ id }).update({ matchmaking_restricted: restricted });
    if (!updated) throw new HttpError(404, 'USER_NOT_FOUND');
    await Promise.all([
      cacheMatchmakingRestriction(id, restricted),
      moveQueuedIdentityToPool(`u:${id}`, restricted ? 'restricted' : 'verified'),
    ]);
    res.json({ id, matchmakingRestricted: restricted });
  })
);

router.patch(
  '/users/:id/ban',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(banSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { banned } = req.body as z.infer<typeof banSchema>;
    if (banned && id === req.user!.id) throw new HttpError(400, 'CANNOT_BAN_SELF');
    const updated = await db('users').where({ id }).update({
      banned_at: banned ? db.fn.now() : null,
      ...(banned ? { token_version: db.raw('token_version + 1') } : {}),
    });
    if (!updated) throw new HttpError(404, 'USER_NOT_FOUND');
    await Promise.all([invalidateAuthUser(id), cancelQueue(`u:${id}`)]);
    const io = req.app.get('io') as Server | undefined;
    if (banned) io?.in(`identity:u:${id}`).disconnectSockets(true);
    res.json({ id, banned });
  })
);

router.get(
  '/guests',
  adminReadLimit,
  validateQuery(userListQuerySchema),
  asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof userListQuerySchema>;
    const query = db('guest_accounts');
    if (parsed.search) query.whereILike('display_id', `%${parsed.search}%`);
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / parsed.pageSize));
    const page = Math.min(parsed.page, totalPages);
    const guests = await query.clone().orderBy('last_seen_at', 'desc').limit(parsed.pageSize).offset((page - 1) * parsed.pageSize);
    res.json({
      guests: guests.map((guest) => ({ id: Number(guest.id), displayId: guest.display_id, banned: Boolean(guest.banned_at), matchmakingRestricted: Boolean(guest.matchmaking_restricted), createdAt: guest.created_at, lastSeenAt: guest.last_seen_at })),
      total, page, pageSize: parsed.pageSize, totalPages,
    });
  })
);

router.get(
  '/guests/:id/stats',
  adminReadLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const guest = await db('guest_accounts').where({ id }).first();
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    res.json({ guest: { id, displayId: guest.display_id, banned: Boolean(guest.banned_at), matchmakingRestricted: Boolean(guest.matchmaking_restricted) }, stats: await getPlayerPerformance({ key: `g:${guest.guest_key}`, userId: null, name: guest.display_id }) });
  })
);

router.get(
  '/guests/:id/games',
  adminReadLimit,
  validateParams(idParamsSchema),
  validateQuery(userGameListQuerySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const parsed = req.query as unknown as z.infer<typeof userGameListQuerySchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key', 'display_id');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    const offset = (parsed.page - 1) * parsed.pageSize;
    if (parsed.type === 'single') {
      const rows = await db('games as g').join('players as p', 'p.id', 'g.target_player_id')
        .where('g.guest_key', guest.guest_key).whereNot('g.status', 'playing')
        .orderBy('g.finished_at', 'desc').orderBy('g.id', 'desc').offset(offset).limit(parsed.pageSize + 1)
        .select('g.id', 'g.mode', 'g.status', 'g.guess_count as guessCount', 'g.finished_at as finishedAt', 'p.nickname as answer');
      return res.json({ type: parsed.type, page: parsed.page, pageSize: parsed.pageSize, hasNext: rows.length > parsed.pageSize, items: rows.slice(0, parsed.pageSize).map((row) => ({ type: 'single', ...row })) });
    }
    const identityKey = `g:${guest.guest_key}`;
    const rows = await db('match_players as me').join('match_records as m', 'm.id', 'me.match_id')
      .where('me.player_key', identityKey).orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').offset(offset).limit(parsed.pageSize + 1)
      .select('m.id', 'm.db_type as mode', 'm.bo_type as boType', 'm.created_at as finishedAt', 'me.score as meScore', 'me.is_winner as meWinner');
    const visibleRows = rows.slice(0, parsed.pageSize);
    const matchIds = visibleRows.map((row) => Number(row.id));
    const opponents = matchIds.length ? await db('match_players as opponent').leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .whereIn('opponent.match_id', matchIds).whereNot('opponent.player_key', identityKey)
      .select('opponent.match_id as matchId', 'opponent.player_key as key', 'opponent.player_name as name', 'opponent.score', 'opponent.is_winner as isWinner', 'opponent_user.username') : [];
    const opponentByMatch = new Map(opponents.map((row) => [Number(row.matchId), row]));
    return res.json({ type: parsed.type, page: parsed.page, pageSize: parsed.pageSize, hasNext: rows.length > parsed.pageSize, items: visibleRows.map((row) => {
      const opponent = opponentByMatch.get(Number(row.id));
      return { type: 'multi', id: Number(row.id), mode: row.mode, boType: Number(row.boType), finishedAt: row.finishedAt, result: Boolean(row.meWinner) ? 'won' : Boolean(opponent?.isWinner) ? 'lost' : 'draw', me: { score: Number(row.meScore) }, opponent: opponent ? { displayId: matchPlayerDisplayId(opponent), score: Number(opponent.score) } : null };
    }) });
  })
);

router.patch(
  '/guests/:id/ban',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(banSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { banned } = req.body as z.infer<typeof banSchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key', 'guest_key_hash');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    await db('guest_accounts').where({ id }).update({ banned_at: banned ? db.fn.now() : null });
    const client = redis();
    if (client) await client.del(redisKey(`guest-ban:${guest.guest_key_hash}`));
    await cancelQueue(`g:${guest.guest_key}`);
    const io = req.app.get('io') as Server | undefined;
    if (banned) io?.in(`identity:g:${guest.guest_key}`).disconnectSockets(true);
    res.json({ id, banned });
  })
);

router.patch(
  '/guests/:id/matchmaking-restriction',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(userMatchmakingRestrictionSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { restricted } = req.body as z.infer<typeof userMatchmakingRestrictionSchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    await db('guest_accounts').where({ id }).update({ matchmaking_restricted: restricted });
    await moveQueuedIdentityToPool(`g:${guest.guest_key}`, restricted ? 'restricted' : 'verified');
    res.json({ id, matchmakingRestricted: restricted });
  })
);

router.get(
  '/api-tokens',
  adminReadLimit,
  asyncHandler(async (req, res) => {
    res.json({ tokens: await listApiTokens(req.user!.id) });
  })
);

router.post(
  '/api-tokens',
  adminWriteLimit,
  validateBody(apiTokenCreateSchema),
  asyncHandler(async (req, res) => {
    const token = await createApiToken(
      req.user!.id,
      req.body.name,
      req.body.expiresInDays
    );
    res.status(201).json(token);
  })
);

router.delete(
  '/api-tokens/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await revokeApiToken(req.user!.id, id);
    res.json({ ok: true });
  })
);

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(128),
  content: z.string().trim().min(1).max(10000),
  is_popup: z.boolean().default(false),
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
