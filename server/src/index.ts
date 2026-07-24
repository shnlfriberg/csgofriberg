import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config, validateProductionConfig } from './config';
import { assertDatabaseReady } from './db/ready';
import { db } from './db/knex';
import { errorHandler } from './middleware/common';
import authRoutes from './routes/auth';
import playerRoutes from './routes/players';
import gameRoutes from './routes/game';
import statsRoutes from './routes/stats';
import leaderboardRoutes from './routes/leaderboard';
import announcementRoutes from './routes/announcements';
import adminRoutes from './routes/admin';
import { setupSocket } from './socket';
import {
  closeRedis,
  duplicateRedisClient,
  initRedis,
  isRedisAvailable,
  isRedisTimeoutError,
} from './redis';
import { initPlayerCache } from './services/playerCache';
import { rateLimit } from './middleware/rateLimit';
import { initMatchResultWorker } from './services/matchResultQueue';
import powRoutes from './routes/pow';
import { requirePow } from './middleware/pow';
import { closePasswordWorkers } from './services/password';
import { getRuntimeSnapshot, startRuntimeMonitor } from './services/runtimeMonitor';
import { requireAdmin, requireAuth } from './middleware/auth';
import { parseJsonOnce, rejectOversizedBody } from './middleware/jsonBody';
import { rejectMissingClientAsset, setClientAssetCacheHeaders } from './middleware/clientAssets';
import { injectUmamiScript } from './services/umami';

const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('unhandledRejection', (reason) => {
  if (isRedisTimeoutError(reason)) {
    console.error('[server:redis-timeout-unhandled]', reason);
    return;
  }
  console.error('[server:unhandled-rejection]', reason);
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
        reject(new Error('SHUTDOWN_TIMEOUT'));
      } catch (err) {
        reject(err);
      }
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function main() {
  validateProductionConfig();
  const stopRuntimeMonitor = startRuntimeMonitor();
  console.log('[server] 正在验证数据库结构');
  await assertDatabaseReady();
  console.log('[server] 数据库结构验证通过');
  const redisReady = await initRedis();
  await initPlayerCache();
  const stopMatchWorker = redisReady ? await initMatchResultWorker() : async () => undefined;

  const app = express();
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...(config.umami ? [config.umami.origin] : [])],
        workerSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...config.corsOrigins, ...(config.umami ? [config.umami.origin] : [])],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use((req, res, next) => {
    if (shuttingDown) return res.status(503).json({ code: 'SERVER_SHUTTING_DOWN' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !config.corsOrigins.includes(origin)) {
        return res.status(403).json({ code: 'INVALID_ORIGIN' });
      }
    }
    next();
  });
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      redis: isRedisAvailable() ? 'up' : 'degraded',
      features: { leaderboard: config.showLeaderboard },
      runtime: getRuntimeSnapshot(),
    })
  );
  app.use('/api', rateLimit({ name: 'api', limit: 600, windowSeconds: 60 }));
  app.use('/api/pow', rejectOversizedBody(16 * 1024), parseJsonOnce('16kb'));
  app.use('/api/pow', powRoutes);
  app.use('/api', requirePow);
  app.use('/api/admin/players/import', requireAuth, requireAdmin);
  app.use(
    '/api/admin/players/import',
    rejectOversizedBody(config.adminImportBodyLimitBytes),
    parseJsonOnce(`${config.adminImportBodyLimitBytes}b`)
  );
  app.use('/api', rejectOversizedBody(64 * 1024), parseJsonOnce('64kb'));

  app.use('/api/auth', authRoutes);
  app.use('/api/players', playerRoutes);
  app.use('/api/game', gameRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/admin', adminRoutes);

  // 生产环境托管前端构建产物
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    const indexHtml = injectUmamiScript(
      fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8'),
      config.umami
    );
    app.use(express.static(clientDist, { index: false, setHeaders: setClientAssetCacheHeaders }));
    app.use(rejectMissingClientAsset);
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml);
    });
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigins, credentials: true } });
  app.set('io', io);
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let adapterPubClient: ReturnType<typeof duplicateRedisClient> = null;
  let adapterSubClient: ReturnType<typeof duplicateRedisClient> = null;
  io.use((_socket, next) => {
    if (shuttingDown) return next(new Error('SERVER_SHUTTING_DOWN'));
    next();
  });
  if (redisReady) {
    adapterPubClient = duplicateRedisClient('socket-adapter-pub');
    adapterSubClient = duplicateRedisClient('socket-adapter-sub');
    if (adapterPubClient && adapterSubClient) {
      await Promise.all([adapterPubClient.connect(), adapterSubClient.connect()]);
      io.adapter(createAdapter(adapterPubClient, adapterSubClient));
    }
  }
  const stopSocket = setupSocket(io);

  server.listen(config.port, () => {
    console.log(`[server] 弗一把服务已启动: http://localhost:${config.port}`);
    console.log(`[server] allowed origins: ${config.corsOrigins.join(', ')}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      console.log(`[server] 收到 ${signal},开始优雅退出`);
      stopRuntimeMonitor();
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      const socketClosed = new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([
        withTimeout(serverClosed, SHUTDOWN_TIMEOUT_MS, () => server.closeAllConnections?.()),
        withTimeout(socketClosed, SHUTDOWN_TIMEOUT_MS, () => io.disconnectSockets(true)),
        withTimeout(stopMatchWorker(), SHUTDOWN_TIMEOUT_MS, () => undefined),
      ]);
      await withTimeout(stopSocket(), SHUTDOWN_TIMEOUT_MS, () => undefined).catch((err) => {
        console.error('[shutdown:socket-drain]', err);
      });

      await Promise.allSettled([
        withTimeout(
          adapterPubClient?.isOpen ? adapterPubClient.quit().then(() => undefined) : Promise.resolve(),
          SHUTDOWN_TIMEOUT_MS,
          () => undefined
        ),
        withTimeout(
          adapterSubClient?.isOpen ? adapterSubClient.quit().then(() => undefined) : Promise.resolve(),
          SHUTDOWN_TIMEOUT_MS,
          () => undefined
        ),
        withTimeout(closeRedis(), SHUTDOWN_TIMEOUT_MS, () => undefined),
        withTimeout(closePasswordWorkers(), SHUTDOWN_TIMEOUT_MS, () => undefined),
        withTimeout(db.destroy(), SHUTDOWN_TIMEOUT_MS, () => undefined),
      ]);
      console.log('[server] 优雅退出完成');
    })();
    return shutdownPromise;
  };
  const handleSignal = (signal: string) => {
    const forceExitTimer = setTimeout(() => {
      console.error('[server] 优雅退出超时,强制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS * 2 + 2_000);
    void shutdown(signal)
      .then(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(forceExitTimer);
        console.error('[server] 优雅退出失败:', err);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
