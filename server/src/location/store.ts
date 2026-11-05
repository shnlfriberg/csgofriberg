import { db } from '../db/knex';
import { config } from '../config';
import { redis, redisKey } from '../redis';
import { withKeyLock } from './lock';
import { countMetric, measured } from './metrics';
import { encodeReplay, decodeProgress } from './replayStorage';
import { archivedProgress } from './progressArchive';
import { freezeSnapshot } from './immutable';
import { locationPresenceKey } from '../services/locationPresence';
import type {
  GameState,
  Identity,
  MapDefinition,
  Question,
  QuestionSnapshot,
} from './types';

const fallback = new Map<string, { value: string; expiresAt: number }>();
function stateClient() {
  const client = redis();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  return client;
}
export async function readState<T>(key: string): Promise<T | null> {
  const client = stateClient();
  const item = fallback.get(key);
  const raw = client
    ? await client.get(redisKey(`location:${key}`))
    : item && item.expiresAt > Date.now()
      ? item.value
      : null;
  return raw ? (JSON.parse(raw) as T) : null;
}
export async function writeState(
  key: string,
  value: unknown,
  seconds = 1800
): Promise<void> {
  const raw = JSON.stringify(value);
  const client = stateClient();
  if (client)
    await client.set(redisKey(`location:${key}`), raw, { EX: seconds });
  else {
    if (fallback.size > 10000)
      for (const [id, item] of fallback)
        if (item.expiresAt < Date.now()) fallback.delete(id);
    fallback.set(key, { value: raw, expiresAt: Date.now() + seconds * 1000 });
  }
}
export async function deleteState(key: string): Promise<void> {
  const client = stateClient();
  if (client) await client.del(redisKey(`location:${key}`));
  else fallback.delete(key);
}
export async function maps(): Promise<MapDefinition[]> {
  return (await db('location_maps').select('payload'))
    .map((row) => JSON.parse(row.payload) as MapDefinition)
    .sort((a, b) => a.order - b.order);
}
export async function questions(): Promise<Question[]> {
  return (await db('location_questions').select('payload')).map(
    (row) => JSON.parse(row.payload) as Question
  );
}
export async function pool(): Promise<QuestionSnapshot[]> {
  return (await catalogSnapshot()).pool;
}
export async function catalogSnapshot(): Promise<{
  maps: MapDefinition[];
  pool: QuestionSnapshot[];
}> {
  const revision = String((await db('location_catalog_revision').where({ id: 1 }).first())?.revision ?? -1);
  if (revision !== '-1' && catalogCache?.revision === revision) { countMetric('catalog.hit'); return catalogCache.value; }
  return withKeyLock('location:catalog', () => measured('catalog.load', async () => {
    const lockedRevision = String((await db('location_catalog_revision').where({ id: 1 }).first())?.revision ?? -1);
    if (lockedRevision !== '-1' && catalogCache?.revision === lockedRevision) return catalogCache.value;
    const catalog = await maps();
    const byId = new Map(catalog.filter(m => m.enabled).map(m => [m.id, m]));
    const published = (await db('location_questions').where({ status: 'published' }).select('payload')).map(row => JSON.parse(row.payload) as Question);
    const available = published.flatMap((question) => {
      const map = byId.get(question.mapId);
      return map &&
        question.status === 'published' &&
        question.mapVersion === map.version
        ? [{ question, map }]
        : [];
    });
    const value = freezeSnapshot({ maps: catalog.filter((map) => map.enabled), pool: available });
    catalogCache = { revision: lockedRevision, value };
    return value;
  }));
}
let catalogCache: { revision: string; value: { maps: MapDefinition[]; pool: QuestionSnapshot[] } } | null = null;
export function activeGameKey(game: Pick<GameState, 'owner' | 'mode' | 'difficulty' | 'bannedMapIds'>): string {
  const bans = game.mode === 'random' ? [...(game.bannedMapIds ?? [])].sort() : [];
  return `active:${game.owner.key}:${game.mode}:${game.difficulty}${bans.length ? `:bans:${bans.join(',')}` : ''}`;
}
export async function saveGame(game: GameState): Promise<void> {
  const client = stateClient();
  if (game.mode === 'daily')
    await db('location_progress')
      .insert({
        identity_key: game.owner.key,
        date: game.date,
        difficulty: game.difficulty,
        payload: await encodeReplay(game),
      })
      .onConflict(['identity_key', 'date', 'difficulty'])
      .merge();
  const ttl = Math.max(60, Math.ceil((game.expiresAt - Date.now()) / 1000));
  if (client) {
    const batch = client.multi().set(redisKey(`location:game:${game.id}`), JSON.stringify(game), { EX: ttl });
    const index = locationPresenceKey(game.mode);
    if (game.status === 'playing' || game.status === 'ready')
      batch.zAdd(index, { score: game.expiresAt, value: game.id });
    else batch.zRem(index, game.id);
    await batch.exec();
  } else await writeState(`game:${game.id}`, game, ttl);
  if (game.status === 'playing' || game.status === 'ready')
    await writeState(
      activeGameKey(game),
      game.id,
      Math.max(60, Math.ceil((game.expiresAt - Date.now()) / 1000))
    );
}
export async function loadGame(
  id: string,
  owner: Identity
): Promise<GameState | null> {
  const cached = await readState<GameState>(`game:${id}`);
  if (cached?.owner.key === owner.key) return cached;
  const progress = await db('location_progress')
    .where({ identity_key: owner.key, game_id: id })
    .select('payload');
  for (const row of progress) {
    const game = await decodeProgress(row.payload);
    if (game.id === id) return game;
  }
  const archived = await archivedProgress(id, owner.key);
  return archived ? decodeProgress(archived) : null;
}
