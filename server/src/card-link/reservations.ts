import type { Knex } from 'knex';

// Seats remain immutable after finish. Do not use active reservations for the
// settlement barrier: they are released so friends/other variants can continue.
export async function pendingRanked(reader: Knex | Knex.Transaction, keys: string[], variant: string) {
  return reader('card_seats as s')
    .join('card_matches as m', 'm.id', 's.match_id')
    .leftJoin('card_results as r', 'r.match_id', 'm.id')
    .whereIn('s.identity_key', keys)
    .where({ 'm.scene': 'ranked', 'm.variant': variant, 'm.status': 'finished' })
    .whereNull('r.match_id').select('m.id').first();
}

export async function activeReservation(reader: Knex | Knex.Transaction, keys: string[]) {
  return reader('card_reservations as r')
    .join('card_matches as m', 'm.id', 'r.match_id')
    .whereIn('r.identity_key', keys)
    .whereIn('m.status', ['waiting', 'preparing', 'playing', 'roundOver'])
    .select('r.match_id').first();
}

// Terminal matches never become active again. Scope deletion to the old match
// so a delayed settlement cannot release a seat already reserved by a new game.
export async function clearEndedReservations(trx: Knex.Transaction, keys: string[]) {
  const stale = await trx('card_reservations as r')
    .leftJoin('card_matches as m', 'm.id', 'r.match_id')
    .whereIn('r.identity_key', keys)
    .where(q => q.whereIn('m.status', ['finished', 'cancelled']).orWhereNull('m.id'))
    .select('r.match_id');
  for (const row of stale)
    await trx('card_reservations').whereIn('identity_key', keys).where({ match_id: row.match_id }).delete();
}
