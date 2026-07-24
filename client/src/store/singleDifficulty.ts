const STORAGE_KEY = 'csgofriberg.single-difficulty';

export function getStoredSingleDifficulty(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function setStoredSingleDifficulty(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in strict privacy modes.
  }
}
