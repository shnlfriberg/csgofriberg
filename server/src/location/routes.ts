import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import {
  optionalAuth,
  userNameFromUsername,
} from '../middleware/auth';
import { asyncHandler, HttpError, validateBody, validateQuery } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import {
  abandonGame,
  answerGame,
  ensureDaily,
  readGame,
  replay,
  startGame,
  submitDaily,
} from './games';
import { dayWindow, DIFFICULTIES } from './rules';
import { maps } from './store';
import { answerSchema, difficultySchema, startGameSchema } from './validation';
import { requestOwner } from './identity';
export { requestOwner } from './identity';
import { config } from '../config';
import { locationStatistics, locationStatsQuery, locationReplays, locationReplaysQuery } from './statistics';

const router = Router();
router.use(optionalAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get(
  '/maps',
  asyncHandler(async (_req, res) =>
    res.json((await maps()).filter((map) => map.enabled))
  )
);
router.post(
  '/games',
  rateLimit({
    name: 'location-start',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
  }),
  validateBody(startGameSchema),
  asyncHandler(async (req, res) =>
    res.json(
      await startGame(requestOwner(req), req.body.mode, req.body.difficulty, req.body.bannedMapIds)
    )
  )
);
router.get(
  '/games/:id',
  asyncHandler(async (req, res) =>
    res.json(await readGame(req.params.id, requestOwner(req)))
  )
);
router.post(
  '/games/:id/answers',
  validateBody(answerSchema),
  asyncHandler(async (req, res) =>
    res.json(await answerGame(req.params.id, requestOwner(req), req.body))
  )
);
router.post(
  '/games/:id/abandon',
  asyncHandler(async (req, res) => {
    await abandonGame(req.params.id, requestOwner(req));
    res.json({ ok: true });
  })
);
router.post(
  '/games/:id/submit',
  asyncHandler(async (req, res) =>
    res.json(await submitDaily(req.params.id, requestOwner(req)))
  )
);
router.get(
  '/games/:id/replay',
  asyncHandler(async (req, res) =>
    res.json(await replay(req.params.id, requestOwner(req)))
  )
);
router.get(
  '/daily',
  asyncHandler(async (req, res) => {
    const owner = requestOwner(req);
    const window = dayWindow();
    const attempts = await db('location_daily_attempts')
      .where({ identity_key: owner.key, date: window.date })
      .select();
    const progress = await db('location_progress')
      .where({ identity_key: owner.key, date: window.date })
      .select();
    let available = true;
    try {
      await ensureDaily();
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === 'LOCATION_POOL_INSUFFICIENT'
      )
        available = false;
      else throw error;
    }
    res.json({
      ...window,
      serverNow: Date.now(),
      timeZone: 'Asia/Shanghai',
      available,
      difficulties: DIFFICULTIES.map((difficulty) => ({
        difficulty,
        status: attempts.some((row) => row.difficulty === difficulty)
          ? 'submitted'
          : progress.some(
                (row) =>
                  row.difficulty === difficulty &&
                  JSON.parse(row.payload).status !== 'abandoned'
              )
            ? 'playing'
            : 'not_started',
      })),
    });
  })
);
router.get(
  '/stats',
  rateLimit({ name: 'location-stats', limit: 30, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateQuery(locationStatsQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof locationStatsQuery>;
    res.json(await locationStatistics(requestOwner(req).key, query.difficulties));
  })
);
router.get(
  '/replays',
  rateLimit({ name: 'location-replays', limit: 60, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateQuery(locationReplaysQuery),
  asyncHandler(async (req, res) => res.json(await locationReplays(
    requestOwner(req).key, req.query as unknown as z.infer<typeof locationReplaysQuery>
  )))
);
router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const owner = requestOwner(req);
    const difficulty = difficultySchema
      .catch('normal')
      .parse(req.query.difficulty);
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const rows = await db('location_results')
      .where({ identity_key: owner.key })
      .orderBy('finished_at', 'desc')
      .limit(15)
      .offset((page - 1) * 15);
    const stats = await db('location_results')
      .where({ identity_key: owner.key, mode: 'random', difficulty })
      .select('score', 'payload');
    const results = stats.flatMap((row) => JSON.parse(row.payload).results);
    res.json({
      items: rows.map((row) => {
        const payload = JSON.parse(row.payload);
        return {
          gameId: row.game_id,
          mode: row.mode,
          difficulty: row.difficulty,
          date: row.date,
          totalScore: Number(row.score),
          finishedAt: Number(row.finished_at),
          rank: payload.rank ?? null,
          retired: payload.retired ?? false,
        };
      }),
      page,
      stats: {
        difficulty,
        games: stats.length,
        best: Math.max(0, ...stats.map((row) => Number(row.score))),
        average: stats.length
          ? Math.round(
              stats.reduce((sum, row) => sum + Number(row.score), 0) /
                stats.length
            )
          : 0,
        mapAccuracy: results.length
          ? results.filter((r: any) => r.mapCorrect).length / results.length
          : 0,
      },
    });
  })
);
router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    if (!config.showLeaderboard)
      throw new HttpError(403, 'LEADERBOARD_DISABLED');
    const difficulty = difficultySchema
      .catch('normal')
      .parse(req.query.difficulty);
    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .catch(dayWindow().date)
      .parse(req.query.date);
    if (
      date === dayWindow().date &&
      !(await db('location_daily_attempts')
        .where({ identity_key: requestOwner(req).key, date, difficulty })
        .first())
    )
      throw new HttpError(409, 'LOCATION_INCOMPLETE');
    const rows = await db('location_results as r')
      .join('users as u', 'u.id', 'r.user_id')
      .where({
        'r.mode': 'daily',
        'r.date': date,
        'r.difficulty': difficulty,
        'u.leaderboard_hidden': false,
      })
      .whereNull('u.banned_at')
      .orderBy('r.score', 'desc')
      .orderBy('r.finished_at', 'asc')
      .orderBy('u.id', 'asc')
      .limit(100)
      .select('r.score', 'u.username', 'u.id');
    res.json({
      date,
      difficulty,
      items: rows.map((row) => ({
        name: userNameFromUsername(row.username),
        score: Number(row.score),
        rank: rows.findIndex((r) => Number(r.score) === Number(row.score)) + 1,
        me: req.user?.id === Number(row.id),
      })),
    });
  })
);
export default router;
export { adminLocationRoutes } from './admin/routes';
