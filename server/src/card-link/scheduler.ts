import { db } from '../db/knex';
import { logTransientWarning } from '../services/transientLog';
import { advanceById } from './matches';

export const activeMatchStatuses = ['waiting', 'preparing', 'playing', 'roundOver'];
export function dueMatches(now: number) {
  // Equality on the leading column lets the existing (status, due_at) index
  // exclude historical matches; NOT IN forced a table scan every second.
  return db('card_matches').whereIn('status', activeMatchStatuses)
    .where('due_at', '<=', now).orderBy('due_at').limit(100).select('id');
}

export async function advanceDueMatches(notify: (id: string) => Promise<void>) {
  const due = await dueMatches(Date.now());
  // Bounded indexed pickup of legacy unlimited solo games (formerly no due_at).
  const legacy = await db('card_matches').where({ status: 'playing', scene: 'practice' })
    .whereNull('due_at').limit(100).select('id');
  for (const row of [...due, ...legacy]) {
    try {
      await advanceById(row.id);
      await notify(row.id);
    } catch (error) {
      // One unavailable old graph must not block other rooms or settlement.
      logTransientWarning('[card-link:advance]', `${row.id}: ${error instanceof Error ? error.message : 'FAILED'}`);
    }
  }
}
