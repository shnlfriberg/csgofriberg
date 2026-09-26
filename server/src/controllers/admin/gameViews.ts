import { HttpError } from '../../middleware/common';
import { compareGuess, refreshGuessFeedback } from '../../services/gameService';
import { isSingleGameVariant, type SingleGameVariant } from '../../services/gameModes';
import { getPlayer } from '../../services/playerCache';
import { soupReplay } from '../../services/turtleSoup';
import type { GuessFeedback } from '../../types';
import { replayAnswer } from './helpers';

type StoredSingleGame = Parameters<typeof soupReplay>[0] & {
  variant?: string | null;
  target_player_id: number;
  guesses: unknown;
};

type ListedGame = {
  variant?: string | null;
  answer_snapshot?: string | null;
  answer: string | null;
};

function classicReplay(game: StoredSingleGame) {
  const target = getPlayer(Number(game.target_player_id));
  if (!target) throw new HttpError(404, 'PLAYER_NOT_FOUND');

  let storedGuesses: unknown[] = [];
  try {
    const parsed = JSON.parse(String(game.guesses));
    if (Array.isArray(parsed)) storedGuesses = parsed;
  } catch {
    throw new HttpError(500, 'INTERNAL_ERROR');
  }
  const guesses = storedGuesses.flatMap((stored) => {
    if (typeof stored === 'number') {
      const guess = getPlayer(stored);
      return guess ? [compareGuess(guess, target)] : [];
    }
    if (!stored || typeof stored !== 'object' || !('playerId' in stored)) return [];
    const feedback = stored as GuessFeedback;
    return [refreshGuessFeedback(feedback, getPlayer(feedback.playerId), target)];
  });
  return {
    id: Number(game.id),
    mode: game.mode,
    variant: game.variant ?? 'classic',
    status: game.status,
    guessCount: Number(game.guess_count),
    createdAt: game.created_at,
    finishedAt: game.finished_at,
    answer: replayAnswer(target),
    guesses,
  };
}

const gameViews = {
  classic: {
    replay: classicReplay,
    answerName: (game: ListedGame) => game.answer,
  },
  'turtle-soup': {
    replay: soupReplay,
    answerName: (game: ListedGame) => game.answer_snapshot
      ? JSON.parse(game.answer_snapshot).nickname : game.answer,
  },
} satisfies Record<SingleGameVariant, {
  replay: (game: StoredSingleGame) => object;
  answerName: (game: ListedGame) => string | null;
}>;

function gameView(variant: unknown) {
  return gameViews[isSingleGameVariant(variant) ? variant : 'classic'];
}

export function adminSingleGameReplay(game: StoredSingleGame) {
  return gameView(game.variant).replay(game);
}

export function adminGameAnswerName(game: ListedGame) {
  return gameView(game.variant).answerName(game);
}
