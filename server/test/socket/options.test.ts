import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { socketAdapterOptions, socketServerOptions } from '../../src/socket/options';
import { config } from '../../src/config';
import { initRedis, duplicateRedisClient, closeRedis } from '../../src/redis';

const require = createRequire(import.meta.url);
const enginePath = require.resolve('engine.io', { paths: [require.resolve('socket.io')] });
const WebSocket = require(require.resolve('ws', { paths: [enginePath] }));
const cookie = () => `csgofriberg_guest=${jwt.sign({ typ: 'guest', key: randomUUID() }, config.jwtSecret, { expiresIn: '1h' })}`;
const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)));
const close = (io: Server) => new Promise<void>(resolve => io.close(() => resolve()));
const sockets: Socket[] = [];
const connected = async (base: string) => {
  const socket = connect(base, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie() } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
};
function raw(base: string, headers: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket', { headers });
    socket.once('message', () => resolve(socket)); socket.on('error', reject);
  });
}

describe('Engine.IO admission before namespace authentication', () => {
  it('rejects missing identity and foreign Origin, and caps unfinished handshakes', async () => {
    const server = http.createServer(), io = new Server(server, socketServerOptions()), base = await listen(server);
    const raws: any[] = [];
    try {
      await expect(raw(base, {})).rejects.toThrow();
      await expect(raw(base, { Cookie: cookie(), Origin: 'https://untrusted.invalid' })).rejects.toThrow();
      expect(io.engine.clientsCount).toBe(0);
      for (let i = 0; i < 20; i++) raws.push(await raw(base, { Cookie: cookie() }));
      expect(io.engine.clientsCount).toBe(20);
      await expect(raw(base, { Cookie: cookie() })).rejects.toThrow();
      raws.forEach(socket => socket.terminate());
      await vi.waitFor(() => expect(io.engine.clientsCount).toBe(0));
      const released = await raw(base, { Cookie: cookie() }); raws.push(released);
      expect(io.engine.clientsCount).toBe(1);
    } finally { raws.forEach(socket => socket.terminate()); await close(io); }
  });
  it('bounds incoming frame size and closes unfinished namespaces', async () => {
    const options = socketServerOptions();
    expect(options.maxHttpBufferSize).toBe(65536); expect(options.connectTimeout).toBe(5000);
    const server = http.createServer(), io = new Server(server, { ...options, connectTimeout: 100 });
    const base = await listen(server), pending = await raw(base, { Cookie: cookie() });
    try {
      await new Promise<void>(resolve => pending.once('close', resolve));
      const client = await connected(base);
      const disconnected = new Promise<void>(resolve => client.once('disconnect', () => resolve()));
      client.emit('unknown', 'x'.repeat(70_000)); await disconnected;
      expect(client.connected).toBe(false);
    } finally { pending.terminate(); await close(io); }
  });
});

describe('Redis adapter deployment boundaries', () => {
  beforeAll(async () => { await initRedis(); });
  afterAll(async () => { sockets.forEach(socket => socket.disconnect()); await closeRedis(); });
  it('delivers and disconnects within a deployment without crossing a channel prefix', async () => {
    const servers: Server[] = [], clients: any[] = [];
    const shared = socketAdapterOptions();
    expect(shared.key).toBe(`${config.redisPrefix}socket.io`);
    async function instance(key: string) {
      const publisher = duplicateRedisClient('audit-isolation-pub')!, subscriber = duplicateRedisClient('audit-isolation-sub')!;
      clients.push(publisher, subscriber); await Promise.all([publisher.connect(), subscriber.connect()]);
      const server = http.createServer(), io = new Server(server, socketServerOptions()); servers.push(io);
      io.adapter(createAdapter(publisher, subscriber, { ...shared, key }));
      io.on('connection', socket => socket.join('identity:u:7'));
      return { io, base: await listen(server) };
    }
    try {
      const a = await instance(shared.key), b = await instance(`${shared.key}:other`), c = await instance(shared.key);
      const isolated = await connected(b.base), same = await connected(c.base), receive = vi.fn();
      isolated.on('audit:event', receive);
      const delivered = new Promise<void>(resolve => same.once('audit:event', () => resolve()));
      a.io.to('identity:u:7').emit('audit:event', { synthetic: true }); await delivered;
      const disconnected = new Promise<void>(resolve => same.once('disconnect', () => resolve()));
      a.io.in('identity:u:7').disconnectSockets(true); await disconnected;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(isolated.connected).toBe(true); expect(receive).not.toHaveBeenCalled();
    } finally { await Promise.all(servers.map(close)); await Promise.all(clients.map(client => client.close())); }
  });
});
