import type { RequestHandler, Response } from 'express';
import type { Server } from 'socket.io';

const startedAt = new Date().toISOString();
const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 5000, Infinity];
type HttpMetric = { requests: number; errors: number; bodyBytes: number; totalMs: number; maxMs: number; histogram: number[] };
const http = new Map<string, HttpMetric>();
const events = new Map<string, number>();
const wire = { connections: 0, active: 0, receivedBytes: 0, sentBytes: 0, enginePacketsIn: 0, enginePacketsOut: 0 };
const eventCount = (direction: string, name: string) => {
  const key = `${direction}:${name}`;
  const bounded = events.has(key) || events.size < 256 ? key : `${direction}:other`;
  events.set(bounded, (events.get(bounded) ?? 0) + 1);
};

/** Counts body writes without retaining or serialising response content. */
export const recordHttpTraffic: RequestHandler = (req, res, next) => {
  const start = performance.now();
  let bytes = 0;
  const size = (chunk: unknown, encoding?: unknown) => {
    if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
    return Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : 0;
  };
  const write = res.write, end = res.end;
  res.write = function (this: Response, chunk: unknown, ...args: any[]) { bytes += size(chunk, args[0]); return (write as any).call(this, chunk, ...args); } as typeof res.write;
  res.end = function (this: Response, chunk?: unknown, ...args: any[]) { bytes += size(chunk, args[0]); return (end as any).call(this, chunk, ...args); } as typeof res.end;
  let recorded = false;
  const finish = () => {
    if (recorded) return; recorded = true;
    const path = typeof req.route?.path === 'string' ? `${req.baseUrl}${req.route.path}` : null;
    const family = req.originalUrl.startsWith('/location-assets/') ? 'images'
      : req.originalUrl.startsWith('/api/') ? 'api' : 'static';
    let key = `${req.method} ${family === 'api' ? path ?? '/api/<unmatched>' : family}`;
    if (!http.has(key) && http.size >= 256) key = `${req.method} other`;
    const item = http.get(key) ?? { requests: 0, errors: 0, bodyBytes: 0, totalMs: 0, maxMs: 0, histogram: bounds.map(() => 0) };
    const ms = performance.now() - start;
    item.requests++; item.errors += Number(res.statusCode >= 400 || !res.writableFinished);
    item.bodyBytes += bytes; item.totalMs += ms; item.maxMs = Math.max(item.maxMs, ms);
    item.histogram[bounds.findIndex(bound => ms <= bound)]++;
    http.set(key, item);
  };
  res.once('finish', finish); res.once('close', finish);
  next();
};

/** Plain Node TCP counters include framing/ACKs and every receiving connection. */
export function recordSocketTraffic(io: Server): () => void {
  const sample = new Set<() => void>();
  io.engine.on('connection', connection => {
    const tcp = connection.request.socket;
    let read = 0, written = 0;
    const flush = () => {
      wire.receivedBytes += Math.max(0, tcp.bytesRead - read);
      wire.sentBytes += Math.max(0, tcp.bytesWritten - written);
      read = tcp.bytesRead; written = tcp.bytesWritten;
    };
    sample.add(flush); wire.connections++; wire.active++;
    connection.on('packet', () => { wire.enginePacketsIn++; });
    connection.on('packetCreate', () => { wire.enginePacketsOut++; });
    tcp.once('close', () => { flush(); sample.delete(flush); wire.active--; });
  });
  io.on('connection', socket => {
    socket.onAny((name: string) => eventCount('in', socket.eventNames().includes(name) ? name : 'unknown'));
    socket.onAnyOutgoing((name: string) => eventCount('out', name));
  });
  const timer = setInterval(() => { for (const flush of sample) flush(); }, 5000);
  timer.unref();
  return () => { clearInterval(timer); for (const flush of sample) flush(); };
}

export function trafficMetrics() {
  return { scope: 'current-process', pid: process.pid, startedAt, sampledAt: new Date().toISOString(),
    http: { byteScope: 'response-body writes at Node; excludes HTTP headers and proxy compression',
      latencyBucketUpperMs: bounds.map(value => Number.isFinite(value) ? value : '+Inf'), routes: Object.fromEntries(http) },
    websocket: { byteScope: 'Node TCP including handshake/framing/ACKs; excludes proxy TLS, IP headers and retransmissions',
      ...wire, events: Object.fromEntries(events) } };
}
