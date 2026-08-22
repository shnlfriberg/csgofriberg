import { db } from '../db/knex';
import { normalizeTeamHistory } from './teamHistory';

export interface ExportedPlayer {
  nickname: string;
  nationality: string;
  region: string;
  team: string;
  team_history: string[];
  age: number;
  role: string;
  major_championships: number;
  major_appearances: number;
  difficulties: string[];
  is_active: boolean;
  is_enabled: boolean;
}

export async function exportPlayers(): Promise<ExportedPlayer[]> {
  const [players, memberships] = await Promise.all([
    db('players')
      .select(
        'id',
        'nickname',
        'nationality',
        'region',
        'team',
        'team_history',
        'age',
        'role',
        'major_championships',
        'major_appearances',
        'is_active',
        'is_enabled'
      )
      .orderBy('nickname'),
    db('player_difficulties')
      .orderBy('difficulty_key')
      .select('player_id', 'difficulty_key'),
  ]);
  const difficultiesByPlayer = new Map<number, string[]>();
  for (const membership of memberships) {
    const playerId = Number(membership.player_id);
    const difficulties = difficultiesByPlayer.get(playerId) ?? [];
    difficulties.push(String(membership.difficulty_key));
    difficultiesByPlayer.set(playerId, difficulties);
  }
  return players.map((player) => ({
    nickname: String(player.nickname),
    nationality: String(player.nationality),
    region: String(player.region),
    team: String(player.team),
    team_history: normalizeTeamHistory(player.team_history),
    age: Number(player.age),
    role: String(player.role),
    major_championships: Number(player.major_championships),
    major_appearances: Number(player.major_appearances),
    difficulties: difficultiesByPlayer.get(Number(player.id)) ?? [],
    is_active: Boolean(player.is_active),
    is_enabled: Boolean(player.is_enabled),
  }));
}
