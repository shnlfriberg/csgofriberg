import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import {
  optionalAuth,
  userNameFromUsername,
} from '../middleware/auth';
import { asyncHandler, HttpError, validateBody } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import {
  abandonGame,
  answerGame,
  ensureDaily,
  readGame,
  startGame,
  submitDaily,
} from './games';
import { dayWindow, DIFFICULTIES } from './rules';
import { maps } from './store';
import { answerSchema, difficultySchema } from './validation';
import { requestOwner } from './identity';
export { requestOwner } from './identity';
import { config } from '../config';

/** 图寻 daily. 单人 (random) runs on /api/game; statistics and replays on /api/stats. */
const dailyStartSchema = z.object({ mode: z.literal('daily'), difficulty: difficultySchema }).strict();

const router = Router();
router.use(optionalAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get(
  '/maps',
  asyncHandler(async (_req, res) => {
    // Public map catalogue: a short private cache plus Express's ETag lets
    // repeated lobby visits revalidate with a 304 instead of a fresh body.
    res.set('Cache-Control', 'private, max-age=60');
    res.json((await maps()).filter((map) => map.enabled));
  })
);
router.post(
  '/games',
  rateLimit({
    name: 'location-start',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
  }),
  // 单人 (random) starts through the shared single-player API (/api/game).
  validateBody(dailyStartSchema),
  asyncHandler(async (req, res) =>
    res.json(await startGame(requestOwner(req), 'daily', req.body.difficulty))
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
