import { Router } from 'express';
import { z } from 'zod';
import { requireApiToken } from '../middleware/apiToken';
import { asyncHandler, validateBody, validateParams } from '../middleware/common';
import { rateLimit } from '../middleware/rateLimit';
import {
  createPlayer,
  importPlayers,
  playerImportSchema,
  playerSchema,
  playerUpdateSchema,
  updatePlayer,
} from '../services/playerMutations';
import {
  createPlayerChangeSubmission,
  playerChangeSubmissionSchema,
} from '../services/playerChangeSubmissions';

const router = Router();
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const externalPreAuthLimit = rateLimit({
  name: 'external-players-pre-auth',
  limit: 120,
  windowSeconds: 60,
  failClosed: true,
});
const externalWriteLimit = rateLimit({
  name: 'external-players-write',
  limit: 60,
  windowSeconds: 60,
  key: (req) => `token:${req.apiToken!.id}`,
  failClosed: true,
});

export const externalPlayerAuth = Router();
externalPlayerAuth.use(externalPreAuthLimit, requireApiToken);

router.use(externalWriteLimit);

router.post(
  '/player-change-submissions',
  validateBody(playerChangeSubmissionSchema),
  asyncHandler(async (req, res) => {
    const result = await createPlayerChangeSubmission(req.body, req.apiToken!);
    res.status(result.submissionId === null ? 200 : 201).json(result);
  })
);

router.post(
  '/players',
  validateBody(playerSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ id: await createPlayer(req.body) });
  })
);

router.put(
  '/players/:id',
  validateParams(idParamsSchema),
  validateBody(playerUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await updatePlayer(id, req.body);
    res.json({ ok: true });
  })
);

router.post(
  '/players/import',
  validateBody(playerImportSchema),
  asyncHandler(async (req, res) => {
    res.json(await importPlayers(req.body.players));
  })
);

export default router;
