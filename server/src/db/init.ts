import { ensureSchema } from './schema';
import { seedPlayersIfEmpty } from './seedPlayers';

export { seedPlayersIfEmpty };

export async function initDb(): Promise<void> {
  await ensureSchema();
  const seeded = await seedPlayersIfEmpty();
  if (seeded) console.log(`[seed] 已导入 ${seeded} 名选手`);
}
