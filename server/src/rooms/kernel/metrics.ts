import { instanceId, instanceStartedAt } from './instance';

/**
 * In-process room kernel counters. They are intentionally cheap: byte sizes are
 * only measured for a sample of messages, so production CPU is not spent on
 * serialising payloads twice just to count them.
 */
const counters = new Map<string, number>();
const samples = new Map<string, number[]>();
const SAMPLE_LIMIT = 256;
const BYTE_SAMPLE_EVERY = Math.max(1, Number(process.env.ROOM_KERNEL_BYTE_SAMPLE ?? 16) || 16);
let byteTick = 0;

export function countKernel(name: string, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

export function observeKernel(name: string, value: number): void {
  const list = samples.get(name) ?? [];
  list.push(value);
  if (list.length > SAMPLE_LIMIT) list.shift();
  samples.set(name, list);
  countKernel(`${name}.count`);
}

/** Count one emitted message and, for a sample, its approximate JSON size. */
export function countEmit(name: string, payload: unknown): void {
  countKernel(`${name}.messages`);
  byteTick = (byteTick + 1) % BYTE_SAMPLE_EVERY;
  if (byteTick !== 0) return;
  try {
    countKernel(`${name}.sampledBytes`, Buffer.byteLength(JSON.stringify(payload)));
    countKernel(`${name}.sampledMessages`);
  } catch {
    // Metrics must never affect delivery.
  }
}

export function kernelMetrics() {
  const timings = Object.fromEntries([...samples].map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
    return [name, { samples: sorted.length, p95 }];
  }));
  return {
    instance: instanceId,
    startedAt: instanceStartedAt,
    collectedAt: new Date().toISOString(),
    byteSampleEvery: BYTE_SAMPLE_EVERY,
    counters: Object.fromEntries(counters),
    timings,
  };
}

export function resetKernelMetrics(): void {
  counters.clear();
  samples.clear();
}
