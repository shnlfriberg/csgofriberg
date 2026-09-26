import type { Server } from 'socket.io';
import { z } from 'zod';
import { db } from '../../db/knex';
import { invalidateAuthUser } from '../../middleware/auth';
import { asyncHandler, HttpError } from '../../middleware/common';
import { invalidateCached } from '../../services/queryCache';
import { allLeaderboardCacheKeys } from '../../services/leaderboardCache';
import { currentDailyLeaderboardCacheKeys } from '../../services/dailyChallenge';
import { AnalysisLocale, requestExternalCheatAnalysis } from '../../services/externalCheatAnalysis';
import { cacheMatchmakingRestriction } from '../../services/matchmakingRestriction';
import { cancelQueue, moveQueuedIdentityToPool } from '../../services/roomStore';
import { redis, redisKey } from '../../redis';
import { idParamsSchema, userLeaderboardVisibilitySchema, userMatchmakingRestrictionSchema, banSchema, analysisRequestSchema } from '../../routes/adminSchemas';

export const analyzeUser = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    if (!(await db('users').where({ id }).first('id'))) throw new HttpError(404, 'USER_NOT_FOUND');
    const identityKey = `u:${id}`;
    const { locale } = req.body as z.infer<typeof analysisRequestSchema>;
    res.json(await requestExternalCheatAnalysis(
      { type: 'user', userId: id, identityKey },
      locale as AnalysisLocale,
      'user-detail'
    ));
  });

export const analyzeGuest = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const guest = await db('guest_accounts').where({ id }).first('guest_key');
    if (!guest) throw new HttpError(404, 'USER_NOT_FOUND');
    const identityKey = `g:${guest.guest_key}`;
    const { locale } = req.body as z.infer<typeof analysisRequestSchema>;
    res.json(await requestExternalCheatAnalysis(
      { type: 'guest', guestKey: String(guest.guest_key), identityKey },
      locale as AnalysisLocale,
      'guest-detail'
    ));
  });

export const setUserLeaderboardVisibility = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { hidden } = req.body as z.infer<typeof userLeaderboardVisibilitySchema>;
    const updated = await db('users').where({ id }).update({ leaderboard_hidden: hidden });
    if (!updated) throw new HttpError(404, 'USER_NOT_FOUND');
    await invalidateCached(
      ...allLeaderboardCacheKeys(),
      ...currentDailyLeaderboardCacheKeys()
    );
    res.json({ id, leaderboardHidden: hidden });
  });

export const setUserMatchmakingRestriction = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const { restricted } = req.body as z.infer<typeof userMatchmakingRestrictionSchema>;
    const updated = await db('users').where({ id }).update({ matchmaking_restricted: restricted });
    if (!updated) throw new HttpError(404, 'USER_NOT_FOUND');
    await Promise.all([
      cacheMatchmakingRestriction(id, restricted),
      moveQueuedIdentityToPool(`u:${id}`, restricted ? 'restricted' : 'verified'),
    ]);
    res.json({ id, matchmakingRestricted: restricted });
  });

export const setUserBan = asyncHandler(async (req, res) => {
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
  });

export const setGuestBan = asyncHandler(async (req, res) => {
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
  });
