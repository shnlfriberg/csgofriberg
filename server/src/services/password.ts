import { Worker } from 'worker_threads';
import { config } from '../config';

const WORKER_SOURCE = `
const bcrypt = require(${JSON.stringify(require.resolve('bcryptjs'))});
const { parentPort } = require('worker_threads');
parentPort.on('message', async (job) => {
  try {
    const result = job.operation === 'hash'
      ? await bcrypt.hash(job.password, job.rounds || 10)
      : await bcrypt.compare(job.password, job.hash || '');
    parentPort.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
`;

interface PendingJob {
  id: number;
  operation: 'hash' | 'compare';
  password: string;
  hash?: string;
  rounds?: number;
  resolve: (value: string | boolean) => void;
  reject: (reason: Error) => void;
}

interface WorkerState {
  worker: Worker;
  current: PendingJob | null;
  stopped: boolean;
}

const workers: WorkerState[] = [];
const queue: PendingJob[] = [];
let nextId = 1;
let closing = false;

function removeWorker(state: WorkerState, error?: Error): void {
  if (state.stopped) return;
  state.stopped = true;
  if (state.current) {
    state.current.reject(error ?? new Error('PASSWORD_WORKER_STOPPED'));
    state.current = null;
  }
  const index = workers.indexOf(state);
  if (index >= 0) workers.splice(index, 1);
  if (!closing) dispatch();
}

function createWorker(): WorkerState {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 32 },
  });
  worker.unref();
  const state: WorkerState = { worker, current: null, stopped: false };
  worker.on('message', (message: { id: number; result?: string | boolean; error?: string }) => {
    const current = state.current;
    if (!current || current.id !== message.id) return;
    state.current = null;
    if (message.error) current.reject(new Error(message.error));
    else current.resolve(message.result as string | boolean);
    dispatch();
  });
  worker.on('error', (err) => {
    removeWorker(state, err instanceof Error ? err : new Error(String(err)));
  });
  worker.on('exit', (code) => {
    if (!closing && code !== 0) removeWorker(state, new Error(`PASSWORD_WORKER_EXIT_${code}`));
    else removeWorker(state);
  });
  workers.push(state);
  return state;
}

function dispatch(): void {
  if (closing) return;
  while (queue.length && workers.length < config.passwordWorkers) createWorker();
  for (const state of workers) {
    if (state.current || state.stopped) continue;
    const job = queue.shift();
    if (!job) break;
    state.current = job;
    state.worker.postMessage({
      id: job.id,
      operation: job.operation,
      password: job.password,
      hash: job.hash,
      rounds: job.rounds,
    });
  }
}

function submit(
  operation: PendingJob['operation'],
  password: string,
  options: { hash?: string; rounds?: number }
): Promise<string | boolean> {
  if (closing) return Promise.reject(new Error('PASSWORD_SERVICE_STOPPED'));
  if (queue.length >= config.passwordQueueLimit) {
    return Promise.reject(new Error('PASSWORD_SERVICE_BUSY'));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, operation, password, ...options, resolve, reject });
    dispatch();
  });
}

export async function hashPassword(password: string, rounds = config.bcryptRounds): Promise<string> {
  return submit('hash', password, { rounds }) as Promise<string>;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return submit('compare', password, { hash }) as Promise<boolean>;
}

export function passwordNeedsRehash(hash: string): boolean {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  return !match || Number(match[1]) !== config.bcryptRounds;
}

export async function closePasswordWorkers(): Promise<void> {
  closing = true;
  while (queue.length) queue.shift()!.reject(new Error('PASSWORD_SERVICE_STOPPED'));
  const active = workers.splice(0);
  await Promise.allSettled(active.map((state) => {
    state.stopped = true;
    state.current?.reject(new Error('PASSWORD_SERVICE_STOPPED'));
    state.current = null;
    return state.worker.terminate();
  }));
}
