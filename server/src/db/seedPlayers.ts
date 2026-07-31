import type { Knex } from 'knex';
import { db } from './knex';
import playersData from './seeds/players.json';

interface SeedPlayer {
  nickname: string;
  nationality: string;
  region: string;
  team?: string;
  age: number;
  role?: string;
  major_championships?: number;
  major_appearances?: number;
  difficulties?: string[];
  is_active?: boolean;
  is_enabled?: boolean;
}

const seedPlayers = playersData as SeedPlayer[];
const normalizeNickname = (value: string) => value.toLocaleLowerCase('en-US').replace(/[_-]/g, '');

function difficulties(player: SeedPlayer): string[] {
  return player.difficulties?.length ? [...new Set(player.difficulties)] : ['normal'];
}

export async function insertMissingSeedPlayers(instance: Knex = db): Promise<number> {
  const existing = new Set(
    (await instance('players').select('nickname'))
      .map((player) => normalizeNickname(String(player.nickname)))
  );
  const additions = seedPlayers.filter(
    (player) => !existing.has(normalizeNickname(player.nickname))
  );
  if (!additions.length) return 0;

  await instance.transaction(async (trx) => {
    const inserted = await trx('players')
      .insert(additions.map((player) => ({
        nickname: player.nickname,
        nationality: player.nationality,
        region: player.region,
        team: player.team ?? '',
        age: player.age,
        role: player.role ?? 'Rifler',
        major_championships: player.major_championships ?? 0,
        major_appearances: player.major_appearances ?? 0,
        is_easy: difficulties(player).includes('easy'),
        is_active: player.is_active ?? true,
        is_enabled: player.is_enabled ?? true,
      })))
      .returning(['id', 'nickname']);
    const seedByNickname = new Map(
      additions.map((player) => [normalizeNickname(player.nickname), player])
    );
    const memberships = inserted.flatMap((player) => {
      const seed = seedByNickname.get(normalizeNickname(String(player.nickname)));
      return seed
        ? difficulties(seed).map((difficultyKey) => ({
            player_id: player.id,
            difficulty_key: difficultyKey,
          }))
        : [];
    });
    if (memberships.length) {
      await trx('player_difficulties')
        .insert(memberships)
        .onConflict(['player_id', 'difficulty_key'])
        .ignore();
    }
  });
  return additions.length;
}

export async function seedPlayersIfEmpty(instance: Knex = db): Promise<number> {
  const row = await instance('players').count<{ count: number | string }[]>({ count: '*' });
  if (Number(row[0]?.count ?? 0) > 0) return 0;
  return insertMissingSeedPlayers(instance);
}
