import { Router } from 'express';
import { db } from '../db/knex';
import { asyncHandler } from '../middleware/common';
import { rateLimit } from '../middleware/rateLimit';
import { cached } from '../services/queryCache';

const router = Router();

router.get(
  '/',
  rateLimit({ name: 'special-thanks', limit: 60, windowSeconds: 60, failClosed: true }),
  asyncHandler(async (_req, res) => {
    const items = await cached('special-thanks', 300, () =>
      db('special_thanks')
        .select('id', 'name', 'note')
        .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'id', order: 'asc' }])
        .limit(10)
    );
    res.json({ items });
  })
);

export default router;
