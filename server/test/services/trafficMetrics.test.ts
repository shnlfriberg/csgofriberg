import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { recordHttpTraffic, recordSocketTraffic, trafficMetrics } from '../../src/services/trafficMetrics';

describe('traffic counters without retaining private content', () => {
  it('counts UTF-8 response bodies and normalizes request IDs', async () => {
    const app = express(); app.use(recordHttpTraffic);
    app.get('/api/test/:id', (_req, res) => res.send('你好'));
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/test/private-id`);
      expect(await response.text()).toBe('你好');
      const result = trafficMetrics();
      expect(result.http.routes['GET /api/test/:id']).toMatchObject({ requests: 1, bodyBytes: 6 });
      expect(JSON.stringify(result)).not.toMatch(/private-id|你好/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('counts framing and each receiving connection rather than one logical emit', async () => {
    const server = http.createServer(), io = new Server(server, { transports: ['websocket'] });
    const stop = recordSocketTraffic(io);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const a = connect(base, { transports: ['websocket'], reconnection: false }), b = connect(base, { transports: ['websocket'], reconnection: false });
    try {
      await Promise.all([a, b].map(socket => new Promise<void>(resolve => socket.once('connect', resolve))));
      const received = Promise.all([a, b].map(socket => new Promise<void>(resolve => socket.once('private:test', () => resolve()))));
      io.emit('private:test', { hand: 'secret-synthetic-hand' }); await received;
      a.disconnect(); b.disconnect();
      await vi.waitFor(() => expect(trafficMetrics().websocket.active).toBe(0));
      const result = trafficMetrics();
      expect(result.websocket.sentBytes).toBeGreaterThan(100);
      expect(result.websocket.receivedBytes).toBeGreaterThan(0);
      expect(result.websocket.events['out:private:test']).toBe(2);
      expect(JSON.stringify(result)).not.toContain('secret-synthetic-hand');
    } finally { a.disconnect(); b.disconnect(); await new Promise<void>(resolve => io.close(() => resolve())); stop(); }
  });
});
