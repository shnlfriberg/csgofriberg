import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { optionalAuth, userNameFromUsername } from '../middleware/auth';
import { asyncHandler, HttpError, validateBody, validateParams } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import type { GuessFeedback, Player } from '../types';
import { compareGuess, MAX_GUESSES, refreshGuessFeedback } from '../services/gameService';
import { getEnabledPlayer, getPlayer } from '../services/playerCache';
import { withKeyLock } from '../services/keyLock';
import {
  createOrResumeSingleGameWithStatus,
  deleteSingleGame,
  loadActiveSingleGame,
  loadSingleGame,
  saveSingleGame,
  type SingleGameState,
} from '../services/singleGameStore';
import {
  dailyChallengeWindow,
  dailyChallengeMode,
  dailyLeaderboardCacheKey,
  ensureDailyChallenges,
  getDailyLeaderboard,
  isDailyChallengeDifficulty,
  parseDailyChallengeMode,
  type DailyChallengeRecord,
} from '../services/dailyChallenge';
import { invalidateCached } from '../services/queryCache';

const router = Router();
router.use(optionalAuth);

const difficultySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const startSchema = z.object({ difficulty: difficultySchema });
const difficultyParams = z.object({ difficulty: difficultySchema });
const gameIdParams = z.object({ id: z.string().uuid() });
const guessSchema = z.object({ playerId: z.number().int().positive() });

interface Owner {
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  displayName: string;
}

interface AttemptRow {
  id: number;
  challengeId: number;
  status: 'won' | 'lost';
  guessCount: number;
  solveOrder: number | null;
  guesses: unknown;
}

interface RecordedAttempt {
  attemptId: number;
  solveOrder: number | null;
}

function ownerFor(req: {
  user?: { id: number; username: string };
  guestKey?: string;
  guestName?: string;
}): Owner | null {
  if (req.user) {
    return {
      identityKey: `u:${req.user.id}`,
      userId: req.user.id,
      guestKey: null,
      displayName: userNameFromUsername(req.user.username),
    };
  }
  if (req.guestKey) {
    return {
      identityKey: `g:${req.guestKey}`,
      userId: null,
      guestKey: req.guestKey,
      displayName: req.guestName || '访客#未知',
    };
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
  return game.guesses.map((feedback) =>
    refreshGuessFeedback(feedback, getPlayer(feedback.playerId), target)
  );
}

function storedGuessIds(value: unknown): number[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, MAX_GUESSES)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

function storedGuesses(challenge: DailyChallengeRecord, value: unknown): GuessFeedback[] {
  const target = getPlayer(challenge.targetPlayerId);
  if (!target) return [];
  return storedGuessIds(value).flatMap((playerId) => {
    const guess = getPlayer(playerId);
    return guess ? [compareGuess(guess, target)] : [];
  });
}

async function loadOwnedDailyGame(id: string, owner: Owner): Promise<{
  game: SingleGameState;
  challenge: DailyChallengeRecord;
}> {
  const game = await loadSingleGame(id, owner.identityKey);
  if (!game || game.kind !== 'daily') throw new HttpError(404, 'GAME_NOT_FOUND');
  const parsedMode = parseDailyChallengeMode(game.mode);
  if (!parsedMode) throw new HttpError(404, 'GAME_NOT_FOUND');
  const window = dailyChallengeWindow();
  if (parsedMode.date !== window.date) {
    await deleteSingleGame(game);
    throw new HttpError(410, 'DAILY_CHALLENGE_EXPIRED');
  }
  if (!game.dailyChallengeId) throw new HttpError(409, 'DAILY_CHALLENGE_EXPIRED');
  game.guesses = publicGuesses(game);
  return {
    game,
    challenge: {
      id: game.dailyChallengeId,
      challengeDate: parsedMode.date,
      difficulty: parsedMode.difficulty,
      targetPlayerId: game.targetPlayerId,
    },
  };
}

async function recordAttempt(
  game: SingleGameState,
  challenge: DailyChallengeRecord,
  status: 'won' | 'lost',
  owner: Owner
): Promise<RecordedAttempt> {
  const recorded = await db.transaction(async (trx) => {
    const inserted = await trx('daily_challenge_attempts')
      .insert({
        challenge_id: challenge.id,
        identity_key: owner.identityKey,
        user_id: owner.userId,
        guest_key: owner.guestKey,
        display_name: owner.displayName,
        status,
        guess_count: game.guesses.length,
        guesses: JSON.stringify(game.guesses.map((guess) => guess.playerId)),
        guess_times: JSON.stringify(game.guessTimes),
        created_at: new Date(game.createdAt),
        finished_at: trx.fn.now(),
      })
      .onConflict(['challenge_id', 'identity_key'])
      .ignore()
      .returning('id');
    const insertedId = inserted[0];
    if (insertedId == null) {
      const existing = await trx('daily_challenge_attempts')
        .where({ challenge_id: challenge.id, identity_key: owner.identityKey })
        .first('id', 'solve_order as solveOrder');
      if (!existing) throw new Error('DAILY_CHALLENGE_ATTEMPT_NOT_FOUND');
      return {
        attemptId: Number(existing.id),
        solveOrder: existing.solveOrder == null ? null : Number(existing.solveOrder),
      };
    }

    const attemptId = Number(typeof insertedId === 'object' ? insertedId.id : insertedId);
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      throw new Error('DAILY_CHALLENGE_ATTEMPT_NOT_FOUND');
    }
    if (status !== 'won') return { attemptId, solveOrder: null };

    const incremented = await trx('daily_challenges')
      .where({ id: challenge.id })
      .increment('solved_count', 1)
      .returning('solved_count');
    const incrementedValue = incremented[0];
    const solveOrder = Number(
      typeof incrementedValue === 'object'
        ? incrementedValue.solved_count
        : incrementedValue
    );
    if (!Number.isInteger(solveOrder) || solveOrder <= 0) {
      throw new Error('DAILY_CHALLENGE_NOT_FOUND');
    }
    await trx('daily_challenge_attempts')
      .where({ id: attemptId })
      .update({ solve_order: solveOrder });
    return { attemptId, solveOrder };
  });

  await deleteSingleGame(game);
  await invalidateCached(dailyLeaderboardCacheKey(challenge.challengeDate, challenge.difficulty));
  return recorded;
}

router.get(
  '/overview',
  rateLimit({
    name: 'daily-challenge-overview',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const { window, challenges } = await ensureDailyChallenges();
    const challengeIds = challenges.map((challenge) => challenge.id);
    const attemptRows = await db('daily_challenge_attempts')
      .where('identity_key', owner.identityKey)
      .whereIn('challenge_id', challengeIds)
      .select('challenge_id as challengeId', 'status');
    const attempts = new Map<number, 'won' | 'lost'>(attemptRows.map((row): [number, 'won' | 'lost'] => [
      Number(row.challengeId),
      row.status === 'won' ? 'won' : 'lost',
    ]));
    const activeGames = await Promise.all(challenges.map(async (challenge) => {
      if (attempts.has(challenge.id)) return null;
      const game = await loadActiveSingleGame(
        owner.identityKey,
        dailyChallengeMode(window.date, challenge.difficulty)
      );
      return game?.kind === 'daily' && game.targetPlayerId === challenge.targetPlayerId
        ? game
        : null;
    }));

    res.json({
      date: window.date,
      timeZone: 'Asia/Shanghai',
      serverNow: Date.now(),
      startsAt: window.startsAt,
      nextRefreshAt: window.nextRefreshAt,
      challenges: challenges.map((challenge, index) => {
        return {
          difficulty: challenge.difficulty,
          status: attempts.get(challenge.id) ?? (activeGames[index] ? 'playing' : 'not_started'),
        };
      }),
    });
  })
);

router.get(
  '/:difficulty/leaderboard',
  rateLimit({
    name: 'daily-challenge-leaderboard',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(difficultyParams),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const difficulty = req.params.difficulty;
    if (!isDailyChallengeDifficulty(difficulty)) {
      throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    }
    const { challenges } = await ensureDailyChallenges();
    const challenge = challenges.find((item) => item.difficulty === difficulty);
    if (!challenge) throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    const attempt = await db('daily_challenge_attempts')
      .where({ challenge_id: challenge.id, identity_key: owner.identityKey })
      .first('id');
    if (!attempt) throw new HttpError(409, 'DAILY_CHALLENGE_INCOMPLETE');

    const board = await getDailyLeaderboard(challenge);
    res.json({
      difficulty,
      leaderboard: board.map((entry, rank) => ({
        rank: rank + 1,
        displayId: entry.displayId,
        guessCount: entry.guessCount,
        isCurrent: entry.attemptId === Number(attempt.id),
      })),
    });
  })
);

router.get(
  '/:difficulty',
  rateLimit({
    name: 'daily-challenge-detail',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(difficultyParams),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const difficulty = req.params.difficulty;
    if (!isDailyChallengeDifficulty(difficulty)) {
      throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    }
    const { window, challenges } = await ensureDailyChallenges();
    const challenge = challenges.find((item) => item.difficulty === difficulty);
    if (!challenge) throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    const row = await db('daily_challenge_attempts')
      .where({ challenge_id: challenge.id, identity_key: owner.identityKey })
      .first(
        'id',
        'challenge_id as challengeId',
        'status',
        'guess_count as guessCount',
        'solve_order as solveOrder',
        'guesses'
      );
    const attempt: AttemptRow | null = row ? {
      id: Number(row.id),
      challengeId: Number(row.challengeId),
      status: row.status === 'won' ? 'won' : 'lost',
      guessCount: Number(row.guessCount),
      solveOrder: row.solveOrder == null ? null : Number(row.solveOrder),
      guesses: row.guesses,
    } : null;
    const active = attempt ? null : await loadActiveSingleGame(
      owner.identityKey,
      dailyChallengeMode(window.date, challenge.difficulty)
    );
    const validActive = active?.kind === 'daily' && active.targetPlayerId === challenge.targetPlayerId
      ? active
      : null;
    const target = attempt ? getPlayer(challenge.targetPlayerId) : null;

    res.json({
      date: window.date,
      timeZone: 'Asia/Shanghai',
      serverNow: Date.now(),
      startsAt: window.startsAt,
      nextRefreshAt: window.nextRefreshAt,
      challenge: {
        difficulty: challenge.difficulty,
        status: attempt?.status ?? (validActive ? 'playing' : 'not_started'),
        gameId: validActive?.id ?? null,
        maxGuesses: MAX_GUESSES,
        guessCount: attempt?.guessCount ?? validActive?.guesses.length ?? 0,
        solveOrder: attempt?.solveOrder ?? null,
        guesses: attempt
          ? storedGuesses(challenge, attempt.guesses)
          : validActive
            ? publicGuesses(validActive)
            : [],
        answer: attempt && target ? answerView(target) : null,
      },
    });
  })
);

router.post(
  '/start',
  rateLimit({
    name: 'daily-challenge-start',
    limit: 10,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateBody(startSchema),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const difficulty = req.body.difficulty;
    if (!isDailyChallengeDifficulty(difficulty)) {
      throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');
    }
    const { window, challenges } = await ensureDailyChallenges();
    const challenge = challenges.find((item) => item.difficulty === difficulty);
    if (!challenge) throw new HttpError(400, 'DIFFICULTY_UNAVAILABLE');

    const game = await withKeyLock(
      `daily-challenge-start:${owner.identityKey}:${window.date}:${difficulty}`,
      async () => {
        const completed = await db('daily_challenge_attempts')
          .where({ challenge_id: challenge.id, identity_key: owner.identityKey })
          .first('id');
        if (completed) throw new HttpError(409, 'DAILY_CHALLENGE_COMPLETED');
        const result = await createOrResumeSingleGameWithStatus({
          ...owner,
          mode: dailyChallengeMode(window.date, difficulty),
          targetPlayerId: challenge.targetPlayerId,
          kind: 'daily',
          expiresAt: window.nextRefreshAt,
          dailyChallengeId: challenge.id,
        });
        return result.game;
      }
    );

    res.json({
      gameId: game.id,
      difficulty,
      status: 'playing',
      maxGuesses: MAX_GUESSES,
      guesses: publicGuesses(game),
    });
  })
);

router.post(
  '/:id/guess',
  rateLimit({
    name: 'daily-challenge-guess',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(gameIdParams),
  validateBody(guessSchema),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const response = await withKeyLock(`single-game:${req.params.id}`, async () => {
      const { game, challenge } = await loadOwnedDailyGame(req.params.id, owner);
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
      let recorded: RecordedAttempt | null = null;
      if (finished) {
        recorded = await recordAttempt(game, challenge, status as 'won' | 'lost', owner);
      } else {
        await saveSingleGame(game);
      }
      return {
        feedback,
        status,
        guessCount: game.guesses.length,
        maxGuesses: MAX_GUESSES,
        answer: finished ? answerView(target) : undefined,
        solveOrder: recorded?.solveOrder ?? null,
      };
    });
    res.json(response);
  })
);

router.post(
  '/:id/giveup',
  rateLimit({
    name: 'daily-challenge-giveup',
    limit: 10,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  validateParams(gameIdParams),
  asyncHandler(async (req, res) => {
    const owner = ownerFor(req);
    if (!owner) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const response = await withKeyLock(`single-game:${req.params.id}`, async () => {
      const { game, challenge } = await loadOwnedDailyGame(req.params.id, owner);
      const target = getPlayer(game.targetPlayerId);
      if (!target) throw new HttpError(500, 'INTERNAL_ERROR');
      await recordAttempt(game, challenge, 'lost', owner);
      return {
        status: 'lost',
        guessCount: game.guesses.length,
        maxGuesses: MAX_GUESSES,
        answer: answerView(target),
        solveOrder: null,
      };
    });
    res.json(response);
  })
);

export default router;
