import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/knex';
import { ensureSchema } from '../../src/db/schema';
import { dueMatches, advanceDueMatches } from '../../src/card-link/scheduler';
import { advanceById } from '../../src/card-link/matches';
vi.mock('../../src/card-link/matches', () => ({ advanceById: vi.fn() }));
const ids: string[] = [];
beforeAll(async () => {
  if (!process.env.DB_URL?.includes('verification')) throw Error('ISOLATED_DB_REQUIRED');
  await ensureSchema();
});
afterAll(async () => { await db('card_matches').whereIn('id', ids).delete(); await db.destroy(); });
describe('card scheduler index and fault isolation', () => {
  it('picks up legacy unlimited solo games without scanning or changing finished history', async () => {
    const id = randomUUID(); ids.push(id);
    await db('card_matches').insert({ id, scene: 'practice', variant: 'unlimited', status: 'playing', revision: 0, due_at: null, payload: '{}' });
    vi.mocked(advanceById).mockResolvedValue({} as any);
    const notify = vi.fn(async (_id: string) => {});
    await advanceDueMatches(notify);
    expect(advanceById).toHaveBeenCalledWith(id, undefined, { presence: true });
    expect(notify).toHaveBeenCalledWith(id);
    await db('card_matches').where({ id }).delete();
    ids.pop();
  });
  it('uses the existing status/deadline index instead of scanning history', async () => {
    const compiled = dueMatches(Date.now()).toSQL();
    const plan = await db.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, compiled.bindings as any);
    expect(plan.map((row: { detail: string }) => row.detail).join(' ')).toContain('USING INDEX card_matches_status_due_at_index');
  });
  it('continues advancing other due rooms after one room fails', async () => {
    const now = Date.now();
    for (const [status, due] of [['playing', now - 6000], ['preparing', now - 5000], ['finished', now - 4000], ['playing', null], ['waiting', now + 60000]] as const) {
      const id = randomUUID(); ids.push(id);
      await db('card_matches').insert({ id, scene: 'friend', variant: 'unlimited', status, revision: 0, due_at: due, payload: '{}' });
    }
    const matches = await dueMatches(now);
    expect(matches.filter(row => ids.includes(row.id)).map(row => row.id)).toEqual(ids.slice(0, 2));
    vi.mocked(advanceById).mockImplementation(async id => { if (id === ids[0]) throw Error('CARD_GRAPH_MISSING'); return {} as any; });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notify = vi.fn(async (_id: string) => {});
    try {
      await advanceDueMatches(notify);
      expect(advanceById).toHaveBeenCalledWith(ids[1], undefined, { presence: true });
      expect(notify).toHaveBeenCalledWith(ids[1]);
      expect(notify).not.toHaveBeenCalledWith(ids[0]);
    } finally { warning.mockRestore(); }
  });
});
