import { performance } from 'node:perf_hooks';

const names = ['graph_cache_hit', 'graph_cache_miss', 'graph_build_ms', 'graph_nodes', 'graph_edges',
  'command_ms', 'command_failure', 'version_conflict', 'transaction_ms', 'transaction_retry',
  'engine_ms', 'recovery_command_ms', 'recovery_success', 'recovery_exhausted',
  'socket_message_bytes', 'socket_room_bytes_per_second', 'outbox_retry', 'outbox_stalled'] as const;
type Metric = typeof names[number];
const limits = [1, 5, 10, 25, 50, 100, 150, 300, 1000, 5000, 20000, 100000, Infinity];
const values = new Map<Metric, { count: number; sum: number; max: number; buckets: number[] }>();
const startedAt = Date.now();
export function observe(name: Metric, value = 1) {
  const metric = values.get(name) ?? { count: 0, sum: 0, max: 0, buckets: limits.map(() => 0) };
  metric.count++; metric.sum += value; metric.max = Math.max(metric.max, value);
  metric.buckets[limits.findIndex(limit => value <= limit)]++;
  values.set(name, metric);
}
export async function measured<T>(name: Metric, work: () => Promise<T>) {
  const began = performance.now();
  try { return await work(); } finally { observe(name, performance.now() - began); }
}
// Bounded, one-second per-room windows. No identities, hands or room IDs are
// exposed in the metrics response. Values measure emitted JSON, not wire framing.
const rooms = new Map<string, { second: number; bytes: number }>();
export function emitted(id: string, payload: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  observe('socket_message_bytes', bytes);
  const second = Math.floor(Date.now() / 1000), old = rooms.get(id);
  if (old && old.second !== second) observe('socket_room_bytes_per_second', old.bytes);
  rooms.delete(id); rooms.set(id, { second, bytes: old?.second === second ? old.bytes + bytes : bytes });
  if (rooms.size > 1000) { const key = rooms.keys().next().value!; observe('socket_room_bytes_per_second', rooms.get(key)!.bytes); rooms.delete(key); }
}
export function metricsSnapshot() {
  const second = Math.floor(Date.now() / 1000);
  for (const [id, value] of rooms) if (value.second < second) { observe('socket_room_bytes_per_second', value.bytes); rooms.delete(id); }
  return { scope: 'current-process', pid: process.pid, startedAt, sampledAt: Date.now(), bucketUpperBounds: limits.map(n => Number.isFinite(n) ? n : '+Inf'),
    metrics: Object.fromEntries([...values].map(([name, value]) => [name, { ...value, buckets: [...value.buckets] }])) };
}
