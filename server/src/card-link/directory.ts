import type { CardPlayer, Variant } from '@friberg/card-link-core';
import { db } from '../db/knex';

/** One small query when opening a limited game/replay, never on card commands.
 * Enrich a copy: frozen graph data and historical game rules remain untouched. */
export async function cardDirectory(players: CardPlayer[], variant: Variant): Promise<CardPlayer[]> {
  if (variant !== 'limited') return players;
  const rows = await db('players').where('major_championships', '>', 0).select('id');
  const champions = new Set(rows.map(row => Number(row.id)));
  return players.map(player => ({ ...player, majorChampion: champions.has(player.id) }));
}
