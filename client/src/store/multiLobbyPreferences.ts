const STORAGE_KEY = 'csgofriberg.multi-lobby-preferences';
const BO_OPTIONS = new Set([1, 3, 5, 7]);

export interface MultiLobbyPreferences {
  createDifficulty: string;
  boType: number;
  allowSpectators: boolean;
  matchmakingDifficulty: string;
}

export function loadMultiLobbyPreferences(
  availableDifficulties: readonly string[],
  fallbackDifficulty: string
): MultiLobbyPreferences {
  const defaults: MultiLobbyPreferences = {
    createDifficulty: fallbackDifficulty,
    boType: 3,
    allowSpectators: false,
    matchmakingDifficulty: fallbackDifficulty,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as Partial<MultiLobbyPreferences>;
    const difficultySet = new Set(availableDifficulties);
    return {
      createDifficulty: typeof stored.createDifficulty === 'string'
        && difficultySet.has(stored.createDifficulty)
        ? stored.createDifficulty
        : fallbackDifficulty,
      boType: typeof stored.boType === 'number' && BO_OPTIONS.has(stored.boType)
        ? stored.boType
        : defaults.boType,
      allowSpectators: typeof stored.allowSpectators === 'boolean'
        ? stored.allowSpectators
        : defaults.allowSpectators,
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
