import type { Knex } from 'knex';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { careerSchema } from '../card-link/careers';
import { mergeCareer, sameCareerData } from '../card-link/careerSync';
import { lockRow } from '../card-link/transaction';
import { db } from '../db/knex';
import { isKnownDifficultyKey } from '../difficulties';
import { HttpError } from '../middleware/common';
import { invalidatePlayerCache } from './playerCache';
import { MAX_TEAM_HISTORY_ITEMS, MAX_TEAM_HISTORY_NAME_LENGTH, serializeTeamHistory } from './teamHistory';

const playerRoles = ['Rifler', 'AWPer', 'Coach'] as const;
const graphFields = ['nickname', 'age', 'nationality', 'team', 'is_enabled'] as const;
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
  playerId: z.number().int().positive().optional(),
  career: careerSchema.nullable().optional(),
  career_revision: z.number().int().nonnegative().optional(),
  team_history: playerSchema.shape.team_history.removeDefault().optional(),
  is_enabled: z.boolean().optional(),
});

// Zod 4 applies defaults inside optional fields. Updates must only contain the
// supplied fields, otherwise an age edit could clear a team or enable a player.
export const playerUpdateSchema = playerSchema.extend({
  region: playerSchema.shape.region.removeDefault(),
  team: playerSchema.shape.team.removeDefault(),
  team_history: playerSchema.shape.team_history.removeDefault(),
  role: playerSchema.shape.role.removeDefault(),
  major_championships: playerSchema.shape.major_championships.removeDefault(),
  major_appearances: playerSchema.shape.major_appearances.removeDefault(),
  is_active: playerSchema.shape.is_active.removeDefault(),
  is_enabled: playerSchema.shape.is_enabled.removeDefault(),
}).partial().strict()
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
    await lockRow(trx, 'card_catalog', { id: 1 });
    const [createdId] = await trx('players')
      .insert({ ...values, team_history: serializeTeamHistory(team_history) })
      .returning('id')
      .then((rows) => rows.map((row: unknown) => (
        typeof row === 'object' && row !== null && 'id' in row ? row.id : row
      )));
    const playerId = Number(createdId);
    await replacePlayerDifficulties(trx, playerId, difficulties);
    await trx('card_catalog').where({ id: 1 }).increment('revision', 1);
    return playerId;
  });
  await invalidatePlayerCache();
  return id;
}

export async function updatePlayer(id: number, input: PlayerUpdateInput): Promise<void> {
  await db.transaction(async (trx) => {
    await lockRow(trx, 'card_catalog', { id: 1 });
    const exists = await trx('players').where({ id }).first('id');
    if (!exists) throw new HttpError(404, 'PLAYER_NOT_FOUND');
    await applyPlayerUpdate(trx, id, input);
  });
  await invalidatePlayerCache();
}

export async function applyPlayerUpdate(
  executor: Knex.Transaction,
  id: number,
  input: PlayerUpdateInput
): Promise<void> {
  await lockRow(executor, 'card_catalog', { id: 1 });
  const old = await executor('players').where({ id }).first();
  const { difficulties, team_history, ...values } = input;
  if (difficulties) assertDifficultyKeys(difficulties);
  const updates = {
    ...values,
    ...(team_history === undefined ? {} : { team_history: serializeTeamHistory(team_history) }),
  };
  if (Object.keys(updates).length) await executor('players').where({ id }).update(updates);
  if (difficulties) await replacePlayerDifficulties(executor, id, difficulties);
  if (old && graphFields.some(field => input[field] !== undefined &&
    (field === 'is_enabled' ? Boolean(old[field]) !== input[field] : old[field] !== input[field])))
    await executor('card_catalog').where({ id: 1 }).increment('revision', 1);
}

export async function deletePlayer(id: number): Promise<void> {
  const player = await db('players').where({ id }).first('id', 'is_enabled');
  if (!player) throw new HttpError(404, 'PLAYER_NOT_FOUND');
  if (Boolean(player.is_enabled)) throw new HttpError(409, 'PLAYER_MUST_BE_DISABLED');
  const [usedInGame, usedInDailyChallenge] = await Promise.all([
    db('games').where({ target_player_id: id }).first('id'),
    db('daily_challenges').where({ target_player_id: id }).first('id'),
  ]);
  if (usedInGame || usedInDailyChallenge) throw new HttpError(409, 'PLAYER_HAS_HISTORY');
  const count = await db.transaction(async trx => {
    await lockRow(trx, 'card_catalog', { id: 1 });
    const count = await trx('players').where({ id }).del();
    if (count) await trx('card_catalog').where({ id: 1 }).increment('revision', 1);
    return count;
  });
  if (!count) throw new HttpError(404, 'PLAYER_NOT_FOUND');
  await invalidatePlayerCache();
}

export async function importPlayers(
  players: ImportedPlayerInput[], userId = 0,
): Promise<{ created: number; updated: number; careerReviews?: number }> {
  let created = 0;
  let updated = 0;
  let careerReviews = 0;
  await db.transaction(async (trx) => {
    await lockRow(trx, 'card_catalog', { id: 1 });
    const nicknames = players.map((player) => player.nickname);
    const existing = await trx('players')
      .where(query => query.whereIn('nickname', nicknames)
        .orWhereIn('id', players.flatMap(player => player.playerId === undefined ? [] : [player.playerId])))
      .select('id', 'nickname', 'age', 'nationality', 'team', 'is_enabled', 'team_history');
    const existingNames = new Set(existing.map((player) => String(player.nickname)));
    const importedIds = new Set<number>();
    for (const player of players) {
      if (player.playerId === undefined) continue;
      const old = existing.find(p => p.nickname === player.nickname);
      const byId = existing.find(p => Number(p.id) === player.playerId);
      // IDs carried by exports must not silently target another existing person
      // or create a second person after a rename. Legacy name-only imports and
      // genuinely new records remain supported; renames use the edit endpoint.
      if (importedIds.has(player.playerId) || (old && Number(old.id) !== player.playerId) ||
        (byId && byId.nickname !== player.nickname))
        throw new HttpError(409, 'PLAYER_TARGET_MISMATCH');
      importedIds.add(player.playerId);
    }
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
      const { difficulties, team_history, career, career_revision, playerId, ...values } = player;
      const desired = difficulties ?? (existingNames.has(player.nickname) ? null : ['normal']);
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
    if (importedPlayers.some(player => {
      const old = existing.find(p => p.nickname === player.nickname);
      return !old || graphFields.some(field => field === 'is_enabled'
        ? Boolean(old[field]) !== Boolean(player[field]) : old[field] !== player[field]);
    })) await trx('card_catalog').where({ id: 1 }).increment('revision', 1);
    for (let index = 0; index < importedPlayers.length; index += chunkSize) {
      await trx('players')
        .insert(importedPlayers.slice(index, index + chunkSize))
        .onConflict('nickname')
        .merge();
    }
    const savedPlayers = await trx('players')
      .whereIn('nickname', nicknames)
      .select('id', 'nickname');
    for (const player of players) {
      if (!player.career) continue;
      const playerId = Number(savedPlayers.find(p => p.nickname === player.nickname)!.id);
      const stored = await trx('card_careers').where({ player_id: playerId }).first();
      const previous = stored ? careerSchema.parse(JSON.parse(stored.payload)) : null;
      if (previous && sameCareerData(previous, player.career)) continue;
      const merged = mergeCareer(previous, player.career, true);
      const expected = previous ? (player.career_revision ?? Number(stored.revision)) : 0;
      await trx('card_career_reviews').insert({
        id: randomUUID(), player_id: playerId, expected_revision: expected,
        payload: JSON.stringify(merged.career), status: expected === Number(stored?.revision ?? 0) ? 'pending' : 'conflict',
        source: `admin:${userId}:json-import`, created_at: Date.now(),
      });
      careerReviews++;
    }
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
  return { created, updated, ...(careerReviews ? { careerReviews } : {}) };
}
