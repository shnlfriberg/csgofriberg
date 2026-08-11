const STORAGE_KEY = 'csgofriberg.daily-difficulty';

export function getStoredDailyDifficulty(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function setStoredDailyDifficulty(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in strict privacy modes.
  }
}
