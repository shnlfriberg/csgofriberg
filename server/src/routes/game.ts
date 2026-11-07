import { Router, type Request } from 'express';
import { z } from 'zod';
import { optionalAuth, userNameFromUsername } from '../middleware/auth';
import { asyncHandler, HttpError, validateBody, validateParams } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import {
  isSingleGameVariant,
  listRoomGameModes,
  listSingleGameVariants,
  listSoloGameVariants,
  soloGameVariantSchema,
} from '../services/gameModes';
import {
  exitSingleGame,
  mutateSingleGame,
  ownsSingleGame,
  singleGameQuestionOptions,
  singleGameState,
  startSingleGame,
} from '../services/singleGame';
import type { SingleGameOwner } from '../services/singleGame';
import type { SoloContext, SoloVariantAdapter } from '../services/soloGames';
import { soupMutationSchema, soupQuestionSchema } from '../services/turtleSoup';
import { locationSoloAdapter } from '../location/soloGame';
import { cardSoloAdapter } from '../card-link/soloGame';

/**
 * Single-player games: classic, 海龟汤, 图寻 单人 and 卡牌连接 单人.
 *
 * Every variant follows the classic contract: `POST /start` with `{ mode,
 * variant, ...options }` creates or resumes the identity's game for that mode
 * and variant (any device or tab), then `/:id/...` acts on it. Responses share
 * the `gameId` / `mode` / `variant` envelope; accepted writes answer with only
 * what changed (classic feedback, 海龟汤 event, 图寻 round, 卡牌 seat patch) and
 * start/state return the full game.
 */
const router = Router();
router.use(optionalAuth);

const soloAdapters: Partial<Record<string, SoloVariantAdapter>> = {
  location: locationSoloAdapter,
  'card-link': cardSoloAdapter,
};

const gameIdParams = z.object({ id: z.string().uuid() });
const startBody = z.object({
  mode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('beginner'),
  variant: soloGameVariantSchema.default('classic'),
  // Variant options, validated by the variant (图寻 bans, 卡牌 hand and time).
  bannedMapIds: z.unknown().optional(),
  hand: z.unknown().optional(),
  duration: z.unknown().optional(),
});
const guessBody = z.object({
  playerId: z.number().int().positive(),
  requestId: z.string().uuid().optional(),
  version: z.number().int().nonnegative().optional(),
});
const giveupBody = soupMutationSchema.partial().optional();
const anyBody = z.record(z.string(), z.unknown()).optional();

function requireOwner(req: { user?: { id: number }; guestKey?: string }): SingleGameOwner {
  if (req.user) return { identityKey: `u:${req.user.id}`, userId: req.user.id, guestKey: null };
  if (req.guestKey) return { identityKey: `g:${req.guestKey}`, userId: null, guestKey: req.guestKey };
  throw new HttpError(400, 'GUEST_KEY_REQUIRED');
}

function soloContext(req: Request): SoloContext {
  const owner = requireOwner(req);
  return {
    owner: {
      key: owner.identityKey,
      userId: owner.userId,
      guestKey: owner.guestKey,
      name: req.user ? userNameFromUsername(req.user.username) : req.guestName || 'Guest',
    },
    header: (name) => req.get(name),
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
  return parsed.data;
}

// Which entertainment variant holds a game, remembered per identity and id once
// ownership was verified, so frequent moves skip the lookups. Another identity
// (or instance) probes again and gets the same GAME_NOT_FOUND as before.
const knownVariants = new Map<string, string>();
function rememberVariant(ownerKey: string, id: string, variant: string) {
  const key = `${ownerKey}|${id}`;
  knownVariants.delete(key);
  knownVariants.set(key, variant);
  if (knownVariants.size > 20_000) knownVariants.delete(knownVariants.keys().next().value!);
}

/** The entertainment adapter owning `id`, or null for the shared single-game store. */
async function adapterFor(id: string, ctx: SoloContext): Promise<SoloVariantAdapter | null> {
  const known = knownVariants.get(`${ctx.owner.key}|${id}`);
  if (known) return soloAdapters[known] ?? null;
  if (await ownsSingleGame(id, ctx.owner.key)) return null;
  for (const [variant, adapter] of Object.entries(soloAdapters)) {
    if (adapter && await adapter.owns(id, ctx.owner)) {
      rememberVariant(ctx.owner.key, id, variant);
      return adapter;
    }
  }
  // Unknown here: the single-game path answers GAME_NOT_FOUND as before.
  return null;
}

function unavailable(): never {
  throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
}

router.get('/modes', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: 1, scope: 'multiplayer-room', modes: listRoomGameModes() });
});

router.get('/variants', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: 1, single: listSingleGameVariants(), solo: listSoloGameVariants(), multiplayerRoom: listRoomGameModes() });
});

router.get('/:id/question-options', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = requireOwner(req);
  const options = await singleGameQuestionOptions(req.params.id, owner.identityKey);
  res.setHeader('Cache-Control', 'no-store');
  res.json(options);
}));

router.get('/:id/state', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const ctx = soloContext(req);
  const adapter = await adapterFor(req.params.id, ctx);
  const state = adapter
    ? await adapter.state(ctx, req.params.id)
    : await singleGameState(req.params.id, ctx.owner.key);
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
    const ctx = soloContext(req);
    const { mode, variant, ...options } = req.body as z.infer<typeof startBody>;
    if (isSingleGameVariant(variant)) {
      res.json(await startSingleGame(requireOwner(req), mode, variant));
      return;
    }
    const adapter = soloAdapters[variant] ?? unavailable();
    const started = await adapter.start(ctx, mode, options);
    const id = (started as { gameId?: unknown }).gameId;
    if (typeof id === 'string') rememberVariant(ctx.owner.key, id, variant);
    res.json(started);
  })
);

router.post('/:id/guess',
  rateLimit({ name: 'game-guess', limit: 30, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(anyBody),
  asyncHandler(async (req, res) => {
    const ctx = soloContext(req);
    const adapter = await adapterFor(req.params.id, ctx);
    if (adapter) {
      res.json(await (adapter.guess ?? unavailable)(ctx, req.params.id, req.body));
      return;
    }
    const body = parse(guessBody, req.body);
    res.json(await mutateSingleGame(req.params.id, ctx.owner.key, 'guess', body));
  })
);

// Variant-specific moves (卡牌: play, remove, reorder, swap, refresh, lock).
router.post('/:id/command',
  rateLimit({ name: 'game-command', limit: 120, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(anyBody),
  asyncHandler(async (req, res) => {
    const ctx = soloContext(req);
    const adapter = await adapterFor(req.params.id, ctx);
    if (!adapter?.command) unavailable();
    res.json(await adapter.command(ctx, req.params.id, req.body));
  })
);

router.post('/:id/giveup',
  rateLimit({ name: 'game-giveup', limit: 15, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams),
  validateBody(anyBody),
  asyncHandler(async (req, res) => {
    const ctx = soloContext(req);
    const adapter = await adapterFor(req.params.id, ctx);
    if (adapter) {
      res.json(await (adapter.giveup ?? unavailable)(ctx, req.params.id, req.body));
      return;
    }
    const body = parse(giveupBody, req.body);
    res.json(await mutateSingleGame(req.params.id, ctx.owner.key, 'giveup', body));
  })
);

router.post('/:id/exit', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const ctx = soloContext(req);
  const adapter = await adapterFor(req.params.id, ctx);
  if (adapter) await adapter.exit(ctx, req.params.id);
  else await exitSingleGame(req.params.id, ctx.owner.key);
  res.json({ ok: true });
}));

export default router;
