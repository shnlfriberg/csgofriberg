import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import type { GuessFeedback, Player } from '../../types';
import { compareGuess, MAX_GUESSES, refreshGuessFeedback } from '../gameService';
import { leaderboardCacheKey } from '../leaderboardCache';
import { getEnabledPlayer, getPlayer } from '../playerCache';
import { invalidateCached } from '../queryCache';
import { deleteSingleGame, saveSingleGame, type SingleGameState } from '../singleGameStore';
import { shouldPersistSingleSettlement } from '../singleSettlementLimit';
import { globalStatsCacheKeysForDifficulty, personalStatsCacheKeysForDifficulty } from '../statsCache';
import type { SingleGameVariantHandler } from './types';

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

export const classicSingleGameHandler: SingleGameVariantHandler = {
  hydrate(game) {
    game.guesses = publicGuesses(game);
  },
  startView(game) {
    return {
      gameId: game.id,
      mode: game.mode,
      variant: game.variant ?? 'classic',
      maxGuesses: MAX_GUESSES,
      guesses: publicGuesses(game),
    };
  },
  async guess(game, input) {
    const guess = getEnabledPlayer(input.playerId);
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
  },
  async giveup(game) {
    const target = getPlayer(game.targetPlayerId);
    if (!target) throw new HttpError(500, 'INTERNAL_ERROR');
    const recorded = await settleGame(game, 'lost');
    return { status: 'lost', answer: answerView(target), recorded };
  },
};
