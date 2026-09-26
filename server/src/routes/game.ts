import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { optionalAuth } from '../middleware/auth';
import { validateBody, validateParams, asyncHandler, HttpError } from '../middleware/common';
import { GuessFeedback, Player } from '../types';
import { compareGuess, refreshGuessFeedback, MAX_GUESSES } from '../services/gameService';
import { getEnabledPlayer, getEnabledPlayers, getPlayer, isDifficultyAvailable } from '../services/playerCache';
import { redis, redisKey } from '../redis';
import { askSoup, createSoup, guessSoup, soupAnswer, soupMutationSchema, soupQuestionSchema, soupView } from '../services/turtleSoup';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { withKeyLock } from '../services/keyLock';
import { invalidateCached } from '../services/queryCache';
import {
  SingleGameMode,
  SingleGameState,
  createOrResumeSingleGameWithStatus,
  deleteSingleGame,
  loadActiveSingleGame,
  loadSingleGame,
  saveSingleGame,
} from '../services/singleGameStore';
import { shouldPersistSingleSettlement } from '../services/singleSettlementLimit';
import { leaderboardCacheKey } from '../services/leaderboardCache';
import {
  globalStatsCacheKeysForDifficulty,
  personalStatsCacheKeysForDifficulty,
} from '../services/statsCache';
import { pickTargetAvoidingRecent, rememberTargetSelection } from '../services/targetSelection';
import {
  isSingleGameVariant,
  listRoomGameModes,
  listSingleGameVariants,
  singleGameVariantSchema,
  type SingleGameVariant,
} from '../services/gameModes';

const router = Router();
router.use(optionalAuth);
const gameIdParams = z.object({ id: z.string().uuid() });

router.get('/modes', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: 1, scope: 'multiplayer-room', modes: listRoomGameModes() });
});

router.get('/variants', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    version: 1,
    single: listSingleGameVariants(),
    multiplayerRoom: listRoomGameModes(),
  });
});

function identity(req: { user?: { id: number }; guestKey?: string }) {
  if (req.user) {
    return { identityKey: `u:${req.user.id}`, userId: req.user.id, guestKey: null };
  }
  if (req.guestKey) {
    return { identityKey: `g:${req.guestKey}`, userId: null, guestKey: req.guestKey };
  }
  return null;
}

function answerView(target: Player) {
  return {
    id: target.id,
    nickname: target.nickname,
    team: target.team,
    nationality: target.nationality,
    region: target.region,
    role: target.role,
    majorChampionships: target.major_championships,
    majorAppearances: target.major_appearances,
  };
}

function publicGuesses(game: SingleGameState): GuessFeedback[] {
  const target = getPlayer(game.targetPlayerId);
  return game.guesses.map((feedback) => {
    const guess = getPlayer(feedback.playerId);
    return refreshGuessFeedback(feedback, guess, target);
  });
}

async function loadOwnedGame(id: string, identityKey: string): Promise<SingleGameState> {
  let game = await loadSingleGame(id, identityKey);
  if (!game) {
    const completed = await redis()?.get(redisKey(`soup:completed:${id}`));
    if (completed) game = JSON.parse(completed) as SingleGameState;
  }
  if (!game || game.identityKey !== identityKey || (game.kind ?? 'single') !== 'single') {
    throw new HttpError(404, 'GAME_NOT_FOUND');
  }
  if (game.variant !== 'turtle-soup') game.guesses = publicGuesses(game);
  return game;
}

async function settleSoup(game: SingleGameState): Promise<void> {
  const soup = game.soup!;
  if (soup.recorded === undefined) {
    const recorded = await shouldPersistSingleSettlement(game.identityKey, game.id);
    if (recorded) {
      const guesses = soup.events.filter((event) => event.type === 'guess');
      await db('games').insert({
        session_id: game.id, user_id: game.userId, guest_key: game.guestKey,
        target_player_id: game.targetPlayerId, mode: game.mode, variant: 'turtle-soup',
        status: soup.status, question_count: soup.questionCount, guess_count: soup.guessCount,
        guesses: JSON.stringify(guesses.map((event) => event.playerId)),
        guess_times: JSON.stringify(guesses.map((event) => event.elapsedMs)),
        first_guess_player_id: guesses[0]?.playerId ?? null,
        soup_events: JSON.stringify(soup.events), answer_snapshot: JSON.stringify(soupAnswer(soup.target)),
        created_at: new Date(game.createdAt), finished_at: db.fn.now(),
      }).onConflict('session_id').ignore();
    }
    await invalidateCached(
      leaderboardCacheKey('turtle-soup', game.mode),
      ...personalStatsCacheKeysForDifficulty(game.identityKey, game.mode, 'turtle-soup'),
      ...globalStatsCacheKeysForDifficulty(game.mode, 'turtle-soup'),
    );
    soup.recorded = recorded;
  }
  // Retain an owner-checked receipt before removing active state: terminal retries
  // return the original result even when the final HTTP response was lost.
  await redis()!.set(redisKey(`soup:completed:${game.id}`), JSON.stringify(game), { EX: 1800 });
  await deleteSingleGame(game);
}

async function mutateSoup(game: SingleGameState, action: 'question' | 'guess' | 'giveup', body: unknown) {
  if (!game.soup || game.variant !== 'turtle-soup') throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  const parsed = (action === 'question' ? soupQuestionSchema : action === 'guess'
    ? soupMutationSchema.extend({ playerId: z.number().int().positive() }) : soupMutationSchema).safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
  const input = parsed.data;
  const soup = game.soup;
  const fingerprint = JSON.stringify({ action, ...input });
  if (soup.requests[input.requestId]) {
    if (soup.requests[input.requestId] !== fingerprint) throw new HttpError(409, 'SOUP_REQUEST_CONFLICT');
    if (soup.status !== 'playing') await settleSoup(game);
    return soupView(game);
  }
  if (soup.status !== 'playing') throw new HttpError(400, 'GAME_FINISHED');
  if (soup.version !== input.version) throw new HttpError(409, 'SOUP_STALE_STATE');
  const elapsedMs = Math.max(0, Date.now() - game.createdAt);
  if (action === 'question') askSoup(soup, soupQuestionSchema.parse(input), elapsedMs);
  else if (action === 'guess') {
    const { playerId } = soupMutationSchema.extend({ playerId: z.number().int().positive() }).parse(input);
    const player = getEnabledPlayer(playerId);
    if (!player) throw new HttpError(404, 'PLAYER_NOT_FOUND');
    guessSoup(soup, player, input.requestId, elapsedMs);
  } else {
    soup.events.push({ type: 'giveup', requestId: input.requestId, elapsedMs });
    soup.status = 'lost';
  }
  soup.version += 1;
  soup.requests[input.requestId] = fingerprint;
  await saveSingleGame(game);
  if (soup.status !== 'playing') await settleSoup(game);
  return soupView(game);
}

router.get('/:id/question-options', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = identity(req);
  if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
  const game = await loadOwnedGame(req.params.id, owner.identityKey);
  if (!game.soup) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  res.setHeader('Cache-Control', 'no-store');
  res.json(game.soup.options);
}));

router.get('/:id/state', validateParams(gameIdParams), asyncHandler(async (req, res) => {
  const owner = identity(req);
  if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
  const game = await loadOwnedGame(req.params.id, owner.identityKey);
  if (!game.soup) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  if (game.soup.status !== 'playing') await withKeyLock(`single-game:${game.id}`, () => settleSoup(game));
  res.setHeader('Cache-Control', 'no-store');
  res.json(soupView(game));
}));

router.post('/:id/question',
  rateLimit({ name: 'game-question', limit: 40, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(gameIdParams), validateBody(soupQuestionSchema), asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    res.json(await withKeyLock(`single-game:${req.params.id}`, async () =>
      mutateSoup(await loadOwnedGame(req.params.id, owner.identityKey), 'question', req.body)));
  }));

async function settleGame(game: SingleGameState, status: 'won' | 'lost'): Promise<boolean> {
  const shouldPersist = await shouldPersistSingleSettlement(game.identityKey, game.id);
  if (shouldPersist) {
    await db('games')
      .insert({
        session_id: game.id,
        user_id: game.userId,
        guest_key: game.guestKey,
        target_player_id: game.targetPlayerId,
        mode: game.mode,
        variant: game.variant ?? 'classic',
        guesses: JSON.stringify(game.guesses.map((guess) => guess.playerId)),
        guess_times: JSON.stringify(game.guessTimes),
        first_guess_player_id: game.guesses[0]?.playerId ?? null,
        status,
        guess_count: game.guesses.length,
        created_at: new Date(game.createdAt),
        finished_at: db.fn.now(),
      })
      .onConflict('session_id')
      .ignore();
  }
  await deleteSingleGame(game);
  if (!shouldPersist) return false;
  const identityKey = game.userId != null ? `u:${game.userId}` : `g:${game.guestKey}`;
  await invalidateCached(
    leaderboardCacheKey('single', game.mode),
    ...personalStatsCacheKeysForDifficulty(identityKey, game.mode),
    ...globalStatsCacheKeysForDifficulty(game.mode),
    `room-player-performance:${identityKey}`
  );
  return true;
}

router.post(
  '/start',
  rateLimit({
    name: 'game-start',
    limit: 10,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateBody(z.object({
    mode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('beginner'),
    variant: singleGameVariantSchema.default('classic'),
  })),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const mode = req.body.mode as SingleGameMode;
    const variant = req.body.variant as SingleGameVariant;
    if (!isSingleGameVariant(variant)) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
    if (!isDifficultyAvailable(mode)) throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    const started = await withKeyLock(`single-start:${owner.identityKey}:${mode}:${variant}`, async () => {
      const existing = await loadActiveSingleGame(owner.identityKey, mode, variant);
      if (existing) return { game: existing, selectedTargetId: null };
      const target = await pickTargetAvoidingRecent({
        mode,
        identities: [owner.identityKey],
      });
      if (!target) throw new HttpError(500, 'EMPTY_PLAYER_POOL');
      const result = await createOrResumeSingleGameWithStatus({
        ...owner,
        mode,
        variant,
        targetPlayerId: target.id,
        soup: variant === 'turtle-soup' ? createSoup(target, getEnabledPlayers()) : undefined,
      });
      return {
        game: result.game,
        selectedTargetId: result.created ? target.id : null,
      };
    });
    if (started.selectedTargetId !== null) {
      await rememberTargetSelection({
        mode,
        identities: [owner.identityKey],
        playerId: started.selectedTargetId,
      });
    }
    if (started.game.variant === 'turtle-soup') {
      if (started.game.soup?.status !== 'playing') await withKeyLock(`single-game:${started.game.id}`, async () => {
        const current = await loadOwnedGame(started.game.id, owner.identityKey);
        await settleSoup(current);
        started.game = current;
      });
      res.json(soupView(started.game));
      return;
    }
    res.json({
      gameId: started.game.id,
      mode: started.game.mode,
      variant: started.game.variant ?? 'classic',
      maxGuesses: MAX_GUESSES,
      guesses: publicGuesses(started.game),
    });
  })
);

router.post(
  '/:id/guess',
  rateLimit({
    name: 'game-guess',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(gameIdParams),
  validateBody(z.object({ playerId: z.number().int().positive(), requestId: z.string().uuid().optional(), version: z.number().int().nonnegative().optional() })),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const gameId = req.params.id;
    const response = await withKeyLock(`single-game:${gameId}`, async () => {
      const game = await loadOwnedGame(gameId, owner.identityKey);
      if (game.variant === 'turtle-soup') return mutateSoup(game, 'guess', req.body);
      const guess = getEnabledPlayer(req.body.playerId);
      if (!guess) throw new HttpError(404, 'PLAYER_NOT_FOUND');
      const target = getPlayer(game.targetPlayerId);
      if (!target) throw new HttpError(500, 'INTERNAL_ERROR');
      if (game.guesses.some((item) => item.playerId === guess.id)) {
        throw new HttpError(400, 'ALREADY_GUESSED');
      }

      const feedback = compareGuess(guess, target);
      game.guesses.push(feedback);
      game.guessTimes.push(Math.max(0, Math.floor(Date.now() - game.createdAt)));
      const finished = feedback.correct || game.guesses.length >= MAX_GUESSES;
      const status = feedback.correct ? 'won' : finished ? 'lost' : 'playing';
      const recorded = finished
        ? await settleGame(game, feedback.correct ? 'won' : 'lost')
        : undefined;
      if (!finished) await saveSingleGame(game);

      return {
        feedback,
        status,
        guessCount: game.guesses.length,
        maxGuesses: MAX_GUESSES,
        answer: finished ? answerView(target) : undefined,
        recorded,
      };
    });
    res.json(response);
  })
);

router.post(
  '/:id/giveup',
  rateLimit({
    name: 'game-giveup',
    limit: 15,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(gameIdParams),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const gameId = req.params.id;
    const response = await withKeyLock(`single-game:${gameId}`, async () => {
      const game = await loadOwnedGame(gameId, owner.identityKey);
      if (game.variant === 'turtle-soup') return mutateSoup(game, 'giveup', req.body);
      const target = getPlayer(game.targetPlayerId);
      if (!target) throw new HttpError(500, 'INTERNAL_ERROR');
      const recorded = await settleGame(game, 'lost');
      return { status: 'lost', answer: answerView(target), recorded };
    });
    res.json(response);
  })
);

router.post(
  '/:id/exit',
  validateParams(gameIdParams),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const gameId = req.params.id;
    await withKeyLock(`single-game:${gameId}`, async () => {
      const game = await loadSingleGame(gameId, owner.identityKey);
      if (game && (game.kind ?? 'single') === 'single') await deleteSingleGame(game);
    });
    res.json({ ok: true });
  })
);

export default router;
