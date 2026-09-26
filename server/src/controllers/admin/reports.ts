import { z } from 'zod';
import { db } from '../../db/knex';
import { userNameFromUsername } from '../../middleware/auth';
import { asyncHandler, HttpError } from '../../middleware/common';
import { AnalysisLocale, AnalysisSubject, requestExternalCheatAnalysis } from '../../services/externalCheatAnalysis';
import { reportListQuerySchema, reportParamsSchema, reportUpdateSchema, reportBatchUpdateSchema, reportSelectedUpdateSchema, reportWhitelistSchema, reportWhitelistParamsSchema, analysisRequestSchema, reportQuickDismissSchema } from '../../routes/adminSchemas';
import { matchPlayerDisplayId } from './helpers';

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

export const listReports = asyncHandler(async (req, res) => {
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
  });

export const quickDismissSingleReporterReports = asyncHandler(async (req, res) => {
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
  });

export const updateSelectedReports = asyncHandler(async (req, res) => {
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
  });

export const updateReportsByIdentity = asyncHandler(async (req, res) => {
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
  });

export const whitelistReportedIdentity = asyncHandler(async (req, res) => {
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
  });

export const removeReportWhitelist = asyncHandler(async (req, res) => {
    const { reportedKey } = req.params as unknown as z.infer<typeof reportWhitelistParamsSchema>;
    const removed = await db('report_whitelist').where({ identity_key: reportedKey }).del();
    res.json({ ok: true, reportedKey, removed });
  });

export const getReportedIdentity = asyncHandler(async (req, res) => {
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
        .first('id', 'display_id', 'banned_at', 'created_at', 'last_seen_at');
      if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
      return res.json({
        type: 'guest',
        guest: {
          id: Number(guest.id),
          displayId: guest.display_id,
          banned: Boolean(guest.banned_at),
          createdAt: guest.created_at,
          lastSeenAt: guest.last_seen_at,
        },
      });
    }
    throw new HttpError(404, 'USER_NOT_FOUND');
  });

export const analyzeReport = asyncHandler(async (req, res) => {
    const { reportId } = req.params as unknown as z.infer<typeof reportParamsSchema>;
    const { locale } = req.body as z.infer<typeof analysisRequestSchema>;
    const report = await db('match_reports').where({ id: reportId }).first('reported_key');
    if (!report) throw new HttpError(404, 'REPORT_NOT_FOUND');
    const identityKey = String(report.reported_key);
    let subject: AnalysisSubject;
    if (identityKey.startsWith('u:')) {
      const userId = Number(identityKey.slice(2));
      if (!Number.isInteger(userId) || userId <= 0) throw new HttpError(404, 'USER_NOT_FOUND');
      subject = { type: 'user', userId, identityKey };
    } else if (identityKey.startsWith('g:')) {
      subject = { type: 'guest', guestKey: identityKey.slice(2), identityKey };
    } else {
      throw new HttpError(404, 'USER_NOT_FOUND');
    }
    res.json(await requestExternalCheatAnalysis(subject, locale as AnalysisLocale, 'report'));
  });

export const updateReport = asyncHandler(async (req, res) => {
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
  });
