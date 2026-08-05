import type { Knex } from 'knex';
import { z } from 'zod';
import { db } from '../db/knex';
import { isKnownDifficultyKey } from '../difficulties';
import { HttpError } from '../middleware/common';
import { invalidatePlayerCache } from './playerCache';
import { MAX_TEAM_HISTORY_ITEMS, MAX_TEAM_HISTORY_NAME_LENGTH, serializeTeamHistory } from './teamHistory';

const playerRoles = ['Rifler', 'AWPer', 'Coach'] as const;
const difficultyKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const difficultyListSchema = z.array(difficultyKeySchema)
  .min(1)
  .max(20)
  .refine((keys) => new Set(keys).size === keys.length);

export const playerSchema = z.object({
  nickname: z.string().trim().min(1).max(64),
  nationality: z.string().trim().min(1).max(64),
  region: z.string().trim().max(32).default(''),
  team: z.string().trim().max(64).default(''),
  team_history: z.array(z.string().trim().min(1).max(MAX_TEAM_HISTORY_NAME_LENGTH))
    .max(MAX_TEAM_HISTORY_ITEMS)
    .default([]),
  age: z.number().int().min(10).max(100),
  role: z.enum(playerRoles).default('Rifler'),
  major_championships: z.number().int().min(0).default(0),
  major_appearances: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  is_enabled: z.boolean().default(true),
  difficulties: difficultyListSchema.optional(),
});

export const importedPlayerSchema = playerSchema.extend({
  // Legacy exports may not contain history; preserve an existing value when omitted.
  team_history: playerSchema.shape.team_history.optional(),
  is_enabled: z.boolean().optional(),
  // Legacy import alias; it is converted to difficulty memberships and never persisted.
  is_easy: z.boolean().optional(),
});

export const playerUpdateSchema = playerSchema.partial().strict()
  .refine((values) => Object.keys(values).length > 0);

export const playerImportSchema = z.object({
  players: z.array(importedPlayerSchema)
    .min(1)
    .max(1000)
    .refine((players) => new Set(players.map((player) => player.nickname)).size === players.length),
});

export type PlayerInput = z.infer<typeof playerSchema>;
export type PlayerUpdateInput = z.infer<typeof playerUpdateSchema>;
export type ImportedPlayerInput = z.infer<typeof importedPlayerSchema>;

export function assertDifficultyKeys(keys: string[]): void {
  const unique = [...new Set(keys)];
  if (unique.some((key) => !isKnownDifficultyKey(key))) {
    throw new HttpError(400, 'INVALID_DIFFICULTY');
  }
}

export async function replacePlayerDifficulties(
  executor: Knex | Knex.Transaction,
  playerId: number,
  keys: string[]
): Promise<void> {
  const unique = [...new Set(keys)];
  await executor('player_difficulties').where({ player_id: playerId }).del();
  if (unique.length) {
    await executor('player_difficulties').insert(
      unique.map((key) => ({ player_id: playerId, difficulty_key: key }))
    );
  }
}

export async function createPlayer(input: PlayerInput): Promise<number> {
  const exists = await db('players').where({ nickname: input.nickname }).first('id');
  if (exists) throw new HttpError(409, 'NICKNAME_TAKEN');
  const difficulties = input.difficulties ?? ['normal'];
  assertDifficultyKeys(difficulties);
  const { difficulties: _difficulties, team_history, ...values } = input;
  const id = await db.transaction(async (trx) => {
    const [createdId] = await trx('players')
      .insert({ ...values, team_history: serializeTeamHistory(team_history) })
      .returning('id')
      .then((rows) => rows.map((row: unknown) => (
        typeof row === 'object' && row !== null && 'id' in row ? row.id : row
      )));
    const playerId = Number(createdId);
    await replacePlayerDifficulties(trx, playerId, difficulties);
    return playerId;
  });
  await invalidatePlayerCache();
  return id;
}

export async function updatePlayer(id: number, input: PlayerUpdateInput): Promise<void> {
  await db.transaction(async (trx) => {
    const exists = await trx('players').where({ id }).first('id');
    if (!exists) throw new HttpError(404, 'PLAYER_NOT_FOUND');
    await applyPlayerUpdate(trx, id, input);
  });
  await invalidatePlayerCache();
}

export async function applyPlayerUpdate(
  executor: Knex | Knex.Transaction,
  id: number,
  input: PlayerUpdateInput
): Promise<void> {
  const { difficulties, team_history, ...values } = input;
  if (difficulties) assertDifficultyKeys(difficulties);
  const updates = {
    ...values,
    ...(team_history === undefined ? {} : { team_history: serializeTeamHistory(team_history) }),
  };
  if (Object.keys(updates).length) await executor('players').where({ id }).update(updates);
  if (difficulties) await replacePlayerDifficulties(executor, id, difficulties);
}

export async function deletePlayer(id: number): Promise<void> {
  const player = await db('players').where({ id }).first('id', 'is_enabled');
  if (!player) throw new HttpError(404, 'PLAYER_NOT_FOUND');
  if (Boolean(player.is_enabled)) throw new HttpError(409, 'PLAYER_MUST_BE_DISABLED');
  const used = await db('games').where({ target_player_id: id }).first('id');
  if (used) throw new HttpError(409, 'PLAYER_HAS_HISTORY');
  const count = await db('players').where({ id }).del();
  if (!count) throw new HttpError(404, 'PLAYER_NOT_FOUND');
  await invalidatePlayerCache();
}

export async function importPlayers(
  players: ImportedPlayerInput[]
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  await db.transaction(async (trx) => {
    const nicknames = players.map((player) => player.nickname);
    const existing = await trx('players')
      .whereIn('nickname', nicknames)
      .select('id', 'nickname', 'is_enabled', 'team_history');
    const existingNames = new Set(existing.map((player) => String(player.nickname)));
    const existingEnabled = new Map(
      existing.map((player) => [String(player.nickname), Boolean(player.is_enabled)])
    );
    const existingTeamHistory = new Map(
      existing.map((player) => [String(player.nickname), serializeTeamHistory(player.team_history)])
    );
    updated = players.filter((player) => existingNames.has(player.nickname)).length;
    created = players.length - updated;
    const desiredDifficulties = new Map<string, string[] | null>();
    const importedPlayers = players.map((player) => {
      const { difficulties, is_easy, team_history, ...values } = player;
      const desired = difficulties
        ?? (is_easy !== undefined
          ? [
            'normal',
            ...(is_easy ? ['easy'] : []),
            ...(is_easy && player.major_championships > 0 ? ['beginner'] : []),
          ]
          : null)
        ?? (existingNames.has(player.nickname) ? null : ['normal']);
      desiredDifficulties.set(player.nickname, desired);
      return {
        ...values,
        team_history: team_history === undefined && existingNames.has(player.nickname)
          ? existingTeamHistory.get(player.nickname) ?? '[]'
          : serializeTeamHistory(team_history ?? []),
        is_enabled: player.is_enabled ?? existingEnabled.get(player.nickname) ?? true,
      };
    });
    assertDifficultyKeys([...new Set(
      [...desiredDifficulties.values()].flatMap((keys) => keys ?? [])
    )]);
    const chunkSize = 200;
    for (let index = 0; index < importedPlayers.length; index += chunkSize) {
      await trx('players')
        .insert(importedPlayers.slice(index, index + chunkSize))
        .onConflict('nickname')
        .merge();
    }
    const savedPlayers = await trx('players')
      .whereIn('nickname', nicknames)
      .select('id', 'nickname');
    const replacementIds: number[] = [];
    const replacementMemberships: Array<{ player_id: number; difficulty_key: string }> = [];
    for (const player of savedPlayers) {
      const difficulties = desiredDifficulties.get(String(player.nickname));
      if (!difficulties) continue;
      const playerId = Number(player.id);
      replacementIds.push(playerId);
      replacementMemberships.push(
        ...[...new Set(difficulties)].map((difficultyKey) => ({
          player_id: playerId,
          difficulty_key: difficultyKey,
        }))
      );
    }
    if (replacementIds.length) {
      await trx('player_difficulties').whereIn('player_id', replacementIds).del();
      for (let index = 0; index < replacementMemberships.length; index += 500) {
        await trx('player_difficulties').insert(replacementMemberships.slice(index, index + 500));
      }
    }
  });
  await invalidatePlayerCache();
  return { created, updated };
}
