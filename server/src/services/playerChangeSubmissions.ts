import { z } from 'zod';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { normalizeTeamHistory } from './teamHistory';
import {
  applyPlayerUpdate,
  assertDifficultyKeys,
  playerUpdateSchema,
  type PlayerUpdateInput,
} from './playerMutations';
import { invalidatePlayerCache } from './playerCache';

export const playerChangeSubmissionSchema = z.object({
  players: z.array(z.object({
    playerId: z.coerce.number().int().positive().optional(),
    nickname: z.string().trim().min(1).max(64).optional(),
    changes: playerUpdateSchema,
  }).strict().refine((value) => value.playerId !== undefined || value.nickname !== undefined, {
    message: 'PLAYER_TARGET_REQUIRED',
  })).min(1).max(100),
}).strict();

export type PlayerChangeSubmissionInput = z.infer<typeof playerChangeSubmissionSchema>;
export type PlayerChangeStatus = 'pending' | 'approved' | 'rejected' | 'conflict';

const fields = [
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
  'is_enabled',
  'difficulties',
] as const;
type PlayerChangeField = typeof fields[number];

function jsonValue(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function canonical(field: PlayerChangeField, value: unknown): unknown {
  if (field === 'team_history') return normalizeTeamHistory(value);
  if (field === 'difficulties') {
    return [...new Set(Array.isArray(value) ? value.map(String) : [])].sort();
  }
  if (['is_active', 'is_enabled'].includes(field)) return Boolean(value);
  if (['age', 'major_championships', 'major_appearances'].includes(field)) return Number(value);
  return String(value ?? '');
}

function currentValue(field: PlayerChangeField, player: Record<string, unknown>, difficulties: string[]): unknown {
  return field === 'difficulties' ? difficulties : player[field];
}

function idFromReturning(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'id' in value) return Number((value as { id: unknown }).id);
  return Number(value);
}

export async function createPlayerChangeSubmission(
  input: PlayerChangeSubmissionInput,
  apiToken: { id: number; name: string }
): Promise<{ submissionId: number | null; submitted: number; unchanged: number }> {
  let unchanged = 0;
  const result = await db.transaction(async (trx) => {
    const ids = input.players.flatMap((entry) => entry.playerId === undefined ? [] : [entry.playerId]);
    const names = input.players.flatMap((entry) => entry.nickname === undefined ? [] : [entry.nickname]);
    const rows = await trx('players').where((query) => {
      if (ids.length) query.whereIn('id', ids);
      if (names.length) {
        if (ids.length) query.orWhereIn('nickname', names);
        else query.whereIn('nickname', names);
      }
    }).select(
      'id', 'nickname', 'nationality', 'region', 'team', 'team_history', 'age', 'role',
      'major_championships', 'major_appearances', 'is_active', 'is_enabled'
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const byName = new Map(rows.map((row) => [String(row.nickname), row]));
    const targetIds = new Set<number>();
    const resolved = input.players.map((entry) => {
      if (entry.changes.difficulties) assertDifficultyKeys(entry.changes.difficulties);
      const rowById = entry.playerId === undefined ? undefined : byId.get(entry.playerId);
      const rowByName = entry.nickname === undefined ? undefined : byName.get(entry.nickname);
      if (!rowById && !rowByName) throw new HttpError(404, 'PLAYER_NOT_FOUND');
      if (
        (entry.playerId !== undefined && entry.nickname !== undefined && (!rowById || !rowByName))
        || (rowById && rowByName && Number(rowById.id) !== Number(rowByName.id))
      ) {
        throw new HttpError(400, 'PLAYER_TARGET_MISMATCH');
      }
      const row = rowById ?? rowByName!;
      const id = Number(row.id);
      if (targetIds.has(id)) throw new HttpError(400, 'DUPLICATE_PLAYER_CHANGE_TARGET');
      targetIds.add(id);
      return { entry, row };
    });
    const memberships = await trx('player_difficulties')
      .whereIn('player_id', [...targetIds])
      .select('player_id', 'difficulty_key');
    const difficultiesByPlayer = new Map<number, string[]>();
    for (const membership of memberships) {
      const list = difficultiesByPlayer.get(Number(membership.player_id)) ?? [];
      list.push(String(membership.difficulty_key));
      difficultiesByPlayer.set(Number(membership.player_id), list);
    }
    const items: Array<Record<string, unknown>> = [];
    for (const { entry, row } of resolved) {
      for (const field of fields) {
        if (!(field in entry.changes)) continue;
        const oldValue = canonical(field, currentValue(field, row as Record<string, unknown>, difficultiesByPlayer.get(Number(row.id)) ?? []));
        const newValue = canonical(field, (entry.changes as Record<string, unknown>)[field]);
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
          unchanged += 1;
          continue;
        }
        items.push({
          player_id: Number(row.id),
          player_nickname: String(row.nickname),
          field,
          old_value: jsonValue(oldValue),
          new_value: jsonValue(newValue),
          status: 'pending',
        });
      }
    }
    if (!items.length) return { submissionId: null, submitted: 0, unchanged };
    const [created] = await trx('player_change_submissions').insert({
      api_token_id: apiToken.id,
      api_token_name: apiToken.name,
    }).returning('id');
    const submissionId = idFromReturning(created);
    await trx('player_change_items').insert(items.map((item) => ({ ...item, submission_id: submissionId })));
    return { submissionId, submitted: items.length, unchanged };
  });
  return result;
}

export async function listPlayerChangeItems(options: {
  status: 'all' | PlayerChangeStatus;
  page: number;
  pageSize: number;
  search: string;
}) {
  const query = db('player_change_items as item')
    .join('player_change_submissions as submission', 'submission.id', 'item.submission_id')
    .leftJoin('users as handler', 'handler.id', 'item.handled_by_user_id');
  if (options.status !== 'all') query.where('item.status', options.status);
  if (options.search) {
    const term = `%${options.search}%`;
    query.where((builder) => builder
      .whereILike('item.player_nickname', term)
      .orWhereILike('item.field', term)
      .orWhereILike('submission.api_token_name', term));
  }
  const total = Number((await query.clone().count({ count: 'item.id' }).first())?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const rows = await query.clone()
    .select(
      'item.id', 'item.submission_id as submissionId', 'item.player_id as playerId',
      'item.player_nickname as playerNickname', 'item.field', 'item.old_value as oldValue',
      'item.new_value as newValue', 'item.status', 'item.created_at as createdAt',
      'item.handled_at as handledAt', 'submission.api_token_name as source',
      'handler.username as handledBy'
    )
    .orderBy('item.created_at', 'desc').orderBy('item.id', 'desc')
    .limit(options.pageSize).offset((page - 1) * options.pageSize);
  return {
    items: rows.map((row) => ({
      id: Number(row.id), submissionId: Number(row.submissionId), playerId: row.playerId == null ? null : Number(row.playerId),
      playerNickname: String(row.playerNickname), field: String(row.field),
      oldValue: parseJsonValue(row.oldValue), newValue: parseJsonValue(row.newValue),
      status: String(row.status) as PlayerChangeStatus, source: String(row.source),
      createdAt: row.createdAt, handledAt: row.handledAt, handledBy: row.handledBy ?? null,
    })),
    total, page, pageSize: options.pageSize, totalPages,
  };
}

export async function reviewPlayerChangeItems(
  itemIds: number[],
  decision: 'approve' | 'reject',
  handledByUserId: number
): Promise<{ approved: number; rejected: number; conflict: number; updated: number }> {
  let approved = 0;
  let rejected = 0;
  let conflict = 0;
  await db.transaction(async (trx) => {
    const items = await trx('player_change_items')
      .whereIn('id', itemIds).where({ status: 'pending' })
      .orderBy('id').forUpdate().select('*');
    for (const item of items) {
      if (decision === 'reject') {
        await trx('player_change_items').where({ id: item.id, status: 'pending' }).update({
          status: 'rejected', handled_by_user_id: handledByUserId, handled_at: trx.fn.now(),
        });
        rejected += 1;
        continue;
      }
      const player = item.player_id == null
        ? null
        : await trx('players').where({ id: item.player_id }).forUpdate().first(
          'id', 'nickname', 'nationality', 'region', 'team', 'team_history', 'age', 'role',
          'major_championships', 'major_appearances', 'is_active', 'is_enabled'
        );
      const markConflict = async () => {
        await trx('player_change_items').where({ id: item.id, status: 'pending' }).update({
          status: 'conflict', handled_by_user_id: handledByUserId, handled_at: trx.fn.now(),
        });
        conflict += 1;
      };
      if (!player) {
        await markConflict();
        continue;
      }
      const difficulties = await trx('player_difficulties').where({ player_id: player.id }).pluck('difficulty_key');
      const field = String(item.field) as PlayerChangeField;
      if (!(fields as readonly string[]).includes(field)) {
        await markConflict();
        continue;
      }
      const oldValue = canonical(field, parseJsonValue(item.old_value));
      const actualValue = canonical(field, currentValue(field, player as Record<string, unknown>, difficulties.map(String)));
      if (JSON.stringify(oldValue) !== JSON.stringify(actualValue)) {
        await markConflict();
        continue;
      }
      const newValue = canonical(field, parseJsonValue(item.new_value));
      if (field === 'nickname') {
        const duplicate = await trx('players').where({ nickname: newValue }).whereNot({ id: player.id }).first('id');
        if (duplicate) {
          await markConflict();
          continue;
        }
      }
      const update = { [field]: newValue } as PlayerUpdateInput;
      if (field === 'difficulties') assertDifficultyKeys(newValue as string[]);
      await applyPlayerUpdate(trx, Number(player.id), update);
      await trx('player_change_items').where({ id: item.id, status: 'pending' }).update({
        status: 'approved', handled_by_user_id: handledByUserId, handled_at: trx.fn.now(),
      });
      approved += 1;
    }
  });
  if (approved) await invalidatePlayerCache();
  return { approved, rejected, conflict, updated: approved + rejected + conflict };
}
