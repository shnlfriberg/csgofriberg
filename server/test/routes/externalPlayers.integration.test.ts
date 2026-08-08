import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { errorHandler } from '../../src/middleware/common';
import { signToken, userNameFromUsername } from '../../src/middleware/auth';
import { initRedis } from '../../src/redis';
import { getPlayer, initPlayerCache } from '../../src/services/playerCache';
import adminRoutes from '../../src/routes/admin';
import externalPlayerRoutes, { externalPlayerAuth } from '../../src/routes/externalPlayers';

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

describe('external player API tokens', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use('/api/external', externalPlayerAuth);
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use('/api/external', externalPlayerRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('creates, uses, and revokes a hashed token for player mutations', async () => {
    const stamp = Date.now();
    const username = `external-api-admin-${stamp}`;
    const nickA = `external-a-${stamp}`;
    const nickB = `external-b-${stamp}`;
    const [admin] = await db('users')
      .insert({
        username,
        display_id: userNameFromUsername(username),
        password_hash: 'test',
        role: 'admin',
        token_version: 0,
      })
      .returning(['id', 'token_version']);
    const cookie = `csgofriberg_session=${signToken(admin)}`;

    try {
      const createdToken = await request('/api/admin/api-tokens', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: 'sync job', expiresInDays: 30 }),
      });
      expect(createdToken.response.status).toBe(201);
      expect(createdToken.data.token).toMatch(/^csgf_[A-Za-z0-9_-]{43}$/);
      expect(createdToken.data.prefix).toMatch(/^csgf_.+\.\.\.$/);

      const storedToken = await db('api_tokens').where({ id: createdToken.data.id }).first();
      expect(storedToken.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(storedToken)).not.toContain(createdToken.data.token);

      const missingToken = await request('/api/external/players', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(missingToken.response.status).toBe(401);
      expect(missingToken.data.code).toBe('API_TOKEN_REQUIRED');

      const authorization = { Authorization: `Bearer ${createdToken.data.token}` };
      const createdPlayer = await request('/api/external/players', {
        method: 'POST',
        headers: authorization,
        body: JSON.stringify({
          nickname: nickA,
          nationality: 'Denmark',
          region: 'Europe',
          team: 'API Team',
          age: 25,
          role: 'Rifler',
          major_championships: 0,
          major_appearances: 2,
          difficulties: ['normal'],
          is_active: true,
          is_enabled: true,
        }),
      });
      expect(createdPlayer.response.status).toBe(201);
      const playerId = Number(createdPlayer.data.id);
      expect(getPlayer(playerId)?.nickname).toBe(nickA);

      const updatedPlayer = await request(`/api/external/players/${playerId}`, {
        method: 'PUT',
        headers: authorization,
        body: JSON.stringify({ team: 'Updated API Team', difficulties: ['normal', 'easy'] }),
      });
      expect(updatedPlayer.response.status).toBe(200);
      expect(getPlayer(playerId)?.team).toBe('Updated API Team');
      expect(await db('player_difficulties')
        .where({ player_id: playerId })
        .orderBy('difficulty_key')
        .pluck('difficulty_key')).toEqual(['easy', 'normal']);

      const imported = await request('/api/external/players/import', {
        method: 'POST',
        headers: authorization,
        body: JSON.stringify({
          players: [
            {
              nickname: nickA,
              nationality: 'Denmark',
              region: 'Europe',
              team: 'Bulk Updated',
              age: 26,
              role: 'Rifler',
              major_championships: 0,
              major_appearances: 3,
              is_active: true,
            },
            {
              nickname: nickB,
              nationality: 'Sweden',
              age: 23,
              difficulties: ['normal', 'easy'],
            },
          ],
        }),
      });
      expect(imported.response.status).toBe(200);
      expect(imported.data).toEqual({ created: 1, updated: 1 });
      expect(getPlayer(playerId)?.team).toBe('Bulk Updated');
      const importedPlayerId = await db('players').where({ nickname: nickB }).first('id');
      expect(await db('player_difficulties')
        .where({ player_id: importedPlayerId.id })
        .orderBy('difficulty_key')
        .pluck('difficulty_key')).toEqual(['easy', 'normal']);
      const revoked = await request(`/api/admin/api-tokens/${createdToken.data.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(revoked.response.status).toBe(200);

      const afterRevoke = await request(`/api/external/players/${playerId}`, {
        method: 'PUT',
        headers: authorization,
        body: JSON.stringify({ age: 27 }),
      });
      expect(afterRevoke.response.status).toBe(401);
      expect(afterRevoke.data.code).toBe('API_TOKEN_INVALID');
    } finally {
      const playerIds = await db('players').whereIn('nickname', [nickA, nickB]).pluck('id');
      if (playerIds.length) {
        await db('player_difficulties').whereIn('player_id', playerIds).del();
        await db('players').whereIn('id', playerIds).del();
      }
      await db('api_tokens').where({ created_by_user_id: admin.id }).del();
      await db('users').where({ id: admin.id }).del();
    }
  });
});
