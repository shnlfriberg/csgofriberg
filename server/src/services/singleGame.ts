import { HttpError } from '../middleware/common';
import { redis, redisKey } from '../redis';
import { type SingleGameVariant } from './gameModes';
import { withKeyLock } from './keyLock';
import { isDifficultyAvailable } from './playerCache';
import {
  createOrResumeSingleGameWithStatus,
  deleteSingleGame,
  loadActiveSingleGame,
  loadSingleGame,
  type SingleGameMode,
  type SingleGameState,
} from './singleGameStore';
import { getSingleGameHandler, type SingleGameGuessInput } from './singleGameVariants';
import { pickTargetAvoidingRecent, rememberTargetSelection } from './targetSelection';

export interface SingleGameOwner {
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
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
  getSingleGameHandler(game.variant ?? 'classic').hydrate?.(game);
  return game;
}

export async function startSingleGame(owner: SingleGameOwner, mode: SingleGameMode, variant: SingleGameVariant) {
  const handler = getSingleGameHandler(variant);
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
      ...handler.initialState?.(target),
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
  return handler.startView(started.game, () => loadOwnedGame(started.game.id, owner.identityKey));
}

export async function singleGameQuestionOptions(id: string, identityKey: string) {
  const game = await loadOwnedGame(id, identityKey);
  const options = getSingleGameHandler(game.variant ?? 'classic').questionOptions;
  if (!options) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  return options(game);
}

export async function singleGameState(id: string, identityKey: string) {
  const game = await loadOwnedGame(id, identityKey);
  const stateView = getSingleGameHandler(game.variant ?? 'classic').stateView;
  if (!stateView) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
  return stateView(game);
}

export async function mutateSingleGame(
  id: string,
  identityKey: string,
  action: 'guess' | 'giveup' | 'question',
  input: unknown,
) {
  return withKeyLock(`single-game:${id}`, async () => {
    const game = await loadOwnedGame(id, identityKey);
    const handler = getSingleGameHandler(game.variant ?? 'classic');
    if (action === 'guess') return handler.guess(game, input as SingleGameGuessInput);
    if (action === 'giveup') return handler.giveup(game, input);
    if (!handler.question) throw new HttpError(400, 'GAME_VARIANT_UNAVAILABLE');
    return handler.question(game, input);
  });
}

export async function exitSingleGame(id: string, identityKey: string): Promise<void> {
  await withKeyLock(`single-game:${id}`, async () => {
    const game = await loadSingleGame(id, identityKey);
    if (game && (game.kind ?? 'single') === 'single') await deleteSingleGame(game);
  });
}
