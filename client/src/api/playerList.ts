import { api } from './client';

export interface PlayerSuggestion {
  id: number;
  nickname: string;
}

interface CachedPlayerList {
  version: string;
  players: PlayerSuggestion[];
}

const STORAGE_KEY = 'player-list-v1';
const REVALIDATE_INTERVAL_MS = 30_000;
let memory: CachedPlayerList | null = null;
let loading: Promise<PlayerSuggestion[]> | null = null;
let validatedAt: number | null = null;
let cacheGeneration = 0;
const listeners = new Set<(players: PlayerSuggestion[]) => void>();

function removeStored(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Browser storage may be unavailable; the in-memory cache still works.
  }
}

function writeStored(value: CachedPlayerList): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Keep serving the in-memory snapshot when persistence is unavailable.
  }
}

function publish(players: PlayerSuggestion[]): void {
  for (const listener of listeners) {
    try {
      listener(players);
    } catch {
      // One mounted consumer must not break cache refresh for the others.
    }
  }
}

function readStored(): CachedPlayerList | null {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as CachedPlayerList | null;
    if (parsed?.players?.length) memory = parsed;
  } catch {
    removeStored();
  }
  return memory;
}

async function refresh(cached: CachedPlayerList | null, generation: number): Promise<PlayerSuggestion[]> {
  const response = await api.get('/players/list', {
    headers: cached ? { 'If-None-Match': `\"players-${cached.version}\"` } : undefined,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
  if (generation !== cacheGeneration) return memory?.players ?? cached?.players ?? [];
  if (response.status === 304 && cached) {
    memory = cached;
    validatedAt = performance.now();
    return cached.players;
  }
  const next: CachedPlayerList = {
    version: String(response.data.version),
    players: response.data.players,
  };
  memory = next;
  validatedAt = performance.now();
  writeStored(next);
  if (!cached || cached.version !== next.version) publish(next.players);
  return next.players;
}

function startRefresh(cached: CachedPlayerList | null): Promise<PlayerSuggestion[]> {
  if (loading) return loading;
  const task = refresh(cached, cacheGeneration);
  loading = task;
  void task.then(
    () => { if (loading === task) loading = null; },
    () => { if (loading === task) loading = null; }
  );
  return task;
}

function revalidateInBackground(cached: CachedPlayerList): void {
  if (validatedAt !== null && performance.now() - validatedAt <= REVALIDATE_INTERVAL_MS) return;
  void startRefresh(cached).catch(() => undefined);
}

export async function getPlayerList(): Promise<PlayerSuggestion[]> {
  const cached = readStored();
  if (cached) {
    revalidateInBackground(cached);
    return cached.players;
  }
  return startRefresh(null);
}

export function subscribePlayerList(listener: (players: PlayerSuggestion[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearPlayerListCache(): void {
  cacheGeneration += 1;
  memory = null;
  loading = null;
  validatedAt = null;
  removeStored();
}

export function searchPlayerList(players: PlayerSuggestion[], query: string): PlayerSuggestion[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return players
    .filter((player) => player.nickname.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.nickname.toLocaleLowerCase();
      const bName = b.nickname.toLocaleLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) ||
        a.nickname.localeCompare(b.nickname);
    })
    .slice(0, 10);
}
