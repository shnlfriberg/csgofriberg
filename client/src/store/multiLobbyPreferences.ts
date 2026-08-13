const STORAGE_KEY = 'csgofriberg.multi-lobby-preferences';
const BO_OPTIONS = new Set([1, 3, 5, 7]);
export const DEFAULT_MULTI_MAX_GUESSES = 8;
export const MIN_MULTI_MAX_GUESSES = 1;
export const MAX_MULTI_MAX_GUESSES = 15;
export const DEFAULT_MULTI_GUESS_INTERVAL_SECONDS = 1.5;
export const MIN_MULTI_GUESS_INTERVAL_SECONDS = 0;
export const MAX_MULTI_GUESS_INTERVAL_SECONDS = 10;
export const DEFAULT_MULTI_ROUND_DURATION_SECONDS = 120;
export const MIN_MULTI_ROUND_DURATION_SECONDS = 10;
export const MAX_MULTI_ROUND_DURATION_SECONDS = 600;

export interface MultiLobbyPreferences {
  gameMode: 'classic' | 'relay';
  totalRounds: number;
  createDifficulty: string;
  boType: number;
  maxPlayers: number;
  allowSpectators: boolean;
  verifiedEmailOnly: boolean;
  maxGuesses: number;
  guessIntervalSeconds: number;
  roundDurationSeconds: number;
  matchmakingDifficulty: string;
}

export function loadMultiLobbyPreferences(
  availableDifficulties: readonly string[],
  fallbackDifficulty: string
): MultiLobbyPreferences {
  const defaults: MultiLobbyPreferences = {
    gameMode: 'classic',
    totalRounds: 3,
    createDifficulty: fallbackDifficulty,
    boType: 3,
    maxPlayers: 2,
    allowSpectators: false,
    verifiedEmailOnly: false,
    maxGuesses: DEFAULT_MULTI_MAX_GUESSES,
    guessIntervalSeconds: DEFAULT_MULTI_GUESS_INTERVAL_SECONDS,
    roundDurationSeconds: DEFAULT_MULTI_ROUND_DURATION_SECONDS,
    matchmakingDifficulty: fallbackDifficulty,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as Partial<MultiLobbyPreferences>;
    const difficultySet = new Set(availableDifficulties);
    return {
      gameMode: stored.gameMode === 'relay' ? 'relay' : 'classic',
      totalRounds: typeof stored.totalRounds === 'number' && BO_OPTIONS.has(stored.totalRounds)
        ? stored.totalRounds
        : defaults.totalRounds,
      createDifficulty: typeof stored.createDifficulty === 'string'
        && difficultySet.has(stored.createDifficulty)
        ? stored.createDifficulty
        : fallbackDifficulty,
      boType: typeof stored.boType === 'number' && BO_OPTIONS.has(stored.boType)
        ? stored.boType
        : defaults.boType,
      maxPlayers: Number.isInteger(stored.maxPlayers)
        && Number(stored.maxPlayers) >= 2
        && Number(stored.maxPlayers) <= 8
        ? Number(stored.maxPlayers)
        : defaults.maxPlayers,
      allowSpectators: typeof stored.allowSpectators === 'boolean'
        ? stored.allowSpectators
        : defaults.allowSpectators,
      verifiedEmailOnly: typeof stored.verifiedEmailOnly === 'boolean'
        ? stored.verifiedEmailOnly
        : defaults.verifiedEmailOnly,
      maxGuesses: Number.isInteger(stored.maxGuesses)
        && Number(stored.maxGuesses) >= MIN_MULTI_MAX_GUESSES
        && Number(stored.maxGuesses) <= MAX_MULTI_MAX_GUESSES
        ? Number(stored.maxGuesses)
        : defaults.maxGuesses,
      guessIntervalSeconds: typeof stored.guessIntervalSeconds === 'number'
        && Number.isFinite(stored.guessIntervalSeconds)
        && stored.guessIntervalSeconds >= MIN_MULTI_GUESS_INTERVAL_SECONDS
        && stored.guessIntervalSeconds <= MAX_MULTI_GUESS_INTERVAL_SECONDS
        ? stored.guessIntervalSeconds
        : defaults.guessIntervalSeconds,
      roundDurationSeconds: Number.isInteger(stored.roundDurationSeconds)
        && Number(stored.roundDurationSeconds) >= MIN_MULTI_ROUND_DURATION_SECONDS
        && Number(stored.roundDurationSeconds) <= MAX_MULTI_ROUND_DURATION_SECONDS
        ? Number(stored.roundDurationSeconds)
        : defaults.roundDurationSeconds,
      matchmakingDifficulty: typeof stored.matchmakingDifficulty === 'string'
        && difficultySet.has(stored.matchmakingDifficulty)
        ? stored.matchmakingDifficulty
        : fallbackDifficulty,
    };
  } catch {
    return defaults;
  }
}

export function saveMultiLobbyPreferences(preferences: MultiLobbyPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Lobby controls continue working when browser storage is unavailable.
  }
}
