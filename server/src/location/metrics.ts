import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
const instance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const startedAt = new Date().toISOString();
const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];
type Sample = { count: number; totalMs: number; maxMs: number; recent: number[]; buckets: number[] };
const samples = new Map<string, Sample>();
const counters = new Map<string, number>();
export function countMetric(name: string, amount = 1) {
  counters.set(name, (counters.get(name) || 0) + amount);
}
export function observeMetric(name: string, elapsed: number) {
  const value = samples.get(name) || { count: 0, totalMs: 0, maxMs: 0, recent: [], buckets: buckets.map(() => 0) };
  buckets.forEach((bound, index) => { if (elapsed <= bound) value.buckets[index]++; });
  value.count++; value.totalMs += elapsed; value.maxMs = Math.max(value.maxMs, elapsed);
  value.recent.push(elapsed); if (value.recent.length > 256) value.recent.shift();
  samples.set(name, value);
}
export async function measured<T>(name: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await action(); } finally { observeMetric(name, performance.now() - start); }
}
export function locationMetrics() {
  return { instance, startedAt, collectedAt: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), rssBytes: process.memoryUsage().rss, counters: Object.fromEntries(counters), timings: Object.fromEntries([...samples].map(([name, value]) => {
    const sorted = [...value.recent].sort((a, b) => a - b);
    return [name, { count: value.count, totalMs: value.totalMs, histogram: { ...Object.fromEntries(buckets.map((bound, index) => [String(bound), value.buckets[index]])), '+Inf': value.count }, meanMs: Math.round(value.totalMs / value.count), maxMs: Math.round(value.maxMs),
      p95Ms: Math.round(sorted[Math.floor((sorted.length - 1) * .95)] || 0), sampleSize: sorted.length }];
  })) };
}
