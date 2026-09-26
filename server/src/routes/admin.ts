import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { validateBody, validateParams, validateQuery } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { playerImportSchema, playerSchema, playerUpdateSchema } from '../services/playerMutations';
import {
  playerListQuerySchema, userListQuerySchema, userGameListQuerySchema, idParamsSchema,
  userLeaderboardVisibilitySchema, userMatchmakingRestrictionSchema, banSchema,
  apiTokenCreateSchema, userGameReplayParamsSchema, userMatchReplayParamsSchema,
  reportListQuerySchema, reportParamsSchema, reportIdentityKeySchema, reportUpdateSchema,
  reportBatchUpdateSchema, reportSelectedUpdateSchema, reportWhitelistSchema,
  reportWhitelistParamsSchema, analysisRequestSchema, reportQuickDismissSchema,
  playerChangeListQuerySchema, playerChangeReviewSchema, announcementSchema,
  resourceVersionBroadcastSchema,
} from './adminSchemas';
import {
  listReports, quickDismissSingleReporterReports, updateSelectedReports,
  updateReportsByIdentity, whitelistReportedIdentity, removeReportWhitelist,
  getReportedIdentity, analyzeReport, updateReport,
} from '../controllers/admin/reports';
import {
  listUsers, getUserStats, listUserGames, getUserLeaderboards,
  listGuests, getGuestStats, listGuestGames,
} from '../controllers/admin/accounts';
import { getUserGameReplay, getUserMatchReplay } from '../controllers/admin/replays';
import {
  listPlayers, listPlayerChangeSubmissions, reviewPlayerChanges, exportPlayerList,
  addPlayer, editPlayer, removePlayer, importPlayerList,
} from '../controllers/admin/players';
import {
  analyzeUser, analyzeGuest, setUserLeaderboardVisibility,
  setUserMatchmakingRestriction, setUserBan, setGuestBan,
} from '../controllers/admin/moderation';
import {
  getApiTokens, addApiToken, revokeApiTokenForAdmin,
  addAnnouncement, deleteAnnouncement, broadcastResourceVersion,
} from '../controllers/admin/operations';

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
const adminAnalysisLimit = rateLimit({
  name: 'admin-analysis',
  limit: 20,
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

router.get(
  '/reports',
  adminReadLimit,
  validateQuery(reportListQuerySchema),
  listReports
);

router.post(
  '/reports/quick-dismiss/single-reporter',
  adminWriteLimit,
  validateBody(reportQuickDismissSchema),
  quickDismissSingleReporterReports
);

router.patch(
  '/reports/batch-selected',
  adminWriteLimit,
  validateBody(reportSelectedUpdateSchema),
  updateSelectedReports
);

router.patch(
  '/reports/batch',
  adminWriteLimit,
  validateBody(reportBatchUpdateSchema),
  updateReportsByIdentity
);

router.post(
  '/reports/whitelist',
  adminWriteLimit,
  validateBody(reportWhitelistSchema),
  whitelistReportedIdentity
);

router.delete(
  '/reports/whitelist/:reportedKey',
  adminWriteLimit,
  validateParams(reportWhitelistParamsSchema),
  removeReportWhitelist
);

router.get(
  '/reports/:reportId/reported-identity',
  adminReadLimit,
  validateParams(reportParamsSchema),
  getReportedIdentity
);

router.post(
  '/reports/:reportId/analysis',
  adminAnalysisLimit,
  validateParams(reportParamsSchema),
  validateBody(analysisRequestSchema),
  analyzeReport
);

router.patch(
  '/reports/:reportId',
  adminWriteLimit,
  validateParams(reportParamsSchema),
  validateBody(reportUpdateSchema),
  updateReport
);

router.get(
  '/users',
  adminReadLimit,
  validateQuery(userListQuerySchema),
  listUsers
);

router.get(
  '/users/:id/stats',
  adminReadLimit,
  validateParams(idParamsSchema),
  getUserStats
);

router.get(
  '/users/:id/games',
  adminReadLimit,
  validateParams(idParamsSchema),
  validateQuery(userGameListQuerySchema),
  listUserGames
);

router.get(
  '/users/:userId/games/:gameId/replay',
  adminReadLimit,
  validateParams(userGameReplayParamsSchema),
  getUserGameReplay
);

router.get(
  '/users/:userId/matches/:matchId/replay',
  adminReadLimit,
  validateParams(userMatchReplayParamsSchema),
  getUserMatchReplay
);

router.get(
  '/players',
  adminReadLimit,
  validateQuery(playerListQuerySchema),
  listPlayers
);

router.get(
  '/users/:id/leaderboards',
  adminReadLimit,
  validateParams(idParamsSchema),
  getUserLeaderboards
);

router.post(
  '/users/:id/analysis',
  adminAnalysisLimit,
  validateParams(idParamsSchema),
  validateBody(analysisRequestSchema),
  analyzeUser
);

router.post(
  '/guests/:id/analysis',
  adminAnalysisLimit,
  validateParams(idParamsSchema),
  validateBody(analysisRequestSchema),
  analyzeGuest
);

router.get(
  '/player-change-submissions',
  adminReadLimit,
  validateQuery(playerChangeListQuerySchema),
  listPlayerChangeSubmissions
);

router.post(
  '/player-change-submissions/review',
  adminWriteLimit,
  validateBody(playerChangeReviewSchema),
  reviewPlayerChanges
);

router.get(
  '/players/export',
  adminReadLimit,
  exportPlayerList
);

router.post(
  '/players',
  adminWriteLimit,
  validateBody(playerSchema),
  addPlayer
);

router.put(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(playerUpdateSchema),
  editPlayer
);

router.delete(
  '/players/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  removePlayer
);

router.post(
  '/players/import',
  adminImportLimit,
  validateBody(playerImportSchema),
  importPlayerList
);

router.patch(
  '/users/:id/leaderboard-visibility',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(userLeaderboardVisibilitySchema),
  setUserLeaderboardVisibility
);

router.patch(
  '/users/:id/matchmaking-restriction',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(userMatchmakingRestrictionSchema),
  setUserMatchmakingRestriction
);

router.patch(
  '/users/:id/ban',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(banSchema),
  setUserBan
);

router.get(
  '/guests',
  adminReadLimit,
  validateQuery(userListQuerySchema),
  listGuests
);

router.get(
  '/guests/:id/stats',
  adminReadLimit,
  validateParams(idParamsSchema),
  getGuestStats
);

router.get(
  '/guests/:id/games',
  adminReadLimit,
  validateParams(idParamsSchema),
  validateQuery(userGameListQuerySchema),
  listGuestGames
);

router.patch(
  '/guests/:id/ban',
  adminWriteLimit,
  validateParams(idParamsSchema),
  validateBody(banSchema),
  setGuestBan
);

router.get(
  '/api-tokens',
  adminReadLimit,
  getApiTokens
);

router.post(
  '/api-tokens',
  adminWriteLimit,
  validateBody(apiTokenCreateSchema),
  addApiToken
);

router.delete(
  '/api-tokens/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  revokeApiTokenForAdmin
);

router.post(
  '/announcements',
  adminWriteLimit,
  validateBody(announcementSchema),
  addAnnouncement
);

router.delete(
  '/announcements/:id',
  adminWriteLimit,
  validateParams(idParamsSchema),
  deleteAnnouncement
);

router.post(
  '/resource-version/broadcast',
  adminResourceBroadcastLimit,
  validateBody(resourceVersionBroadcastSchema),
  broadcastResourceVersion
);

export default router;
