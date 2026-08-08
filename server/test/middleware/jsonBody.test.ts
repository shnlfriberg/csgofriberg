import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/middleware/common';
import { parseJsonOnce, rejectOversizedBody } from '../../src/middleware/jsonBody';

let server: http.Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('json body routing', () => {
  it('does not read the request stream twice for the import route', async () => {
    const app = express();
    app.use('/api/admin/players/import', rejectOversizedBody(1024 * 1024), parseJsonOnce('1mb'));
    app.use('/api', rejectOversizedBody(64 * 1024), parseJsonOnce('64kb'));
    app.post('/api/admin/players/import', (req, res) => res.json({ count: req.body.players.length }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/players/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: Array.from({ length: 2000 }, (_, id) => ({ id })) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2000 });
  });

  it('accepts a 180 KiB import body while ordinary API bodies stay limited', async () => {
    const app = express();
    app.use(
      '/api/admin/players/import',
      rejectOversizedBody(2 * 1024 * 1024),
      parseJsonOnce(`${2 * 1024 * 1024}b`)
    );
    app.use('/api', rejectOversizedBody(64 * 1024), parseJsonOnce('64kb'));
    app.post('/api/admin/players/import', (req, res) =>
      res.json({ size: Buffer.byteLength(JSON.stringify(req.body)) })
    );
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({ players: [{ nickname: 'x'.repeat(180 * 1024) }] });
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/players/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: Buffer.byteLength(body) });
  });

  it('rejects oversized ordinary API bodies before parsing', async () => {
    const app = express();
    app.use('/api', rejectOversizedBody(32), parseJsonOnce('32b'));
    app.post('/api/test', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(64) }),
    });
    expect(response.status).toBe(413);
  });

  it('does not re-read an empty body on a specially parsed route', async () => {
    const app = express();
    app.use('/api/special', parseJsonOnce('1mb'));
    app.use('/api', parseJsonOnce('64kb'));
    app.post('/api/special', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/special`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
