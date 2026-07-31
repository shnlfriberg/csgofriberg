import knex from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from './schema';
import { insertMissingSeedPlayers } from './seedPlayers';

const instances: ReturnType<typeof knex>[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.destroy()));
});

describe('baseline player seeds', () => {
  it('inserts only five players with their configured difficulty memberships', async () => {
    const instance = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    instances.push(instance);
    await ensureSchema(instance);

    expect(await insertMissingSeedPlayers(instance)).toBe(5);
    expect(await insertMissingSeedPlayers(instance)).toBe(0);
    expect(Number((await instance('players').count({ count: '*' }).first())?.count)).toBe(5);

    const s1mple = await instance('players').where({ nickname: 's1mple' }).first('id');
    expect(await instance('player_difficulties')
      .where({ player_id: s1mple.id })
      .orderBy('difficulty_key')
      .pluck('difficulty_key'))
      .toEqual(['beginner', 'easy', 'normal']);
  });
});
