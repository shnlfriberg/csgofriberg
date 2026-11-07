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
import { getLocationRoom, saveRoom, flushResult } from '../../src/location/rooms';
import { withKeyLock } from '../../src/location/lock';
import { publicPlayerKey } from '../../src/location/publicIdentity';
import { seedLocationFixtures } from './database';

describe('location multiplayer across two actual server processes', () => {
  const children: ChildProcess[] = []; const sockets: Socket[] = []; const roomIds: string[] = []; const clients: Array<{ socket: Socket; cookie: string; ip: string }> = [];
  const rematchRoomIds: string[] = [];
  let ports: number[] = []; let clean: () => Promise<void>; const agent = 'location-drill-test';
  const userIds: number[] = [];
  async function connectUser(ip: string, verified = true, hasEmail = true) {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 20);
    const inserted = await db('users').insert({ username: `loc_${suffix}`, password_hash: 'unused', email: hasEmail ? `${suffix}@example.com` : null, email_verified_at: verified ? new Date().toISOString() : null }).returning('id');
    const id = Number(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
    userIds.push(id);
    // No PoW cookie: sockets are not PoW-gated by design.
    return { ...await connect(ports[1], ip, `csgofriberg_session=${signToken({ id, token_version: 0 })}`), id };
  }
  async function instance() {
    const child = fork(path.resolve(__dirname, 'instance.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, JWT_SECRET: config.jwtSecret, TRUST_PROXY: 'true' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
    child.stderr?.on('data', data => { const text = String(data); if (!text.includes('ExperimentalWarning')) process.stderr.write(text); });
    return new Promise<number>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('INSTANCE_START_TIMEOUT')), 15000); child.once('message', (message: any) => { clearTimeout(timeout); resolve(message.port); }); child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(`INSTANCE_EXIT:${code}`)); }); });
  }
  async function connect(port: number, ip: string, cookie?: string) {
    cookie ||= `csgofriberg_guest=${jwt.sign({ key: `location-test-socket-${randomUUID()}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`;
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
    for (const id of [...roomIds, ...rematchRoomIds]) { const room = await getLocationRoom(id).catch(() => null); if (room) { await redis()!.del(redisKey(`location:room:${id}`)); await redis()!.zRem(redisKey('location:rooms'), id); await redis()!.zRem(redisKey('location:outbox'), room.gameId); for (const p of room.players) await redis()!.del(redisKey(`location:room-owner:${p.identity.key}`)); } }
    await clean();
    await db('users').whereIn('id', userIds).delete();
  }, 45000);
  it('collects three rematch votes across instances, supports withdrawal, resets the game and preserves the old results', async () => {
    const seats = await Promise.all([connect(ports[0], '192.0.2.231'), connect(ports[1], '192.0.2.232'), connect(ports[1], '192.0.2.233')]);
    for (const seat of seats) await ok(seat.socket, 'room-kernel:hello', { protocols: { location: 2 } });
    const created = await ok(seats[0].socket, 'location:room:create', { difficulty: 'normal', duration: 120 });
    rematchRoomIds.push(created.id);
    for (const seat of seats.slice(1)) await ok(seat.socket, 'location:room:join', { roomId: created.id });
    for (const seat of seats) await ok(seat.socket, 'location:room:ready', { roomId: created.id, ready: true });
    await ok(seats[0].socket, 'location:room:start', { roomId: created.id });
    await withKeyLock(`location:room:${created.id}`, async () => {
      const room = await getLocationRoom(created.id);
      room.status = 'finished'; room.round = 5; room.startsAt = room.endsAt = room.nextAt = null;
      room.players.forEach(p => { p.guesses = Array(5).fill(null); });
      await saveRoom(room);
    });
    const old = await getLocationRoom(created.id);
    const vote = (index: number, wanted: boolean) => ok(seats[index].socket, 'location:room:rematch', { roomId: old.id, gameId: old.gameId, wanted });
    const received = new Promise<any>(resolve => seats[1].socket.once('room-kernel:patch', resolve));
    await vote(0, true);
    const patch = await received;
    expect(patch.sections.rematch.acceptedKeys).toHaveLength(1);
    expect(patch.sections.rematch.requiredKeys).toHaveLength(3);
    expect(JSON.stringify(patch.sections.rematch)).not.toContain('g:');
    await vote(0, false);
    expect((await getLocationRoom(old.id)).rematch?.acceptedKeys).toEqual([]);
    await vote(0, true); await vote(1, true);
    expect((await getLocationRoom(old.id)).status).toBe('finished');
    const restarted = new Promise<any>(resolve => seats[0].socket.once('location:room', resolve));
    await vote(2, true);
    const nextView = await restarted, next = await getLocationRoom(old.id);
    expect(nextView).toMatchObject({ protocol: 2, id: old.id, status: 'preparing', round: 1, myGuess: null });
    expect(nextView.gameId).not.toBe(old.gameId);
    expect(nextView.results.every((p: any) => p.rounds.length === 0)).toBe(true);
    expect(next.players.every(p => p.ready && !p.retired && p.guesses.length === 0 && Object.keys(p.requests).length === 0)).toBe(true);
    expect(next.duration).toBe(old.duration); expect(next.difficulty).toBe(old.difficulty);
    expect(await emit(seats[0].socket, 'location:room:rematch', { roomId: old.id, gameId: old.gameId, wanted: true }))
      .toMatchObject({ ok: false, code: 'REMATCH_NOT_AVAILABLE' });
    await flushResult(old.gameId);
    expect(await db('location_results').where({ game_id: old.gameId }).count('* as count').first()).toMatchObject({ count: 3 });
    for (const seat of seats) await ok(seat.socket, 'location:room:leave', { roomId: old.id });
  }, 25000);
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
        const input = { roomId: id, gameId: room.gameId, mapId: q.mapId, floorId: q.floorId, u: q.u, v: q.v, round, version: round, requestId: randomUUID() };
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
  it('keeps a seat bound to the identity: other tabs neither steal it nor drop it', async () => {
    const game = await connect(ports[1], '192.0.2.120');
    const room = await ok(game.socket, 'location:room:create', { difficulty: 'normal', duration: 120 }); roomIds.push(room.id);
    const seat = async () => (await getLocationRoom(room.id)).players[0];
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    // Another page of the site opens a second socket and closes it again.
    const other = await connect(ports[1], game.ip, game.cookie);
    await pause(400);
    expect((await seat()).connected).toBe(true);
    other.socket.disconnect();
    await pause(800);
    expect((await seat()).connected).toBe(true);
    expect((await seat()).disconnectAt).toBeNull();
    // The game tab still acts as the seat after the other tab came and went.
    expect((await emit(game.socket, 'location:room:ready', { roomId: room.id, ready: true })).ok).toBe(true);
    // Closing the game tab while another tab stays open keeps the seat online.
    const keeper = await connect(ports[1], game.ip, game.cookie);
    game.socket.disconnect();
    await pause(800);
    expect((await seat()).connected).toBe(true);
    // Closing the last socket starts the 30 s grace.
    keeper.socket.disconnect();
    await waitFor(async () => !(await seat()).connected);
    expect((await seat()).disconnectAt).toBeGreaterThan(Date.now());
  }, 30000);
  it('enforces one multiplayer seat across classic rooms and 图寻 rooms', async () => {
    const client = await connect(ports[1], '192.0.2.121');
    const room = await ok(client.socket, 'location:room:create', { difficulty: 'easy', duration: 60 }); roomIds.push(room.id);
    const classic = await emit(client.socket, 'room:create', { dbType: 'normal' });
    expect(classic).toMatchObject({ code: 'ALREADY_IN_ROOM', occupied: { game: 'location', roomId: room.id } });
    const second = await emit(client.socket, 'location:room:create', { difficulty: 'easy', duration: 60 });
    expect(second).toMatchObject({ ok: false, code: 'LOCATION_ALREADY_IN_ROOM', occupied: { game: 'location', roomId: room.id } });
    await ok(client.socket, 'location:room:leave', { roomId: room.id });
    // A seat in an active classic room blocks 图寻 rooms (kernel claim script reads classic hot state).
    const identity = `g:${(jwt.decode(client.cookie.split('=')[1]) as { key: string }).key}`;
    const classicId = 'KZZZZ';
    const r = redis()!;
    await r.hSet(redisKey(`room:${classicId}:meta`), { status: 'waiting' });
    await r.hSet(redisKey(`room:${classicId}:players`), identity, JSON.stringify({ key: identity, eliminated: false }));
    await r.set(redisKey(`identity-room:${identity}`), classicId, { EX: 600 });
    try {
      const blocked = await emit(client.socket, 'location:room:create', { difficulty: 'easy', duration: 60 });
      expect(blocked).toMatchObject({ ok: false, code: 'LOCATION_ALREADY_IN_ROOM', occupied: { game: 'classic', roomId: classicId } });
      await r.hSet(redisKey(`room:${classicId}:meta`), { status: 'finished' });
      const allowed = await ok(client.socket, 'location:room:create', { difficulty: 'easy', duration: 60 }); roomIds.push(allowed.id);
      expect(await r.get(redisKey(`identity-room:${identity}`))).toBe(`location|${allowed.id}`);
      await ok(client.socket, 'location:room:leave', { roomId: allowed.id });
      expect(await r.get(redisKey(`identity-room:${identity}`))).toBeNull();
    } finally {
      await r.del([redisKey(`room:${classicId}:meta`), redisKey(`room:${classicId}:players`), redisKey(`identity-room:${identity}`)]);
    }
  }, 20000);
  it('negotiates protocol v2: compact acknowledgements and patches without the map catalogue', async () => {
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const host = await connect(ports[1], '192.0.2.122'); const guest = await connect(ports[1], '192.0.2.122');
    for (const seat of [host, guest]) expect(await emit(seat.socket, 'room-kernel:hello', { protocols: { location: 2 } })).toMatchObject({ ok: true, protocols: { location: 2 } });
    const created = await ok(host.socket, 'location:room:create', { difficulty: 'normal', duration: 60 }); roomIds.push(created.id);
    expect(created.protocol).toBe(2);
    const patches: any[] = []; const full: any[] = [];
    guest.socket.on('room-kernel:patch', patch => patches.push(patch)); guest.socket.on('location:room', view => full.push(view));
    const joined = await ok(guest.socket, 'location:room:join', { roomId: created.id });
    for (const seat of [host, guest]) expect(await ok(seat.socket, 'location:room:ready', { roomId: created.id, ready: true })).toEqual({ revision: expect.any(Number) });
    await ok(host.socket, 'location:room:start', { roomId: created.id });
    await waitFor(async () => patches.some(patch => patch.sections.status === 'preparing'));
    await pause(200);
    expect(full).toHaveLength(0);
    const revisions = patches.map(patch => patch.rev);
    expect(revisions[0]).toBe(joined.revision + 1);
    expect(revisions.every((rev, index) => index === 0 || rev === revisions[index - 1] + 1)).toBe(true);
    const starting = patches.find(patch => patch.sections.status === 'preparing');
    expect(starting.sections.maps.length).toBeGreaterThan(0);
    expect(patches.filter(patch => patch.sections.maps).length).toBe(1);
    const state = await ok(guest.socket, 'location:room:state', { roomId: created.id, mapsHash: starting.sections.mapsHash });
    expect(state).not.toHaveProperty('maps');
    await ok(host.socket, 'location:room:leave', { roomId: created.id }); await ok(guest.socket, 'location:room:leave', { roomId: created.id });
  }, 20000);
});
