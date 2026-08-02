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

export interface RegisterPowProof {
  id: string;
  nonce: string;
}

export interface PowProgress {
  active: boolean;
  percent: number;
}

let validUntil = 0;
let activeRequest: Promise<void> | null = null;
let refreshTimer: number | null = null;
let progressTimer: number | null = null;
let progressStartedAt = 0;
let powProgress: PowProgress = { active: false, percent: 0 };
const progressListeners = new Set<() => void>();

export function subscribePowProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function getPowProgress(): PowProgress {
  return powProgress;
}

function setPowProgress(next: PowProgress): void {
  powProgress = next;
  progressListeners.forEach((listener) => listener());
}

function startRegisterProgress(): void {
  if (progressTimer !== null) window.clearInterval(progressTimer);
  progressStartedAt = performance.now();
  setPowProgress({ active: true, percent: 3 });
  progressTimer = window.setInterval(() => {
    const elapsed = performance.now() - progressStartedAt;
    const percent = Math.min(92, 3 + (elapsed / 3_000) * 89);
    setPowProgress({ active: true, percent });
  }, 100);
}

function stopRegisterProgress(): void {
  if (progressTimer !== null) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
  setPowProgress({ active: false, percent: 100 });
}

function noteValidity(
  expiresInMs: unknown,
  legacyExpiresAt?: unknown
): boolean {
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

async function requestChallenge(profile?: 'register'): Promise<ChallengeResponse> {
  const challengeResponse = await powApi.post<ChallengeResponse>(
    '/challenge',
    profile ? { profile } : undefined,
    {
      headers: { 'Cache-Control': 'no-cache' },
    }
  );
  return challengeResponse.data;
}

function requireSolvableChallenge(data: ChallengeResponse): asserts data is Required<Pick<
  ChallengeResponse,
  'id' | 'challenge' | 'difficulty' | 'algorithm'
>> & ChallengeResponse {
  if (
    data.algorithm !== 'csgofriberg-pow-v1' ||
    !data.id ||
    !data.challenge ||
    !data.difficulty
  ) throw new Error('POW_CHALLENGE_INVALID');
}

async function refreshPow(): Promise<void> {
  const data = await requestChallenge();
  if (data.valid && data.expiresAt) {
    noteValidity(data.expiresInMs, data.expiresAt);
    scheduleRefresh();
    return;
  }
  requireSolvableChallenge(data);

  const nonce = await solveChallenge(data.challenge, data.difficulty);
  const verifyResponse = await powApi.post<{ expiresAt: number; expiresInMs?: number; difficulty?: number }>('/verify', {
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
  if (force) {
    validUntil = 0;
  }
  const promise = (async () => {
    try {
      await refreshPow();
    } catch (error) {
      validUntil = 0;
      throw error;
    }
  })();
  activeRequest = promise;
  void promise.then(() => {
    if (activeRequest === promise) activeRequest = null;
  }, () => {
    if (activeRequest === promise) activeRequest = null;
  });
  return promise;
}

export async function createRegisterPow(): Promise<RegisterPowProof> {
  startRegisterProgress();
  try {
    const data = await requestChallenge('register');
    requireSolvableChallenge(data);
    return {
      id: data.id,
      nonce: await solveChallenge(data.challenge, data.difficulty),
    };
  } finally {
    stopRegisterProgress();
  }
}

export function notePowExpiry(expiresAt: unknown, expiresInMs?: unknown): void {
  if (noteValidity(expiresInMs, expiresAt)) scheduleRefresh();
}

try {
  localStorage.removeItem(LEGACY_EXPIRY_STORAGE_KEY);
} catch {
  /* Storage may be unavailable in strict privacy modes. */
}
