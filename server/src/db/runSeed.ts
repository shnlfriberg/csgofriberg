import { db } from './knex';
import { ensureSchema } from './schema';
import playersData from './seeds/players.json';

// 手动执行:补充种子数据中数据库尚不存在的选手(按昵称去重)
async function run() {
  await ensureSchema();
  const existing = new Set(
    (await db('players').select('nickname')).map((r: any) => r.nickname)
  );
  const rows = (playersData as any[])
    .filter((p) => !existing.has(p.nickname))
    .map((p) => ({
      nickname: p.nickname,
      nationality: p.nationality,
      region: p.region ?? '',
      team: p.team ?? '',
      age: p.age,
      role: p.role ?? 'Rifler',
      major_championships: p.major_championships ?? 0,
      major_appearances: p.major_appearances ?? 0,
      is_easy: p.is_easy ?? false,
      is_active: p.is_active ?? true,
      is_enabled: p.is_enabled ?? true,
    }));
  if (rows.length) await db.batchInsert('players', rows, 50);
  const players = await db('players').select('id', 'is_easy');
  const memberships = players.flatMap((player: any) => [
    { player_id: player.id, difficulty_key: 'normal' },
    ...(Boolean(player.is_easy) ? [{ player_id: player.id, difficulty_key: 'easy' }] : []),
  ]);
  for (let index = 0; index < memberships.length; index += 500) {
    await db('player_difficulties').insert(memberships.slice(index, index + 500))
      .onConflict(['player_id', 'difficulty_key']).ignore();
  }
  console.log(`[seed] 新增 ${rows.length} 名选手`);
  await db.destroy();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
