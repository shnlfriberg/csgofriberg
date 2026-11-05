import type { Knex } from 'knex';
import { STARTER_MAPS, LOCATION_REQUIRED_COLUMNS } from '../schema';

export const LOCATION_TABLES = Object.keys(LOCATION_REQUIRED_COLUMNS).reverse();

export async function locationDataCounts(instance: Knex) {
  const counts: Record<string, number> = {};
  for (const table of LOCATION_TABLES) {
    const row = await instance(table).count({ count: '*' }).first();
    counts[table] = Number(row?.count || 0);
  }
  return counts;
}

/** Reset only the location domain. preserveMaps retains all measured calibration and map snapshots. */
export async function resetLocationDatabase(
  instance: Knex,
  { preserveMaps = false }: { preserveMaps?: boolean } = {}
) {
  await instance.transaction(async (trx) => {
    for (const table of LOCATION_TABLES) {
      if (preserveMaps && table === 'location_maps') continue;
      if (preserveMaps && table === 'location_versions') {
        await trx(table).whereNot('key', 'like', 'map:%').delete();
      } else await trx(table).delete();
    }
    if (preserveMaps) return;
    for (const map of STARTER_MAPS) {
      const payload = JSON.stringify(map);
      await trx('location_maps').insert({ id: map.id, payload });
      await trx('location_versions').insert({
        key: `map:${map.id}:${map.version}`,
        payload,
      });
    }
  });
}
