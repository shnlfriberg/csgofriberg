import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { asyncHandler, HttpError } from '../middleware/common';
import { cached } from '../services/queryCache';
import { rateLimit } from '../middleware/rateLimit';
import { config } from '../config';
import { optionalAuth, userNameFromUsername } from '../middleware/auth';
import { isDifficultyAvailable } from '../services/playerCache';

const router = Router();
router.use(optionalAuth);
const leaderboardQuery = z.object({
  type: z.string().trim().regex(/^(multi|[a-z0-9][a-z0-9_-]{0,31})$/).default('easy'),
});

/** 排行榜: 简单单人、完整单人和多人分别按胜场排序。 */
router.get(
  '/',
  rateLimit({ name: 'leaderboard', limit: 20, windowSeconds: 60, failClosed: true }),
  asyncHandler(async (req, res) => {
    if (!config.showLeaderboard) throw new HttpError(404, 'FEATURE_DISABLED');
    const parsed = leaderboardQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
    const type = parsed.data.type;
    if (type !== 'multi' && !isDifficultyAvailable(type)) {
      throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    }
    const board = await cached(`leaderboard:${type}`, 30, async () => {
      const rows = type === 'multi'
        ? await db('match_players as mp')
          .join('users as u', 'u.id', 'mp.user_id')
          .join('match_records as m', 'm.id', 'mp.match_id')
          .groupBy('u.id', 'u.username')
          .select('u.id', 'u.username')
          .count({ total: 'mp.id' })
          .sum({ wins: db.raw("case when mp.is_winner then 1 else 0 end") })
        : await db('games as g')
          .join('users as u', 'u.id', 'g.user_id')
          .where('g.mode', type)
          .whereNot('g.status', 'playing')
          .groupBy('u.id', 'u.username')
          .select('u.id', 'u.username')
          .count({ total: 'g.id' })
          .sum({ wins: db.raw("case when g.status = 'won' then 1 else 0 end") })
          .avg({
            avgGuesses: db.raw("case when g.status = 'won' then g.guess_count else null end"),
          });

      return (rows as any[])
        .map((row) => ({
          id: Number(row.id),
          displayId: userNameFromUsername(row.username),
          total: Number(row.total),
          wins: Number(row.wins ?? 0),
          winRate: Number(row.total) ? Number(row.wins ?? 0) / Number(row.total) : 0,
          avgGuesses: type === 'multi' || row.avgGuesses == null ? null : Number(row.avgGuesses),
        }))
        .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.total - a.total || a.id - b.id);
    });

    const currentIndex = req.user
      ? board.findIndex((row) => row.id === req.user!.id)
      : -1;
    res.json({
      type,
      items: board.slice(0, 50),
      currentUser: req.user
        ? {
            displayId: userNameFromUsername(req.user.username),
            rank: currentIndex >= 0 ? currentIndex + 1 : null,
          }
        : null,
    });
  })
);

export default router;
