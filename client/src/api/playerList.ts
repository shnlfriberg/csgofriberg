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
const LEET_EQUIVALENTS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
};
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

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function areLeetCharactersEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  if (left === '1') return right === 'i' || right === 'l';
  if (right === '1') return left === 'i' || left === 'l';
  return LEET_EQUIVALENTS[left] === right || LEET_EQUIVALENTS[right] === left;
}

function leetMatchesAt(value: string, query: string, start: number): boolean {
  if (start + query.length > value.length) return false;
  for (let index = 0; index < query.length; index += 1) {
    if (!areLeetCharactersEquivalent(value[start + index], query[index])) return false;
  }
  return true;
}

function leetIncludes(value: string, query: string): boolean {
  for (let start = 0; start <= value.length - query.length; start += 1) {
    if (leetMatchesAt(value, query, start)) return true;
  }
  return false;
}

function matchScore(nickname: string, query: string): number {
  const name = normalizeSearch(nickname);
  if (name === query) return 0;
  if (name.length === query.length && leetMatchesAt(name, query, 0)) return 1;
  if (name.startsWith(query)) return 2;
  if (leetMatchesAt(name, query, 0)) return 3;
  if (name.includes(query)) return 4;
  if (leetIncludes(name, query)) return 5;
  return Number.POSITIVE_INFINITY;
}

export function searchPlayerList(players: PlayerSuggestion[], query: string): PlayerSuggestion[] {
  const normalized = normalizeSearch(query);
  if (!normalized) return [];
  return players
    .map((player) => ({ player, score: matchScore(player.nickname, normalized) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.player.nickname.localeCompare(b.player.nickname))
    .map((entry) => entry.player)
    .slice(0, 10);
}
