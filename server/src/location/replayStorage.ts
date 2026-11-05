import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { ReplayRecord, GameState } from './types';

// Content addressed immutable snapshots retain the exact map used for scoring.
// Old JSON records stay untouched and continue to decode as before.
export async function encodeReplay(record: ReplayRecord | GameState, connection: Knex = db): Promise<string> {
  const snapshots = new Map<string, string>();
  const snapshot = async (value: unknown) => {
    const payload = JSON.stringify(value);
    const hash = createHash('sha256').update(payload).digest('hex');
    snapshots.set(hash, payload);
    return { $locationSnapshot: hash };
  };
  const pack = async (value: any): Promise<any> => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map(pack));
    if (value.calibration && value.floors && value.bounds) return snapshot(value);
    const entries = [];
    for (const [key, item] of Object.entries(value)) entries.push([key, await pack(item)]);
    return Object.fromEntries(entries);
  };
  const packed = await pack(record);
  if (packed.game) delete packed.game.results;
  for (const key of ['roomResults', 'participants']) if (packed[key]) packed[key] = await snapshot(packed[key]);
  const rows = [...snapshots].map(([hash, payload]) => ({ hash, payload }));
  for (let i = 0; i < rows.length; i += 100) await connection('location_replay_snapshots').insert(rows.slice(i, i + 100)).onConflict('hash').ignore();
  return JSON.stringify({ ...packed, storageVersion: 2 });
}

export async function decodeProgress(payload: string, connection: Knex = db): Promise<GameState> {
  return await decodeReplay(payload, connection) as unknown as GameState;
}

export async function decodeReplay(payload: string, connection: Knex = db): Promise<ReplayRecord> {
  const record = JSON.parse(payload);
  if (record.storageVersion !== 2) return record;
  const snapshots = new Map<string, any>();
  const references = (value: any, found: Set<string>) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$locationSnapshot === 'string') { found.add(value.$locationSnapshot); return; }
    for (const item of Object.values(value)) references(item, found);
  };
  let pending = new Set<string>();
  references(record, pending);
  // Load each reference layer in bounded batches, including nested snapshots.
  while (pending.size) {
    const hashes = [...pending];
    pending = new Set();
    for (let i = 0; i < hashes.length; i += 100) {
      const batch = hashes.slice(i, i + 100);
      const rows = await connection('location_replay_snapshots').whereIn('hash', batch).select('hash', 'payload');
      for (const row of rows) snapshots.set(row.hash, JSON.parse(row.payload));
      for (const hash of batch) {
        if (!snapshots.has(hash)) throw new Error(`LOCATION_REPLAY_SNAPSHOT_MISSING:${hash}`);
        references(snapshots.get(hash), pending);
      }
    }
    for (const hash of snapshots.keys()) pending.delete(hash);
  }
  const cache = new Map<string, any>();
  const unpack = (value: any, path = new Set<string>()): any => {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.$locationSnapshot === 'string') {
      const hash = value.$locationSnapshot;
      if (path.has(hash)) throw new Error(`LOCATION_REPLAY_SNAPSHOT_CYCLE:${hash}`);
      if (!cache.has(hash)) cache.set(hash, unpack(snapshots.get(hash), new Set([...path, hash])));
      return cache.get(hash);
    }
    if (Array.isArray(value)) return value.map(item => unpack(item, path));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item, path)]));
  };
  const result = await unpack(record);
  delete result.storageVersion;
  if (result.game) result.game.results = result.results;
  return result;
}
