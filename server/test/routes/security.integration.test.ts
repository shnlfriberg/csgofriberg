import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import * as redisModule from '../../src/redis';
import { authenticateCookie, invalidateAuthUser, signToken } from '../../src/middleware/auth';
import { requireApiToken } from '../../src/middleware/apiToken';
import { createApiToken } from '../../src/services/apiTokens';
import { hashPassword } from '../../src/services/password';
import { errorHandler } from '../../src/middleware/common';
import authRoutes from '../../src/routes/auth';
import { registerSocketMiddleware } from '../../src/socket/middleware';
import { socketServerOptions } from '../../src/socket/options';
import { config } from '../../src/config';

const users: number[] = [];
let server: http.Server, io: Server, base: string;
let actions = 0;
async function user(role = 'user', password_hash = 'unused') {
  const [row] = await db('users').insert({ username: `sec${randomUUID().replaceAll('-', '').slice(0, 16)}`, password_hash, role }).returning('*');
  users.push(row.id); return row;
}
const cookie = (u: any) => `csgofriberg_session=${signToken(u)}`;
async function socketFor(u: any): Promise<Socket> {
  const socket = connect(base, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie(u) } });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}

beforeAll(async () => {
  await initDb(); await redisModule.initRedis();
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes);
  app.get('/external', requireApiToken, (_req, res) => res.json({ ok: true })); app.use(errorHandler);
  server = http.createServer(app); io = new Server(server, socketServerOptions()); app.set('io', io);
  registerSocketMiddleware(io);
  io.on('connection', socket => {
    socket.join(`identity:${socket.data.identity.key}`);
    socket.on('audit:action', (_payload, ack) => { actions++; ack({ ok: true }); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => io.close(() => resolve())); await db('users').whereIn('id', users).delete(); });

describe('session revocation and machine tokens', () => {
  it('disconnects passive authenticated subscriptions at JWT expiry', async () => {
    const u = await user();
    const token = jwt.sign({ sub: String(u.id), ver: 0, typ: 'auth' }, config.jwtSecret, { expiresIn: '2s' });
    const socket = connect(base, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: `csgofriberg_session=${token}` } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      await new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
      expect(socket.connected).toBe(false);
    } finally { socket.disconnect(); }
  });
  it('logout disconnects every existing socket of the identity', async () => {
    const u = await user(), a = await socketFor(u), b = await socketFor(u);
    try {
      const disconnected = Promise.all([a, b].map(socket => new Promise<void>(resolve => socket.once('disconnect', () => resolve()))));
      const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie(u) } });
      expect(response.status).toBe(200); await disconnected;
      expect(a.connected || b.connected).toBe(false);
      expect(await authenticateCookie(cookie(u))).toBeNull();
    } finally { a.disconnect(); b.disconnect(); }
  });
  it('revalidates event identity even if a disconnect notification was missed', async () => {
    const u = await user(), socket = await socketFor(u), before = actions;
    try {
      await db('users').where({ id: u.id }).increment('token_version', 1); await invalidateAuthUser(u.id);
      const disconnected = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
      const response = await socket.timeout(3000).emitWithAck('audit:action', {});
      expect(response.code).toBe('AUTH_EXPIRED'); await disconnected;
      expect(actions).toBe(before);
    } finally { socket.disconnect(); }
  });
  it('rejects the existing token of a banned administrator', async () => {
    const u = await user('admin'), token = await createApiToken(u.id, 'isolated', 1);
    const headers = { Authorization: `Bearer ${token.token}` };
    expect((await fetch(`${base}/external`, { headers })).status).toBe(200);
    await db('users').where({ id: u.id }).update({ banned_at: new Date() });
    expect((await fetch(`${base}/external`, { headers })).status).toBe(401);
  });
  it('ignores a stale authentication cache after revocation and Redis recovery', async () => {
    const u = await user(), client = redisModule.redis()!;
    expect((await authenticateCookie(cookie(u)))?.id).toBe(u.id);
    const spy = vi.spyOn(redisModule, 'redis').mockReturnValue(null);
    try {
      await db('users').where({ id: u.id }).increment('token_version', 1); await invalidateAuthUser(u.id);
      expect(await authenticateCookie(cookie(u))).toBeNull();
    } finally { spy.mockRestore(); }
    // Reproduce the stale value left by an old in-flight reader / outage.
    await client.set(redisModule.redisKey(`auth:user:${u.id}`), JSON.stringify({ id: u.id, username: u.username,
      role: 'admin', tokenVersion: 0, email: null, emailVerified: true }), { EX: 300 });
    expect(await authenticateCookie(cookie(u))).toBeNull();
  });
});

describe('bcrypt byte boundary without breaking legacy login', () => {
  it('rejects long ASCII and multibyte new passwords', async () => {
    for (const password of ['A'.repeat(73), '密'.repeat(24) + 'X']) {
      await expect(hashPassword(password)).rejects.toThrow('REGISTER_PASSWORD_LENGTH');
      const response = await fetch(`${base}/api/auth/password/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', code: '123456', password }) });
      expect(response.status).toBe(400);
    }
  });
  it('accepts an existing long-password hash without attempting a truncating rehash', async () => {
    const password = 'A'.repeat(72) + 'legacy', u = await user('user', await bcrypt.hash(password, 4));
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.username, password }) });
    expect(login.status).toBe(200);
    expect((await db('users').where({ id: u.id }).first()).password_hash).toBe(u.password_hash);
  });
});
