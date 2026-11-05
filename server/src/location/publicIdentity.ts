import { createHmac } from 'crypto';
import { config } from '../config';
import type { ReplayRecord } from './types';

// Stable within one game, shared by all instances, never an authentication key.
export function publicPlayerKey(gameId: string, key: string): string {
  if (!key.startsWith('g:') && !key.startsWith('u:')) return key;
  return `p:${createHmac('sha256', config.guestIdSalt)
    .update(JSON.stringify(['location-player-v1', gameId, key])).digest('hex')}`;
}

export function publicReplay(record: ReplayRecord): ReplayRecord {
  const key = (value: string) => publicPlayerKey(record.gameId, value);
  // Explicit fields keep internal receipts and future storage metadata private.
  return {
    gameId: record.gameId, owner: { ...record.owner, key: key(record.owner.key) },
    mode: record.mode, difficulty: record.difficulty, difficultyMix: record.difficultyMix,
    date: record.date, totalScore: record.totalScore, results: record.results,
    scoringVersion: record.scoringVersion, game: record.game,
    rank: record.rank, retired: record.retired, roomId: record.roomId,
    myKey: record.myKey ? key(record.myKey) : undefined,
    participants: record.participants?.map(p => ({ ...p, key: key(p.key) })),
    roomResults: record.roomResults?.map(p => ({ ...p, key: key(p.key) })),
  };
}
