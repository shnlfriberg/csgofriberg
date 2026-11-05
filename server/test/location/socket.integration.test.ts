import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { config } from '../../src/config';
import { signToken } from '../../src/middleware/auth';
import { initRedis, redis, redisKey } from '../../src/redis';
import { browserFingerprint, POW_COOKIE } from '../../src/services/pow';
import { getLocationRoom, saveRoom, flushResult } from '../../src/location/rooms';
import { withKeyLock } from '../../src/location/lock';
import { publicPlayerKey } from '../../src/location/publicIdentity';
import { seedLocationFixtures } from './database';

describe('location multiplayer across two actual server processes', () => {
  const children: ChildProcess[] = []; const sockets: Socket[] = []; const roomIds: string[] = []; const clients: Array<{ socket: Socket; cookie: string; ip: string }> = [];
  let ports: number[] = []; let clean: () => Promise<void>; const agent = 'location-drill-test';
  const userIds: number[] = [];
  async function connectUser(ip: string, verified = true, hasEmail = true) {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 20);
    const inserted = await db('users').insert({ username: `loc_${suffix}`, password_hash: 'unused', email: hasEmail ? `${suffix}@example.com` : null, email_verified_at: verified ? new Date().toISOString() : null }).returning('id');
    const id = Number(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
    userIds.push(id);
    const proof = jwt.sign({ typ: 'pow', fp: browserFingerprint(agent, ip), jti: randomUUID(), difficulty: config.powDifficulty }, config.jwtSecret, { expiresIn: '1h' });
    return { ...await connect(ports[1], ip, `csgofriberg_session=${signToken({ id, token_version: 0 })}; ${POW_COOKIE}=${proof}`), id };
  }
  async function instance() {
    const child = fork(path.resolve(__dirname, 'instance.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, JWT_SECRET: config.jwtSecret, TRUST_PROXY: 'true' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
    child.stderr?.on('data', data => { const text = String(data); if (!text.includes('ExperimentalWarning')) process.stderr.write(text); });
    return new Promise<number>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('INSTANCE_START_TIMEOUT')), 15000); child.once('message', (message: any) => { clearTimeout(timeout); resolve(message.port); }); child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(`INSTANCE_EXIT:${code}`)); }); });
  }
  async function connect(port: number, ip: string, cookie?: string) {
    cookie ||= `csgofriberg_guest=${jwt.sign({ key: `location-test-socket-${randomUUID()}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}; ${POW_COOKIE}=${jwt.sign({ typ: 'pow', fp: browserFingerprint(agent, ip), jti: randomUUID(), difficulty: config.powDifficulty }, config.jwtSecret, { expiresIn: '1h' })}`;
    const socket = connectSocket(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie, 'User-Agent': agent, 'X-Forwarded-For': ip } }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return { socket, cookie, ip };
  }
  async function emit(socket: Socket, event: string, data: unknown): Promise<any> {
    return new Promise((resolve, reject) => socket.timeout(15000).emit(event, data, (error: unknown, result: any) => error ? reject(error) : resolve(result)));
  }
  async function ok(socket: Socket, event: string, data: unknown) { const result = await emit(socket, event, data); expect(result, `${event}: ${JSON.stringify(result)}`).toMatchObject({ ok: true }); return result.data; }
  async function waitFor(check: () => Promise<boolean>, timeout = 15000) { const limit = Date.now() + timeout; while (!await check()) { if (Date.now() > limit) throw new Error('STATE_WAIT_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 200)); } }
  beforeAll(async () => { await initDb(); if (config.dbClient === 'sqlite') await db.raw('PRAGMA journal_mode=WAL'); await initRedis(); clean = await seedLocationFixtures(); ports = [await instance(), await instance()]; }, 45000);
  afterAll(async () => {
    sockets.forEach(socket => socket.disconnect());
    for (const child of children) if (child.connected) { child.send('stop'); await new Promise<void>(resolve => { const timeout = setTimeout(() => { child.kill(); resolve(); }, 10000); child.once('exit', () => { clearTimeout(timeout); resolve(); }); }); }
    for (const id of roomIds) { const room = await getLocationRoom(id).catch(() => null); if (room) { await redis()!.del(redisKey(`location:room:${id}`)); await redis()!.zRem(redisKey('location:rooms'), id); await redis()!.zRem(redisKey('location:outbox'), room.gameId); for (const p of room.players) await redis()!.del(redisKey(`location:room-owner:${p.identity.key}`)); } }
    await clean();
    await db('users').whereIn('id', userIds).delete();
  }, 45000);
  it('runs 20 eight-player rooms, survives one process loss, and persists exactly 160 tied results', async () => {
    const began = Date.now();
    for (let roomIndex = 0; roomIndex < 20; roomIndex++) {
      const seats = await Promise.all(Array.from({ length: 8 }, (_, seat) => connect(ports[seat % 2], `192.0.2.${roomIndex + 1}`))); clients.push(...seats);
      const room = await ok(seats[0].socket, 'location:room:create', { difficulty: 'normal', duration: 120 }); roomIds.push(room.id);
      for (const seat of seats.slice(1)) await ok(seat.socket, 'location:room:join', { roomId: room.id });
      for (const seat of seats) await ok(seat.socket, 'location:room:ready', { roomId: room.id, ready: true });
      await ok(seats[0].socket, 'location:room:start', { roomId: room.id });
    }
    for (let round = 1; round <= 5; round++) {
      await waitFor(async () => (await Promise.all(roomIds.map(getLocationRoom))).every(room => room.round === round && room.status === 'playing'), 25000);
      await Promise.all(roomIds.map(async (id, i) => {
        const room = await getLocationRoom(id); const q = room.questions[round - 1].question;
        const input = { roomId: id, mapId: q.mapId, floorId: q.floorId, u: q.u, v: q.v, round, version: round, requestId: randomUUID() };
        await ok(clients[i * 8].socket, 'location:room:answer', input);
        const hidden = await ok(clients[i * 8 + 1].socket, 'location:room:state', { roomId: id });
        expect(hidden.myGuess).toBeNull(); expect(hidden.results.every((p: any) => p.rounds.length === round - 1)).toBe(true);
        await ok(clients[i * 8].socket, 'location:room:answer', input);
        for (const seat of clients.slice(i * 8 + 1, i * 8 + 8)) await ok(seat.socket, 'location:room:answer', { ...input, requestId: randomUUID() });
      }));
      if (round === 1) {
        children[0].kill(); await new Promise<void>(resolve => children[0].once('exit', () => resolve()));
        for (let i = 0; i < clients.length; i += 2) { const old = clients[i]; clients[i] = await connect(ports[1], old.ip, old.cookie); const view = await ok(clients[i].socket, 'location:room:state', { roomId: roomIds[Math.floor(i / 8)] }); expect(view.results[0].rounds).toHaveLength(1); }
      }
    }
    const rooms = await Promise.all(roomIds.map(getLocationRoom)); expect(rooms.every(room => room.status === 'finished')).toBe(true);
    // Concurrent outbox retry is safe even while the surviving worker persists results.
    for (const room of rooms) await flushResult(room.gameId);
    const ids = rooms.map(room => room.gameId); const rows = await db('location_results').whereIn('game_id', ids).select();
    expect(rows).toHaveLength(160); expect(rows.every(row => Number(row.score) === 25000 && JSON.parse(row.payload).rank === 1 && !JSON.parse(row.payload).retired)).toBe(true);
    console.log(JSON.stringify({ drill: '20 rooms × 8 seats', processes: 2, processKilledAfterRound: 1, reconnectedSeats: 80, rounds: 5, uniqueResults: rows.length, elapsedMs: Date.now() - began }));
  }, 180000);
  it('quick-matches exactly two seats and recovers a timeout/retirement without exposing an early guess', async () => {
    const a = await connectUser('192.0.2.100'); const b = await connectUser('192.0.2.101');
    expect((await ok(a.socket, 'location:match:join', { difficulty: 'easy' })).queued).toBe(true);
    const matched = await ok(b.socket, 'location:match:join', { difficulty: 'easy' }); roomIds.push(matched.room.id); expect(matched.room.players).toHaveLength(2); expect(matched.room.duration).toBe(120);
    await waitFor(async () => (await getLocationRoom(matched.room.id)).status === 'playing');
    b.socket.disconnect();
    await waitFor(async () => !(await getLocationRoom(matched.room.id)).players.find(p => publicPlayerKey(matched.room.gameId, p.identity.key) === matched.room.me)!.connected);
    await withKeyLock(`location:room:${matched.room.id}`, async () => { const room = await getLocationRoom(matched.room.id); const gone = room.players.find(p => publicPlayerKey(room.gameId, p.identity.key) === matched.room.me)!; gone.connected = false; gone.disconnectAt = Date.now() - 1; room.endsAt = Date.now() - 1; await saveRoom(room); });
    await waitFor(async () => (await getLocationRoom(matched.room.id)).status === 'round_over');
    const view = await ok(a.socket, 'location:room:state', { roomId: matched.room.id }); expect(view.players.find((p: any) => p.key === matched.room.me).retired).toBe(true); expect(view.results.every((p: any) => p.rounds[0].score === 0)).toBe(true);
    await ok(a.socket, 'location:room:leave', { roomId: matched.room.id }); expect((await getLocationRoom(matched.room.id)).status).toBe('cancelled');
  }, 20000);
  it('requires a bound and verified email, refreshes verification on the same connection, and keeps cancellation available', async () => {
    const guest = await connect(ports[1], '192.0.2.110');
    const unbound = await connectUser('192.0.2.111', false, false);
    const unverified = await connectUser('192.0.2.112', false);
    for (const client of [guest, unbound, unverified]) {
      expect(await emit(client.socket, 'location:match:join', { difficulty: 'easy' })).toMatchObject({ ok: false, code: 'EMAIL_VERIFICATION_REQUIRED' });
    }
    await db('users').where({ id: unverified.id }).update({ email_verified_at: new Date().toISOString() });
    expect((await ok(unverified.socket, 'location:match:join', { difficulty: 'easy' })).queued).toBe(true);
    await db('users').where({ id: unverified.id }).update({ email_verified_at: null });
    expect(await emit(unverified.socket, 'location:match:join', { difficulty: 'easy' })).toMatchObject({ ok: false, code: 'EMAIL_VERIFICATION_REQUIRED' });
    expect(await redis()!.zScore(redisKey('location:queue:easy'), `u:${unverified.id}`)).toBeNull();
    await ok(unverified.socket, 'location:match:cancel', { difficulty: 'easy' });
  });
  it('rejects restricted matchmaking, rechecks queued candidates, and still allows friend rooms', async () => {
    const restricted = await connectUser('192.0.2.115');
    const eligible = await connectUser('192.0.2.116');
    await db('users').where({ id: restricted.id }).update({ matchmaking_restricted: true });
    expect(await emit(restricted.socket, 'location:match:join', { difficulty: 'normal' })).toMatchObject({ ok: false, code: 'MATCHMAKING_RESTRICTED' });
    const friend = await ok(restricted.socket, 'location:room:create', { difficulty: 'normal', duration: 120 });
    roomIds.push(friend.id);
    await ok(restricted.socket, 'location:room:leave', { roomId: friend.id });
    await db('users').where({ id: restricted.id }).update({ matchmaking_restricted: false });
    expect((await ok(restricted.socket, 'location:match:join', { difficulty: 'normal' })).queued).toBe(true);
    await db('users').where({ id: restricted.id }).update({ matchmaking_restricted: true });
    expect((await ok(eligible.socket, 'location:match:join', { difficulty: 'normal' })).queued).toBe(true);
    expect(await redis()!.zRange(redisKey('location:queue:normal'), 0, -1)).toEqual([`u:${eligible.id}`]);
    await ok(eligible.socket, 'location:match:cancel', { difficulty: 'normal' });
  });
  it('removes an opponent whose verification was revoked while queued instead of starting a game', async () => {
    const stale = await connectUser('192.0.2.113');
    const eligible = await connectUser('192.0.2.114');
    expect((await ok(stale.socket, 'location:match:join', { difficulty: 'hard' })).queued).toBe(true);
    await db('users').where({ id: stale.id }).update({ email_verified_at: null });
    expect((await ok(eligible.socket, 'location:match:join', { difficulty: 'hard' })).queued).toBe(true);
    expect(await redis()!.zRange(redisKey('location:queue:hard'), 0, -1)).toEqual([`u:${eligible.id}`]);
    expect(await redis()!.get(redisKey(`location:room-owner:u:${stale.id}`))).toBeNull();
    await ok(eligible.socket, 'location:match:cancel', { difficulty: 'hard' });
  });
});
