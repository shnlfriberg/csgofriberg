import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { errorHandler } from '../middleware/common';
import { signToken, userNameFromUsername } from '../middleware/auth';
import { initRedis } from '../redis';
import { invalidateCached } from '../services/queryCache';
import adminRoutes from './admin';
import announcementRoutes from './announcements';
import specialThanksRoutes from './specialThanks';

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
    app.use('/api/special-thanks', specialThanksRoutes);
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
    } finally {
      await db('announcements').where({ title }).del();
      await invalidateCached('announcements');
      await db('users').where({ id: admin.id }).del();
    }
  });

  it('manages the public special thanks list idempotently', async () => {
    const stamp = Date.now();
    const username = `thanks-admin-${stamp}`;
    const name = `Contributor ${stamp}`;
    const updatedName = `Contributor Updated ${stamp}`;
    const secondName = `Contributor Second ${stamp}`;
    const limitPrefix = `Limit ${stamp}`;
    const [admin] = await db('users').insert({
      username,
      display_id: userNameFromUsername(username),
      password_hash: 'test',
      role: 'admin',
      token_version: 0,
    }).returning(['id', 'token_version']);
    const cookie = `csgofriberg_session=${signToken(admin)}`;

    try {
      const created = await request('/api/admin/special-thanks', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: `  ${name}  `, note: '  Helped verify player data  ' }),
      });
      expect(created.response.status).toBe(201);
      expect(created.data).toMatchObject({ name, note: 'Helped verify player data', created: true });

      const duplicate = await request('/api/admin/special-thanks', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name, note: 'Ignored duplicate note' }),
      });
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.data).toEqual({
        id: created.data.id,
        name,
        note: 'Helped verify player data',
        created: false,
      });

      const second = await request('/api/admin/special-thanks', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: secondName, note: 'Second contributor' }),
      });
      expect(second.response.status).toBe(201);

      const updated = await request(`/api/admin/special-thanks/${created.data.id}`, {
        method: 'PATCH',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: updatedName, note: 'Updated contribution' }),
      });
      expect(updated.response.status).toBe(200);
      expect(updated.data).toEqual({
        id: created.data.id,
        name: updatedName,
        note: 'Updated contribution',
      });

      const beforeOrder = await request('/api/special-thanks');
      const otherIds = beforeOrder.data.items
        .map((item: any) => Number(item.id))
        .filter((id: number) => ![Number(created.data.id), Number(second.data.id)].includes(id));
      const reorderedIds = [Number(second.data.id), Number(created.data.id), ...otherIds];
      const reordered = await request('/api/admin/special-thanks/order', {
        method: 'PUT',
        headers: { Cookie: cookie },
        body: JSON.stringify({ ids: reorderedIds }),
      });
      expect(reordered.response.status).toBe(200);

      const list = await request('/api/special-thanks');
      expect(list.response.status).toBe(200);
      expect(list.data.items.slice(0, 2)).toEqual([
        { id: second.data.id, name: secondName, note: 'Second contributor' },
        { id: created.data.id, name: updatedName, note: 'Updated contribution' },
      ]);

      const invalid = await request('/api/admin/special-thanks', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: 'x'.repeat(81) }),
      });
      expect(invalid.response.status).toBe(400);

      const removed = await request(`/api/admin/special-thanks/${created.data.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(removed.response.status).toBe(200);
      await request(`/api/admin/special-thanks/${second.data.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect((await request('/api/special-thanks')).data.items).not.toContainEqual(
        expect.objectContaining({ name: updatedName })
      );

      const [{ count }] = await db('special_thanks').count<{ count: number | string }[]>({ count: '*' });
      const fillCount = Math.max(0, 10 - Number(count));
      if (fillCount) {
        await db.batchInsert('special_thanks', Array.from({ length: fillCount }, (_, index) => ({
          name: `${limitPrefix}-${index}`,
        })), 50);
      }
      const limited = await request('/api/admin/special-thanks', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: `${limitPrefix}-overflow` }),
      });
      expect(limited.response.status).toBe(409);
      expect(limited.data).toEqual({ code: 'SPECIAL_THANKS_LIMIT_REACHED' });
    } finally {
      await db('special_thanks')
        .whereIn('name', [name, updatedName, secondName])
        .orWhere('name', 'like', `${limitPrefix}%`)
        .del();
      await invalidateCached('special-thanks');
      await db('users').where({ id: admin.id }).del();
    }
  });
});
