import { z } from 'zod';
import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import { redis, redisKey } from '../../redis';
import { withKeyLock } from '../keyLock';
import { leaderboardCacheKey } from '../leaderboardCache';
import { getEnabledPlayer, getEnabledPlayers } from '../playerCache';
import { invalidateCached } from '../queryCache';
import { deleteSingleGame, saveSingleGame, type SingleGameState } from '../singleGameStore';
import { shouldPersistSingleSettlement } from '../singleSettlementLimit';
import { globalStatsCacheKeysForDifficulty, personalStatsCacheKeysForDifficulty } from '../statsCache';
import { askSoup, createSoup, guessSoup, soupAnswer, soupMutationSchema, soupQuestionSchema, soupView } from '../turtleSoup';
import type { SingleGameVariantHandler } from './types';

const soupGuessSchema = soupMutationSchema.extend({ playerId: z.number().int().positive() });

function requireSoup(game: SingleGameState) {
  if (!game.soup || game.variant !== 'turtle-soup') throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  return game.soup;
}

async function settleSoup(game: SingleGameState): Promise<void> {
  const soup = requireSoup(game);
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
  const soup = requireSoup(game);
  const schema = action === 'question' ? soupQuestionSchema : action === 'guess' ? soupGuessSchema : soupMutationSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
  const input = parsed.data;
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
    const { playerId } = soupGuessSchema.parse(input);
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

export const turtleSoupSingleGameHandler: SingleGameVariantHandler = {
  initialState(target) {
    return { soup: createSoup(target, getEnabledPlayers()) };
  },
  async startView(started, reload) {
    let game = started;
    if (requireSoup(game).status !== 'playing') await withKeyLock(`single-game:${game.id}`, async () => {
      const current = await reload();
      await settleSoup(current);
      game = current;
    });
    return soupView(game);
  },
  guess(game, input) {
    return mutateSoup(game, 'guess', input);
  },
  giveup(game, input) {
    return mutateSoup(game, 'giveup', input);
  },
  question(game, input) {
    return mutateSoup(game, 'question', input);
  },
  questionOptions(game) {
    return requireSoup(game).options;
  },
  async stateView(game) {
    if (requireSoup(game).status !== 'playing') await withKeyLock(`single-game:${game.id}`, () => settleSoup(game));
    return soupView(game);
  },
};
