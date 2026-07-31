import type { Knex } from 'knex';
import { db } from './knex';
import { backfillLegacyPlayerDifficulties, ensureSchema } from './schema';
import { seedPlayersIfEmpty } from './seedPlayers';

const BEGINNER_PLAYERS_MIGRATION = '20260731-beginner-players-v3-backfill';

export { seedPlayersIfEmpty };

export async function backfillBeginnerPlayers(instance: Knex = db): Promise<void> {
  await instance.transaction(async (trx) => {
    const applied = await trx('app_migrations').where({ name: BEGINNER_PLAYERS_MIGRATION }).first();
    if (applied) return;
    const ids = (await trx('players')
      .where({ is_easy: true })
      .where('major_championships', '>', 0)
      .select('id'))
      .map((player) => player.id);
    for (let index = 0; index < ids.length; index += 500) {
      await trx('player_difficulties')
        .insert(ids.slice(index, index + 500).map((id) => ({
          player_id: id,
          difficulty_key: 'beginner',
        })))
        .onConflict(['player_id', 'difficulty_key'])
        .ignore();
    }
    await trx('app_migrations')
      .insert({ name: BEGINNER_PLAYERS_MIGRATION })
      .onConflict('name')
      .ignore();
  });
}

export async function initDb(): Promise<void> {
  await ensureSchema();
  const seeded = await seedPlayersIfEmpty();
  if (seeded) console.log(`[seed] 已导入 ${seeded} 名选手`);
  await backfillLegacyPlayerDifficulties();
  await backfillBeginnerPlayers();
}
