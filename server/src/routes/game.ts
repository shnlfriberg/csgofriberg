import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { optionalAuth } from '../middleware/auth';
import { validateBody, validateParams, asyncHandler, HttpError } from '../middleware/common';
import { GuessFeedback, Player } from '../types';
import { compareGuess, completeGuessFeedback, MAX_GUESSES } from '../services/gameService';
import { getEnabledPlayer, getPlayer, isDifficultyAvailable } from '../services/playerCache';
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

const router = Router();
router.use(optionalAuth);
const gameIdParams = z.object({ id: z.string().uuid() });

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
    return completeGuessFeedback(feedback, guess, target);
  });
}

async function loadOwnedGame(id: string, identityKey: string): Promise<SingleGameState> {
  const game = await loadSingleGame(id, identityKey);
  if (!game) throw new HttpError(404, 'GAME_NOT_FOUND');
  game.guesses = publicGuesses(game);
  return game;
}

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
  })),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const mode = req.body.mode as SingleGameMode;
    if (!isDifficultyAvailable(mode)) throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    const started = await withKeyLock(`single-start:${owner.identityKey}:${mode}`, async () => {
      const existing = await loadActiveSingleGame(owner.identityKey, mode);
      if (existing) return { game: existing, selectedTargetId: null };
      const target = await pickTargetAvoidingRecent({
        mode,
        identities: [owner.identityKey],
      });
      if (!target) throw new HttpError(500, 'EMPTY_PLAYER_POOL');
      const result = await createOrResumeSingleGameWithStatus({
        ...owner,
        mode,
        targetPlayerId: target.id,
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
    res.json({
      gameId: started.game.id,
      mode: started.game.mode,
      maxGuesses: MAX_GUESSES,
      guesses: publicGuesses(started.game),
    });
  })
);

router.post(
  '/:id/guess',
  rateLimit({
    name: 'game-guess',
    limit: 20,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(gameIdParams),
  validateBody(z.object({ playerId: z.number().int().positive() })),
  asyncHandler(async (req, res) => {
    const owner = identity(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const gameId = req.params.id;
    const response = await withKeyLock(`single-game:${gameId}`, async () => {
      const game = await loadOwnedGame(gameId, owner.identityKey);
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
      if (game) await deleteSingleGame(game);
    });
    res.json({ ok: true });
  })
);

export default router;
