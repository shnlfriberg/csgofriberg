import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { errorHandler } from '../../src/middleware/common';
import { signToken, userNameFromUsername } from '../../src/middleware/auth';
import { initRedis } from '../../src/redis';
import { initPlayerCache } from '../../src/services/playerCache';
import adminRoutes from '../../src/routes/admin';
import externalPlayerRoutes, { externalPlayerAuth } from '../../src/routes/externalPlayers';

let server: http.Server;
let baseUrl: string;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { response, data: await response.json() };
}

describe('player change submissions', () => {
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stores field-level changes and protects against stale approvals', async () => {
    const oldHistory = ['Copenhagen Flames', 'Spirit'];
    const returnedHistory = [...oldHistory, 'Copenhagen Flames'];
    const stamp = Date.now();
    const username = `player-change-admin-${stamp}`;
    const nickname = `player-change-${stamp}`;
    const insertedAdmin = await db('users').insert({
      username,
      display_id: userNameFromUsername(username),
      password_hash: 'test',
      role: 'admin',
      token_version: 0,
    }).returning(['id', 'token_version']);
    const admin = insertedAdmin[0];
    const [playerId] = await db('players').insert({
      nickname,
      nationality: 'Denmark',
      region: 'Europe',
      team: 'Old Team',
      team_history: JSON.stringify(oldHistory),
      age: 24,
      role: 'Rifler',
      major_championships: 0,
      major_appearances: 1,
      is_active: true,
      is_enabled: true,
    }).returning('id');
    const id = typeof playerId === 'object' ? playerId.id : playerId;
    await db('player_difficulties').insert({ player_id: id, difficulty_key: 'normal' });
    let tokenId: number | null = null;
    let submissionId: number | null = null;
    try {
      const cookie = `csgofriberg_session=${signToken(admin)}`;
      const tokenResponse = await request('/api/admin/api-tokens', {
        method: 'POST', headers: { Cookie: cookie },
        body: JSON.stringify({ name: 'change sync', expiresInDays: 30 }),
      });
      tokenId = Number(tokenResponse.data.id);
      const authorization = { Authorization: `Bearer ${tokenResponse.data.token}` };
      expect(tokenResponse.data.scopes).toEqual(['players:read', 'changes:submit']);
      expect((await request(`/api/external/players/${id}`, { method: 'PUT', headers: authorization, body: JSON.stringify({ team: 'Must not write' }) })).response.status).toBe(403);
      const submission = { method: 'POST', headers: { ...authorization, 'Idempotency-Key': 'route-run-1' },
        body: JSON.stringify({ players: [{ playerId: Number(id), changes: { team: 'New Team', age: 25, is_active: false, team_history: returnedHistory }, expected: { team_history: oldHistory } }] }) };
      const submitted = await request('/api/external/player-change-submissions', submission);
      const retried = await request('/api/external/player-change-submissions', submission);
      expect(retried.data).toEqual(submitted.data);
      expect((await request('/api/external/player-change-submissions', { ...submission, body: JSON.stringify({ players: [{ playerId: Number(id), changes: { team: 'Different' } }] }) })).response.status).toBe(409);
      submissionId = Number(submitted.data.submissionId);
      expect(submitted.response.status).toBe(201);
      expect(submitted.data.submitted).toBe(4);
      expect((await db('players').where({ id }).first()).team).toBe('Old Team');
      expect(JSON.parse((await db('players').where({ id }).first()).team_history)).toEqual(oldHistory);

      const pending = await request(`/api/admin/player-change-submissions?status=pending&page=1&pageSize=50&search=${encodeURIComponent(nickname)}`, { headers: { Cookie: cookie } });
      expect(pending.data.items).toHaveLength(4);
      const ageItem = pending.data.items.find((item: { field: string }) => item.field === 'age');
      const teamItem = pending.data.items.find((item: { field: string }) => item.field === 'team');
      const activeItem = pending.data.items.find((item: { field: string }) => item.field === 'is_active');
      const historyItem = pending.data.items.find((item: { field: string }) => item.field === 'team_history');

      await db('players').where({ id }).update({ team: 'Manual Team' });
      const approved = await request('/api/admin/player-change-submissions/review', {
        method: 'POST', headers: { Cookie: cookie },
        body: JSON.stringify({ itemIds: [ageItem.id, teamItem.id, historyItem.id], decision: 'approve' }),
      });
      expect(approved.data).toMatchObject({ approved: 2, conflict: 1 });
      expect((await db('players').where({ id }).first()).age).toBe(25);
      expect((await db('players').where({ id }).first()).team).toBe('Manual Team');
      expect(JSON.parse((await db('players').where({ id }).first()).team_history)).toEqual(returnedHistory);
      const exported = await request('/api/external/players/export', { headers: authorization });
      expect(exported.response.status).toBe(200);
      expect(exported.data.find((player: { playerId: number }) => player.playerId === Number(id)).team_history).toEqual(returnedHistory);

      const rejected = await request('/api/admin/player-change-submissions/review', {
        method: 'POST', headers: { Cookie: cookie },
        body: JSON.stringify({ itemIds: [activeItem.id], decision: 'reject' }),
      });
      expect(rejected.data).toMatchObject({ rejected: 1 });
      const history = await request(`/api/admin/player-change-submissions?status=all&page=1&pageSize=50&search=${encodeURIComponent(nickname)}`, { headers: { Cookie: cookie } });
      expect(history.data.items.map((item: { status: string }) => item.status).sort()).toEqual(['approved', 'approved', 'conflict', 'rejected']);
    } finally {
      await db('player_change_items').where({ player_id: id }).del();
      if (submissionId) await db('player_change_submissions').where({ id: submissionId }).del();
      await db('player_difficulties').where({ player_id: id }).del();
      await db('players').where({ id }).del();
      if (tokenId) await db('external_submission_requests').where({ token_id: tokenId }).delete();
      if (tokenId) await db('api_tokens').where({ id: tokenId }).del();
      await db('users').where({ id: admin.id }).del();
    }
  });
});
