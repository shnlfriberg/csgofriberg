import type { Match } from './types';

export const SOLO_IDLE_MS = 30 * 60 * 1000;
export const singleScene = (m: Match) => m.scene === 'practice' || m.scene === 'daily';
export const nextShanghaiMidnight = (day: string) => Date.parse(`${day}T00:00:00+08:00`) + 86400000;
export const needsExpiryPolicy = (m: Match) => singleScene(m) && m.status === 'playing' && m.expiresAt === undefined;

// dueAt drives server scheduling; round.deadline is only the optional play timer.
export function singleDueAt(m: Match) {
  return m.scene === 'practice' && m.duration > 0
    ? Math.min(m.createdAt + m.duration * 1000, m.expiresAt!)
    : m.expiresAt!;
}
