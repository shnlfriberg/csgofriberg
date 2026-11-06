import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { errorHandler } from '../../src/middleware/common';
import { signToken, userNameFromUsername } from '../../src/middleware/auth';
import { initRedis } from '../../src/redis';
import { invalidateCached } from '../../src/services/queryCache';
import adminRoutes from '../../src/routes/admin';
import announcementRoutes from '../../src/routes/announcements';

let server: http.Server;
let baseUrl: string;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return { response, data: await response.json() };
}

describe('popup announcements', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use('/api/announcements', announcementRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('persists and returns the popup flag', async () => {
    const stamp = Date.now();
    const username = `popup-admin-${stamp}`;
    const title = `popup-${stamp}`;
    const [admin] = await db('users').insert({
      username,
      display_id: userNameFromUsername(username),
      password_hash: 'test',
      role: 'admin',
      token_version: 0,
    }).returning(['id', 'token_version']);
    const cookie = `csgofriberg_session=${signToken(admin)}`;

    try {
      const created = await request('/api/admin/announcements', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ title, content: '必须确认', is_popup: true }),
      });
      expect(created.response.status).toBe(200);

      const list = await request('/api/announcements');
      expect(list.response.status).toBe(200);
      expect(list.data).toContainEqual(expect.objectContaining({
        id: created.data.id,
        title,
        is_popup: 1,
      }));

      const edited = await request(`/api/admin/announcements/${created.data.id}`, {
        method: 'PUT',
        headers: { Cookie: cookie },
        body: JSON.stringify({ title, content: '已更正', is_popup: false }),
      });
      expect(edited.response.status).toBe(200);
      const afterEdit = await request('/api/announcements');
      expect(afterEdit.data).toContainEqual(expect.objectContaining({
        id: created.data.id,
        title,
        content: '已更正',
        is_popup: 0,
      }));

      const missing = await request('/api/admin/announcements/999999999', {
        method: 'PUT',
        headers: { Cookie: cookie },
        body: JSON.stringify({ title, content: 'x', is_popup: false }),
      });
      expect(missing.response.status).toBe(404);
      const invalid = await request(`/api/admin/announcements/${created.data.id}`, {
        method: 'PUT',
        headers: { Cookie: cookie },
        body: JSON.stringify({ title: '   ', content: 'x' }),
      });
      expect(invalid.response.status).toBe(400);
    } finally {
      await db('announcements').where({ title }).del();
      await invalidateCached('announcements');
      await db('users').where({ id: admin.id }).del();
    }
  });
});
