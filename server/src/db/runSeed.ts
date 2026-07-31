import { db } from './knex';
import { ensureSchema } from './schema';
import { insertMissingSeedPlayers } from './seedPlayers';

// 手动执行:补充种子数据中数据库尚不存在的选手(按昵称去重)
async function run() {
  await ensureSchema();
  const inserted = await insertMissingSeedPlayers();
  console.log(`[seed] 新增 ${inserted} 名选手`);
  await db.destroy();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
