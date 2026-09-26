import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validateBody, validateParams } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { listRoomGameModes, listSingleGameVariants, singleGameVariantSchema } from '../services/gameModes';
import { exitSingleGame, mutateSingleGame, singleGameQuestionOptions, singleGameState, startSingleGame } from '../services/singleGame';
import type { SingleGameOwner } from '../services/singleGame';
import { soupMutationSchema, soupQuestionSchema } from '../services/turtleSoup';

const router = Router();
router.use(optionalAuth);

const gameIdParams = z.object({ id: z.string().uuid() });
const startBody = z.object({
  mode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('beginner'),
  variant: singleGameVariantSchema.default('classic'),
});
const guessBody = z.object({
  playerId: z.number().int().positive(),
  requestId: z.string().uuid().optional(),
  version: z.number().int().nonnegative().optional(),
});
const giveupBody = soupMutationSchema.partial().optional();

function requireOwner(req: { user?: { id: number }; guestKey?: string }): SingleGameOwner {
  if (req.user) return { identityKey: `u:${req.user.id}`, userId: req.user.id, guestKey: null };
  if (req.guestKey) return { identityKey: `g:${req.guestKey}`, userId: null, guestKey: req.guestKey };
  throw new HttpError(400, 'GUEST_KEY_REQUIRED');
}

router.get('/modes', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: 1, scope: 'multiplayer-room', modes: listRoomGameModes() });
});

router.get('/variants', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: 1, single: listSingleGameVariants(), multiplayerRoom: listRoomGameModes() });
});

router.get('/:id/question-options', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = requireOwner(req);
  const options = await singleGameQuestionOptions(req.params.id, owner.identityKey);
  res.setHeader('Cache-Control', 'no-store');
  res.json(options);
}));

router.get('/:id/state', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = requireOwner(req);
  const state = await singleGameState(req.params.id, owner.identityKey);
  res.setHeader('Cache-Control', 'no-store');
  res.json(state);
}));

router.post('/:id/question',
  rateLimit({ name: 'game-question', limit: 40, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(soupQuestionSchema),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req);
    res.json(await mutateSingleGame(req.params.id, owner.identityKey, 'question', req.body));
  })
);

router.post('/start',
  rateLimit({ name: 'game-start', limit: 10, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateBody(startBody),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req);
    const { mode, variant } = req.body as z.infer<typeof startBody>;
    res.json(await startSingleGame(owner, mode, variant));
  })
);

router.post('/:id/guess',
  rateLimit({ name: 'game-guess', limit: 30, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(guessBody),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req);
    res.json(await mutateSingleGame(req.params.id, owner.identityKey, 'guess', req.body));
  })
);

router.post('/:id/giveup',
  rateLimit({ name: 'game-giveup', limit: 15, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(giveupBody),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req);
    res.json(await mutateSingleGame(req.params.id, owner.identityKey, 'giveup', req.body));
  })
);

router.post('/:id/exit', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = requireOwner(req);
  await exitSingleGame(req.params.id, owner.identityKey);
  res.json({ ok: true });
}));

export default router;
