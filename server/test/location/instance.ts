// A real application process for the Redis two-instance regression drill.
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { socketAdapterOptions, socketServerOptions } from '../../src/socket/options';
import { initRedis, duplicateRedisClient, closeRedis } from '../../src/redis';
import { initPlayerCache } from '../../src/services/playerCache';
import { setupSocket } from '../../src/socket';
import { setupLocationSocket } from '../../src/location/rooms';
import { db } from '../../src/db/knex';

async function main() {
  await initRedis(); await initPlayerCache();
  const publisher = duplicateRedisClient('location-drill-pub')!; const subscriber = duplicateRedisClient('location-drill-sub')!;
  await Promise.all([publisher.connect(), subscriber.connect()]);
  const server = http.createServer(); const io = new Server(server, socketServerOptions());
  io.adapter(createAdapter(publisher, subscriber, socketAdapterOptions())); const stopCommon = setupSocket(io); const stopLocation = setupLocationSocket(io);
  server.listen(0, '127.0.0.1', () => process.send?.({ port: (server.address() as any).port }));
  process.on('message', async message => {
    if (message !== 'stop') return;
    io.disconnectSockets(true); await stopLocation(); await stopCommon();
    await new Promise<void>(resolve => io.close(() => resolve())); await Promise.all([publisher.close(), subscriber.close()]); await closeRedis(); await db.destroy(); process.exit(0);
  });
}
void main().catch(error => { console.error(error); process.exit(1); });
