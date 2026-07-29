import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { rejectMissingClientAsset, setClientAssetCacheHeaders } from './clientAssets';

describe('client asset fallback', () => {
  it('marks Vite fingerprinted assets as immutable for browser caching', () => {
    const setHeader = vi.fn();
    setClientAssetCacheHeaders(
      { setHeader } as unknown as Response,
      path.join('client', 'dist', 'assets', 'wjq-contenthash.jpg')
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    );
  });

  it('returns 404 for missing Vite assets instead of the SPA HTML', async () => {
    const app = express();
    app.use(rejectMissingClientAsset);
    app.get('*', (_req, res) => res.type('html').send('<!doctype html>'));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const assetResponse = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
      expect(assetResponse.status).toBe(404);
      expect(assetResponse.headers.get('content-type')).toContain('text/plain');
      expect(await assetResponse.text()).toBe('Not Found');

      const rootScriptResponse = await fetch(`http://127.0.0.1:${port}/2222.js`);
      expect(rootScriptResponse.status).toBe(404);
      expect(rootScriptResponse.headers.get('content-type')).toContain('text/plain');

      const routeResponse = await fetch(`http://127.0.0.1:${port}/room/example`);
      expect(routeResponse.status).toBe(200);
      expect(routeResponse.headers.get('content-type')).toContain('text/html');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
