import { Router } from 'express';
import { config } from '../config';
import { isRedisAvailable } from '../redis';
import { getRuntimeSnapshot } from '../services/runtimeMonitor';
import buildInfo from '../generated/buildInfo.json';

const router = Router();
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    version: buildInfo,
    redis: isRedisAvailable() ? 'up' : 'degraded',
    features: { leaderboard: config.showLeaderboard },
    runtime: getRuntimeSnapshot(),
  });
});
export default router;
