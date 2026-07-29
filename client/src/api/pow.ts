import axios from 'axios';

const powApi = axios.create({ baseURL: '/api/pow', withCredentials: true });
const LEGACY_EXPIRY_STORAGE_KEY = 'csgofriberg_pow_expires_at';
const LEGACY_VALIDITY_MS = 30_000;

interface ChallengeResponse {
  valid?: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  id?: string;
  challenge?: string;
  difficulty?: number;
  algorithm?: string;
}

let validUntil = 0;
let activeRequest: Promise<void> | null = null;
let refreshTimer: number | null = null;

function noteValidity(expiresInMs: unknown, legacyExpiresAt?: unknown): boolean {
  const duration = Number(expiresInMs);
  const legacyExpiry = Number(legacyExpiresAt);
  const validityMs = Number.isFinite(duration) && duration > 0
    ? duration
    : Number.isFinite(legacyExpiry) && legacyExpiry > 0
      ? LEGACY_VALIDITY_MS
      : 0;
  if (validityMs <= 0) return false;
  validUntil = performance.now() + validityMs;
  return true;
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const remaining = validUntil - performance.now();
  if (remaining <= 0) return;
  const delay = Math.max(1_000, remaining);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void ensurePow(true).catch(() => undefined);
  }, delay);
}

function runWorker(worker: Worker, challenge: string, difficulty: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<{ nonce?: string; error?: string }>) => {
      finish();
      if (event.data.nonce) resolve(event.data.nonce);
      else reject(new Error(event.data.error || 'POW_FAILED'));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'POW_WORKER_FAILED'));
    };
    worker.postMessage({ challenge, difficulty });
  });
}

async function solveChallenge(challenge: string, difficulty: number): Promise<string> {
  try {
    const wasmWorker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
    return await runWorker(wasmWorker, challenge, difficulty);
  } catch {
    // Classic Worker plus synchronous JavaScript SHA-256 covers WebKit versions that
    // cannot load module workers or bridge WebAssembly i64 values through BigInt.
    const fallbackWorker = new Worker(new URL('./pow.fallback.worker.ts', import.meta.url));
    return runWorker(fallbackWorker, challenge, difficulty);
  }
}

async function refreshPow(): Promise<void> {
  const challengeResponse = await powApi.post<ChallengeResponse>('/challenge', undefined, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  const data = challengeResponse.data;
  if (data.valid && data.expiresAt) {
    noteValidity(data.expiresInMs, data.expiresAt);
    scheduleRefresh();
    return;
  }
  if (
    data.algorithm !== 'csgofriberg-pow-v1' ||
    !data.id ||
    !data.challenge ||
    !data.difficulty
  ) throw new Error('POW_CHALLENGE_INVALID');

  const nonce = await solveChallenge(data.challenge, data.difficulty);
  const verifyResponse = await powApi.post<{ expiresAt: number; expiresInMs?: number }>('/verify', {
    id: data.id,
    nonce,
  });
  noteValidity(verifyResponse.data.expiresInMs, verifyResponse.data.expiresAt);
  scheduleRefresh();
}

export function ensurePow(force = false): Promise<void> {
  if (activeRequest) return activeRequest;
  if (!force && validUntil > performance.now()) {
    scheduleRefresh();
    return Promise.resolve();
  }
  if (force) validUntil = 0;
  activeRequest = refreshPow()
    .catch((error) => {
      validUntil = 0;
      throw error;
    })
    .finally(() => {
      activeRequest = null;
    });
  return activeRequest;
}

export function notePowExpiry(expiresAt: unknown, expiresInMs?: unknown): void {
  if (noteValidity(expiresInMs, expiresAt)) scheduleRefresh();
}

try {
  localStorage.removeItem(LEGACY_EXPIRY_STORAGE_KEY);
} catch {
  /* Storage may be unavailable in strict privacy modes. */
}
