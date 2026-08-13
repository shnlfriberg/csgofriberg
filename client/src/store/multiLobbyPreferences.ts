const STORAGE_KEY = 'csgofriberg.multi-lobby-preferences';
const PRESETS_STORAGE_KEY = 'csgofriberg.multi-lobby-presets';
const BO_OPTIONS = new Set([1, 3, 5, 7]);
export const DEFAULT_MULTI_MAX_GUESSES = 8;
export const MIN_MULTI_MAX_GUESSES = 2;
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

export interface MultiLobbyPreset {
  name: string;
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
}

function isValidPreset(value: unknown, availableDifficulties: readonly string[]): value is MultiLobbyPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<MultiLobbyPreset>;
  return typeof preset.name === 'string' && preset.name.trim().length > 0
    && preset.name.length <= 40
    && (preset.gameMode === 'classic' || preset.gameMode === 'relay')
    && typeof preset.totalRounds === 'number' && BO_OPTIONS.has(preset.totalRounds)
    && typeof preset.createDifficulty === 'string' && availableDifficulties.includes(preset.createDifficulty)
    && typeof preset.boType === 'number' && BO_OPTIONS.has(preset.boType)
    && Number.isInteger(preset.maxPlayers) && Number(preset.maxPlayers) >= 2 && Number(preset.maxPlayers) <= 8
    && typeof preset.allowSpectators === 'boolean'
    && typeof preset.verifiedEmailOnly === 'boolean'
    && Number.isInteger(preset.maxGuesses) && Number(preset.maxGuesses) >= MIN_MULTI_MAX_GUESSES && Number(preset.maxGuesses) <= MAX_MULTI_MAX_GUESSES
    && typeof preset.guessIntervalSeconds === 'number' && Number.isFinite(preset.guessIntervalSeconds)
    && preset.guessIntervalSeconds >= MIN_MULTI_GUESS_INTERVAL_SECONDS && preset.guessIntervalSeconds <= MAX_MULTI_GUESS_INTERVAL_SECONDS
    && Number.isInteger(preset.roundDurationSeconds)
    && Number(preset.roundDurationSeconds) >= MIN_MULTI_ROUND_DURATION_SECONDS && Number(preset.roundDurationSeconds) <= MAX_MULTI_ROUND_DURATION_SECONDS;
}

export function loadMultiLobbyPresets(
  availableDifficulties: readonly string[],
  _fallbackDifficulty: string,
): MultiLobbyPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => isValidPreset(item, availableDifficulties))
      .map((item) => ({ ...item, name: item.name.trim() }));
  } catch {
    return [];
  }
}

export function saveMultiLobbyPresets(presets: readonly MultiLobbyPreset[]): void {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Presets are optional; the lobby remains usable when storage is unavailable.
  }
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
