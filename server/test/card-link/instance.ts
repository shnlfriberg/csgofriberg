import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { initRedis, duplicateRedisClient, closeRedis } from "../../src/redis";
import { initPlayerCache } from "../../src/services/playerCache";
import { setupSocket } from "../../src/socket";
import { setupCardSocket } from "../../src/card-link/socket";
import cardRoutes from "../../src/card-link/routes";
import { errorHandler } from "../../src/middleware/common";
import { requirePow } from "../../src/middleware/pow";
import { db } from "../../src/db/knex";

async function main() {
  await initRedis();
  await initPlayerCache();
  const publisher = duplicateRedisClient("card-drill-pub")!,
    subscriber = duplicateRedisClient("card-drill-sub")!;
  await Promise.all([publisher.connect(), subscriber.connect()]);
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/card-link", requirePow, cardRoutes);
  app.use(errorHandler);
  const server = http.createServer(app),
    io = new Server(server);
  io.adapter(createAdapter(publisher, subscriber));
  const stopCommon = setupSocket(io),
    stopCard = setupCardSocket(io);
  server.listen(0, "127.0.0.1", () =>
    process.send?.({ port: (server.address() as { port: number }).port }),
  );
  process.on("message", async (message) => {
    if (message !== "stop") return;
    io.disconnectSockets(true);
    await stopCard();
    await stopCommon();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await Promise.all([publisher.close(), subscriber.close()]);
    await closeRedis();
    await db.destroy();
    process.exit(0);
  });
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
