import type { Knex } from 'knex';
import { HttpError } from '../middleware/common';
import { claimOccupancy, occupiedError, releaseOccupancy } from '../rooms/kernel/occupancy';
import { ScheduleSource } from '../rooms/kernel/schedules';
import { cancelLocalTimer, setLocalTimer } from '../rooms/kernel/timers';
import { onCommit, onRollback } from './transaction';
import type { Match } from './types';

/**
 * 卡牌连接 on the shared room kernel. SQL stays authoritative for matches,
 * seats, receipts and settlement; the kernel provides site-wide occupancy,
 * exact deadline wake-ups and watch presence (no `fetchSockets` RPCs).
 */
export const cardSchedules = new ScheduleSource('card-link', 'kernel:schedules:card-link');
export const tickMember = (id: string) => `tick|${id}|0`;
export const settleMember = (id: string) => `settle|${id}|0`;
const LOCAL_TIMER_HORIZON_MS = 60_000;
const ref = (matchId: string) => ({ game: 'card-link' as const, roomId: matchId });

type Handler = (id: string) => Promise<void>;
let tickHandler: Handler | null = null;
let settleHandler: Handler | null = null;

export function setCardKernelHandlers(handlers: { tick: Handler | null; settle: Handler | null }): void {
  tickHandler = handlers.tick;
  settleHandler = handlers.settle;
}

export const isMultiplayer = (m: Pick<Match, 'scene'>) => m.scene === 'friend' || m.scene === 'ranked';

/** Schedule (or clear) the next exact deadline of a match after commit. */
export async function scheduleTick(id: string, at: number | null): Promise<void> {
  if (at === null) {
    cancelLocalTimer(`card-link:${id}`);
    await cardSchedules.remove(tickMember(id));
    return;
  }
  await cardSchedules.add(tickMember(id), at);
  const delay = at - Date.now();
  if (delay <= LOCAL_TIMER_HORIZON_MS && tickHandler) {
    setLocalTimer(`card-link:${id}`, delay + 5, async () => {
      if (tickHandler && await cardSchedules.claimOne(tickMember(id))) await tickHandler(id);
    });
  }
}

export async function wakeSettlement(id: string): Promise<void> {
  await cardSchedules.add(settleMember(id), Date.now());
  setLocalTimer(`card-link-settle:${id}`, 0, async () => {
    if (settleHandler && await cardSchedules.claimOne(settleMember(id))) await settleHandler(id);
  });
}

const scheduled = new WeakMap<Knex.Transaction, Map<string, () => number | null>>();

/** Register the match's next deadline to be scheduled once the transaction commits. */
export function scheduleAfterCommit(trx: Knex.Transaction, id: string, due: () => number | null): void {
  let pending = scheduled.get(trx);
  if (!pending) {
    pending = new Map();
    scheduled.set(trx, pending);
    const batch = pending;
    onCommit(trx, async () => {
      for (const [matchId, at] of batch) await scheduleTick(matchId, at());
    });
  }
  pending.set(id, due);
}

/**
 * Claim the site-wide seat for multiplayer participants inside a SQL
 * transaction; the claim is undone if the transaction rolls back.
 */
export async function claimCardSeats(trx: Knex.Transaction, matchId: string, keys: string[]): Promise<void> {
  // Card reservations were checked in this transaction, so an older 卡牌连接
  // reference is stale; other games are checked through Redis only (no SQL
  // query may run outside this transaction on SQLite's single connection).
  const result = await claimOccupancy(ref(matchId), keys, { staleSameGame: true });
  if (!result.ok) {
    const error = await occupiedError(result.conflict, result.identity);
    throw new HttpError(409, 'CARD_ALREADY_PLAYING', { occupied: error.occupied });
  }
  onRollback(trx, () => releaseOccupancy(ref(matchId), keys));
}

/** Release seats after commit (finished, cancelled, left a waiting room, expired). */
export function releaseCardSeatsAfterCommit(trx: Knex.Transaction, matchId: string, keys: string[]): void {
  if (!keys.length) return;
  onCommit(trx, () => releaseOccupancy(ref(matchId), keys));
}
