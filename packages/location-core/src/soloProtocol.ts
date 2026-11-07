import type { Difficulty, GameView, Guess, MapDefinition, RoundResult } from './types.js';

/**
 * 图寻 单人 (random) on the shared single-player API `/api/game`.
 *
 * Same envelope as the classic and 海龟汤 games: `gameId`, `mode` (the
 * difficulty) and `variant: 'location'`. The map snapshot of a game is sent only
 * when the client does not report holding it (`mapsHash`), every round result
 * carries map ids instead of two full MapDefinitions, and an accepted guess
 * returns a delta on the version it was made for instead of the whole game.
 * Daily and multiplayer keep their own endpoints and shapes.
 */
export const LOCATION_SOLO_VARIANT = 'location';

/** A round result without its two embedded map definitions. */
export type CompactRoundResult = Omit<RoundResult, 'map' | 'guessedMap'>;

export interface LocationSoloView
  extends Omit<GameView, 'id' | 'mode' | 'difficulty' | 'date' | 'maps' | 'results'> {
  gameId: string;
  mode: Difficulty;
  variant: typeof LOCATION_SOLO_VARIANT;
  /** Stable id of this game's map snapshot. */
  mapsHash: string;
  /** Present only when the client did not report holding `mapsHash`. */
  maps?: MapDefinition[];
  results: CompactRoundResult[];
}

/** One newly accepted guess, applied on top of version `base`. */
export interface LocationSoloDelta {
  gameId: string;
  variant: typeof LOCATION_SOLO_VARIANT;
  base: number;
  version: number;
  status: GameView['status'];
  round: number;
  answered: number;
  question: GameView['question'];
  totalScore: number | null;
  expiresAt: number;
  /** The accepted guess, appended to `guesses`. */
  guess: Guess;
  /** The scored round, appended to `results`. */
  result?: CompactRoundResult;
}

export function isLocationSoloView(value: unknown): value is LocationSoloView {
  return Boolean(value && typeof value === 'object' &&
    (value as { variant?: unknown }).variant === LOCATION_SOLO_VARIANT && !('base' in (value as object)));
}

export function isLocationSoloDelta(value: unknown): value is LocationSoloDelta {
  return Boolean(value && typeof value === 'object' &&
    (value as { variant?: unknown }).variant === LOCATION_SOLO_VARIANT &&
    typeof (value as { base?: unknown }).base === 'number');
}

export function compactRoundResult(result: RoundResult): CompactRoundResult {
  const { map: _map, guessedMap: _guessedMap, ...rest } = result;
  return rest;
}

/** Rebuild a full round result from the map snapshot of its game (lossless). */
export function hydrateRoundResult(result: CompactRoundResult, maps: readonly MapDefinition[]): RoundResult {
  const map = maps.find((item) => item.id === result.answer.mapId);
  if (!map) throw new Error(`LOCATION_MAP_MISSING:${result.answer.mapId}`);
  const guessedMap = result.guess ? maps.find((item) => item.id === result.guess!.mapId) ?? null : null;
  return { ...result, map, guessedMap };
}

export function locationSoloView(view: GameView, mapsHash: string, includeMaps: boolean): LocationSoloView {
  const { id, mode: _mode, difficulty, date: _date, maps, results, ...rest } = view;
  return {
    gameId: id,
    mode: difficulty,
    variant: LOCATION_SOLO_VARIANT,
    ...rest,
    mapsHash,
    ...(includeMaps ? { maps } : {}),
    results: results.map(compactRoundResult),
  };
}

/** Delta of the newest accepted guess in `view`, which was applied on `base`. */
export function locationSoloDelta(view: GameView, base: number): LocationSoloDelta {
  const guess = view.guesses[view.guesses.length - 1];
  if (!guess) throw new Error('LOCATION_DELTA_WITHOUT_GUESS');
  const revealed = view.results.length === view.guesses.length;
  return {
    gameId: view.id,
    variant: LOCATION_SOLO_VARIANT,
    base,
    version: view.version,
    status: view.status,
    round: view.round,
    answered: view.answered,
    question: view.question,
    totalScore: view.totalScore,
    expiresAt: view.expiresAt,
    guess,
    ...(revealed ? { result: compactRoundResult(view.results[view.results.length - 1]) } : {}),
  };
}

/** Rebuild the original GameView from a solo view and the maps the client holds. */
export function hydrateLocationSoloView(view: LocationSoloView, maps: readonly MapDefinition[]): GameView {
  const { gameId, mode, variant: _variant, mapsHash: _hash, maps: _maps, results, ...rest } = view;
  return {
    ...rest,
    id: gameId,
    mode: 'random',
    difficulty: mode,
    date: null,
    maps: maps as MapDefinition[],
    results: results.map((result) => hydrateRoundResult(result, maps)),
  };
}

/**
 * Apply a guess delta. Returns null when it does not follow the held version
 * (another tab or device moved the game on); the caller then re-reads the game.
 */
export function applyLocationSoloDelta(view: GameView, delta: LocationSoloDelta): GameView | null {
  if (view.id !== delta.gameId || view.version !== delta.base) return null;
  let results = view.results;
  if (delta.result) {
    try {
      results = [...view.results, hydrateRoundResult(delta.result, view.maps)];
    } catch {
      return null;
    }
  }
  return {
    ...view,
    version: delta.version,
    status: delta.status,
    round: delta.round,
    answered: delta.answered,
    question: delta.question,
    totalScore: delta.totalScore,
    expiresAt: delta.expiresAt,
    guesses: [...view.guesses, delta.guess],
    results,
  };
}
