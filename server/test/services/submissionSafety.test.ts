import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/knex';
import { ensureSchema } from '../../src/db/schema';
import { createPlayerChangeSubmission, reviewPlayerChangeItems } from '../../src/services/playerChangeSubmissions';
import { createApiToken } from '../../src/services/apiTokens';
import { readTokenScopes } from '../../src/services/apiTokenScopes';
import { requireApiScope } from '../../src/middleware/apiToken';

describe('durable external submission safety', () => {
  let userId: number; let playerId: number; let token: { id: number; name: string };
  beforeAll(async () => {
    await ensureSchema();
    const [user] = await db('users').insert({ username: `submit-${randomUUID()}`, password_hash: 'unused', role: 'admin' }).returning('id');
    userId = Number(user.id);
    token = await createApiToken(userId, 'test', 1);
    const [player] = await db('players').insert({ nickname: `submit-${randomUUID()}`, nationality: 'Denmark', region: 'Europe', team: 'A', age: 25, role: 'Rifler', major_championships: 0, major_appearances: 0, is_active: true }).returning('id');
    playerId = Number(player.id);
  });
  afterAll(async () => {
    await db('player_change_submissions').where({ api_token_id: token.id }).delete();
    await db('external_submission_requests').where({ token_id: token.id }).delete();
    await db('api_tokens').where({ created_by_user_id: userId }).delete();
    await db('players').where({ id: playerId }).delete();
    await db('users').where({ id: userId }).delete();
  });
  it('serializes simultaneous retries, survives module reload, and rejects key reuse with changed content', async () => {
    const input = { players: [{ playerId, changes: { team: 'C' }, expected: { team: 'A' } }] };
    const results = await Promise.all(Array.from({ length: 4 }, () => createPlayerChangeSubmission(input, token, 'run-1')));
    expect(new Set(results.map(r => r.submissionId)).size).toBe(1);
    expect(await db('player_change_items').where({ submission_id: results[0].submissionId }).count({ count: '*' }).first()).toMatchObject({ count: 1 });
    // Reimport the implementation; the receipt is in SQL, not a module singleton.
    vi.resetModules();
    const reloaded = await import('../../src/services/submissionIdempotency');
    const replay = await db.transaction(trx => reloaded.submitOnce(trx, token.id, 'run-1', input, async () => { throw new Error('must not execute'); }));
    expect(replay).toEqual(results[0]);
    await expect(createPlayerChangeSubmission({ players: [{ playerId, changes: { team: 'D' } }] }, token, 'run-1')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect((await createPlayerChangeSubmission(input, token, 'run-2')).submissionId).not.toBe(results[0].submissionId);
  });
  it('preserves a baseline and refuses both pre-submit and pre-review overwrites', async () => {
    await db('players').where({ id: playerId }).update({ team: 'B' });
    const result = await createPlayerChangeSubmission({ players: [{ playerId, changes: { team: 'C' }, expected: { team: 'A' } }] }, token);
    const item = await db('player_change_items').where({ submission_id: result.submissionId }).first();
    expect(item).toMatchObject({ old_value: '"A"', observed_value: '"B"', status: 'conflict' });
    expect((await reviewPlayerChangeItems([item.id], 'approve', userId)).approved).toBe(0);
    const pending = await createPlayerChangeSubmission({ players: [{ playerId, changes: { team: 'D' }, expected: { team: 'B' } }] }, token);
    await db('players').where({ id: playerId }).update({ team: 'E' });
    const pendingItem = await db('player_change_items').where({ submission_id: pending.submissionId }).first();
    expect((await reviewPlayerChangeItems([pendingItem.id], 'approve', userId)).conflict).toBe(1);
    expect((await db('players').where({ id: playerId }).first()).team).toBe('E');
  });
  it('defaults to review-only writes, retains legacy permissions, and fails closed on malformed scopes', async () => {
    const row = await db('api_tokens').where({ id: token.id }).first();
    expect(readTokenScopes(row.scopes)).toEqual(['players:read', 'changes:submit']);
    expect(readTokenScopes(null)).toContain('players:write');
    expect(readTokenScopes('broken')).toEqual([]);
    const next = vi.fn(); const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireApiScope('players:write')({ apiToken: { scopes: readTokenScopes(row.scopes) } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
});
