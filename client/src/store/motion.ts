const STORAGE_KEY = 'ui-motion';
const listeners = new Set<() => void>();

function storedMotionEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

let motionEnabled = storedMotionEnabled();

function renderMotionPreference(enabled: boolean): void {
  if (enabled) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = 'reduced';
}

export function initializeMotionPreference(): void {
  motionEnabled = storedMotionEnabled();
  renderMotionPreference(motionEnabled);
}

export function getMotionEnabled(): boolean {
  return motionEnabled;
}

export function subscribeMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMotionEnabled(enabled: boolean): void {
  if (enabled === motionEnabled) return;
  motionEnabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // The preference still applies for the current page when storage is unavailable.
  }
  renderMotionPreference(enabled);
  for (const listener of listeners) listener();
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  const enabled = event.newValue !== 'off';
  if (enabled === motionEnabled) return;
  motionEnabled = enabled;
  renderMotionPreference(enabled);
  for (const listener of listeners) listener();
});
