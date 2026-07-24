import { db } from './knex';
import { ensureSchema } from './schema';
import playersData from './seeds/players.json';
import championshipData from './seeds/major-championships.json';
import easyPlayerData from './seeds/easy-players.json';

const MAJOR_CHAMPIONSHIPS_MIGRATION = '20260719-major-championships-backfill';
const EASY_PLAYERS_MIGRATION = '20260719-easy-players-backfill';
const normalizeNickname = (value: string) => value.toLocaleLowerCase('en-US').replace(/[_-]/g, '');

export async function seedPlayersIfEmpty(): Promise<void> {
  const row = await db('players').count<{ c: number }[]>({ c: '*' });
  const count = Number(row[0].c);
  if (count > 0) return;
  const rows = (playersData as any[]).map((p) => ({
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
  await db.batchInsert('players', rows, 50);
  await syncDifficultyMemberships();
  console.log(`[seed] 已导入 ${rows.length} 名选手`);
}

async function syncDifficultyMemberships(): Promise<void> {
  const players = await db('players').select('id', 'is_easy');
  const memberships = players.flatMap((player) => [
    { player_id: player.id, difficulty_key: 'normal' },
    ...(Boolean(player.is_easy) ? [{ player_id: player.id, difficulty_key: 'easy' }] : []),
  ]);
  for (let index = 0; index < memberships.length; index += 500) {
    await db('player_difficulties').insert(memberships.slice(index, index + 500))
      .onConflict(['player_id', 'difficulty_key']).ignore();
  }
}

async function backfillMajorChampionships(): Promise<void> {
  const values = new Map<string, number>();
  for (const player of championshipData as { nickname: string; major_championships: number }[]) {
    values.set(player.nickname, player.major_championships);
  }
  for (const player of playersData as { nickname: string; major_championships?: number }[]) {
    if ((player.major_championships ?? 0) > 0) {
      values.set(player.nickname, player.major_championships!);
    }
  }
  const grouped = new Map<number, string[]>();
  for (const [nickname, championships] of values) {
    const nicknames = grouped.get(championships) ?? [];
    nicknames.push(nickname);
    grouped.set(championships, nicknames);
  }
  await db.transaction(async (trx) => {
    const applied = await trx('app_migrations')
      .where({ name: MAJOR_CHAMPIONSHIPS_MIGRATION })
      .first();
    if (applied) return;
    for (const [championships, nicknames] of grouped) {
      await trx('players')
        .whereIn('nickname', nicknames)
        .update({ major_championships: championships });
    }
    await trx('app_migrations')
      .insert({ name: MAJOR_CHAMPIONSHIPS_MIGRATION })
      .onConflict('name')
      .ignore();
  });
}

async function backfillEasyPlayers(): Promise<void> {
  await db.transaction(async (trx) => {
    const applied = await trx('app_migrations').where({ name: EASY_PLAYERS_MIGRATION }).first();
    if (applied) return;
    const easyNicknames = new Set(
      (easyPlayerData as { nickname: string }[]).map((player) => normalizeNickname(player.nickname))
    );
    const playerRows = await trx('players').select('id', 'nickname');
    const ids = playerRows
      .filter((player) => easyNicknames.has(normalizeNickname(player.nickname)))
      .map((player) => player.id);
    for (let index = 0; index < ids.length; index += 200) {
      await trx('players').whereIn('id', ids.slice(index, index + 200)).update({ is_easy: true });
    }
    await trx('app_migrations')
      .insert({ name: EASY_PLAYERS_MIGRATION })
      .onConflict('name')
      .ignore();
  });
}

export async function initDb(): Promise<void> {
  await ensureSchema();
  await seedPlayersIfEmpty();
  await backfillMajorChampionships();
  await backfillEasyPlayers();
  await syncDifficultyMemberships();
}
