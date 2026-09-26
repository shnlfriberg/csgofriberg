import type { Player } from '../../types';
import type { SingleGameState } from '../singleGameStore';

export interface SingleGameGuessInput {
  playerId: number;
  requestId?: string;
  version?: number;
}

export interface SingleGameVariantHandler {
  initialState?: (target: Player) => Pick<SingleGameState, 'soup'>;
  hydrate?: (game: SingleGameState) => void;
  startView: (game: SingleGameState, reload: () => Promise<SingleGameState>) => object | Promise<object>;
  guess: (game: SingleGameState, input: SingleGameGuessInput) => Promise<object>;
  giveup: (game: SingleGameState, input: unknown) => Promise<object>;
  question?: (game: SingleGameState, input: unknown) => Promise<object>;
  questionOptions?: (game: SingleGameState) => object;
  stateView?: (game: SingleGameState) => Promise<object>;
}
