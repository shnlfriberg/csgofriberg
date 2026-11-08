import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import buildInfo from '../../src/generated/buildInfo.json';
import healthRoutes from '../../src/routes/health';

const state = vi.hoisted(() => ({ redisAvailable: true }));
vi.mock('../../src/config', () => ({ config: { showLeaderboard: false } }));
vi.mock('../../src/redis', () => ({ isRedisAvailable: () => state.redisAvailable }));
vi.mock('../../src/services/runtimeMonitor', () => ({ getRuntimeSnapshot: () => ({ instance: 'fixture' }) }));

describe('public health check', () => {
  it.each([true, false])('preserves health fields and includes immutable build identity (Redis %s)', async (available) => {
    state.redisAvailable = available;
    const app = express();
    app.use('/api/health', healthRoutes);
    app.use((_req, res) => { res.sendStatus(401); });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        ok: true, redis: available ? 'up' : 'degraded',
        features: { leaderboard: false }, runtime: { instance: 'fixture' }, version: buildInfo,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
