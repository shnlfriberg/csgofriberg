import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { db } from '../../db/knex';
import { assertDatabaseReady } from '../../db/ready';
import { initRedis, redis, redisKey, closeRedis } from '../../redis';
import { assetDirectory, assetPath } from '../assets';
import { locationDataCounts, resetLocationDatabase } from './reset';

const workspace = path.resolve(__dirname, '../../../..');
const databaseFile = path.resolve(workspace, 'server', config.dbUrl);

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

async function main() {
  const profile = JSON.parse(await fs.readFile(path.join(workspace, 'config/local-profile.json'), 'utf8'));
  const expectedDatabase = path.resolve(workspace, profile.database);
  const expectedAssets = path.resolve(workspace, profile.assets);
  for (const target of [expectedDatabase, expectedAssets]) {
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('LOCAL_RESET_ONLY: profile paths must stay inside the workspace.');
  }
  const localRedis = new URL(profile.redisUrl);
  if (localRedis.protocol !== 'redis:' || localRedis.hostname !== '127.0.0.1' || Number(localRedis.port) !== profile.redisPort || !profile.redisPrefix)
    throw new Error('LOCAL_RESET_ONLY: Redis must be the loopback service in the local profile.');
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--apply', '--check', '--keep-maps'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--check'))
  ) {
    throw new Error(
      'Usage: pnpm --filter server location:reset-local [--check | --apply] [--keep-maps]'
    );
  }
  if (
    process.env.NODE_ENV === 'production' ||
    config.dbClient !== 'sqlite' ||
    databaseFile.toLowerCase() !== expectedDatabase.toLowerCase() ||
    assetDirectory.toLowerCase() !== expectedAssets.toLowerCase() ||
    config.redisUrl !== profile.redisUrl ||
    config.redisPrefix !== profile.redisPrefix
  ) {
    throw new Error(
      'LOCAL_RESET_ONLY: use the workspace SQLite, assets and local Redis configuration.'
    );
  }
  await assertDatabaseReady();
  const preserveMaps = args.includes('--keep-maps');
  const before = await locationDataCounts(db);
  console.log(JSON.stringify({ preserveMaps, before }, null, 2));
  if (!args.includes('--apply')) return;
  if ((await portInUse(profile.apiPort)) || (await portInUse(profile.webPort)))
    throw new Error(
      'Stop the local server and client before applying the reset. Keep Redis running.'
    );
  if (!(await initRedis()))
    throw new Error(
      'Local Redis must be running to back up and clear location state.'
    );
  const client = redis()!;
  const keys: string[] = [];
  for await (const batch of client.scanIterator({
    MATCH: redisKey('location:*'),
    COUNT: 100,
  }))
    keys.push(...batch);
  const cache = [];
  for (const key of keys) {
    const type = await client.type(key);
    const ttl = await client.pTTL(key);
    if (type === 'none') continue;
    if (type !== 'string' && type !== 'zset')
      throw new Error(`Unsupported cache type: ${type}`);
    cache.push({
      key,
      type,
      ttl,
      value:
        type === 'string'
          ? await client.get(key)
          : await client.zRangeWithScores(key, 0, -1),
    });
  }
  const backup = path.join(
    workspace,
    '.local-data/backups',
    `location-reset-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  );
  // Both move targets are resolved, fixed workspace paths; never follow a configured external asset directory.
  const assetStats = await fs.lstat(assetDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (assetStats?.isSymbolicLink())
    throw new Error('Refusing to move a linked asset directory.');
  // Keep uploaded radar assets referenced by any retained map version, not just the latest map.
  const preservedAssets = new Set<string>();
  if (preserveMaps) {
    const records = [
      ...(await db('location_maps').select('payload')),
      ...(await db('location_versions').where('key', 'like', 'map:%').select('payload')),
    ];
    const visit = (value: unknown) => {
      if (typeof value === 'string' && value.startsWith('/location-assets/'))
        preservedAssets.add(path.basename(assetPath(value)));
      else if (value && typeof value === 'object')
        Object.values(value).forEach(visit);
    };
    records.forEach((record) => visit(JSON.parse(record.payload)));
    for (const filename of preservedAssets) {
      const stat = await fs.lstat(path.join(assetDirectory, filename));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Invalid retained radar asset: ${filename}`);
    }
  }
  await fs.mkdir(backup, { recursive: true });
  await db.raw('VACUUM INTO ?', [path.join(backup, 'database.sqlite3')]);
  await fs.writeFile(
    path.join(backup, 'location-redis.json'),
    JSON.stringify(cache)
  );
  await fs.writeFile(
    path.join(backup, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        before,
        databaseFile,
        assetDirectory,
        preserveMaps,
        preservedAssets: [...preservedAssets],
      },
      null,
      2
    )
  );
  const archivedAssets = path.join(backup, 'assets');
  if (assetStats) await fs.rename(assetDirectory, archivedAssets);
  try {
    await fs.mkdir(assetDirectory, { recursive: true });
    for (const filename of preservedAssets)
      await fs.copyFile(path.join(archivedAssets, filename), path.join(assetDirectory, filename));
    await resetLocationDatabase(db, { preserveMaps });
  } catch (error) {
    // Keep any partially restored files for diagnosis before putting the original assets back.
    if (await fs.lstat(assetDirectory).catch(() => null))
      await fs.rename(assetDirectory, path.join(backup, 'failed-restored-assets'));
    if (assetStats) await fs.rename(archivedAssets, assetDirectory);
    throw error;
  }
  if (keys.length) await client.del(keys);
  await fs.mkdir(assetDirectory, { recursive: true });
  console.log(
    JSON.stringify(
      {
        backup,
        removedRedisKeys: keys.length,
        after: await locationDataCounts(db),
      },
      null,
      2
    )
  );
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await db.destroy();
  });
