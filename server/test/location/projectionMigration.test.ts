import knex from 'knex';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema';
import { testPool } from './fixtures';

describe('non-destructive location projections', () => {
  it('backfills indexes and independent points without changing a single legacy field', async () => {
    const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await db.schema.createTable('location_questions', t => { t.string('id').primary(); t.string('image_hash').unique(); t.text('payload'); });
      const question = testPool()[0].question;
      const original = { id: question.id, image_hash: question.imageHash, payload: JSON.stringify({ ...question, unknownFutureField: { keep: [1, 2, 3] } }, null, 2) };
      await db('location_questions').insert(original);
      await ensureSchema(db);
      await ensureSchema(db);
      expect(await db('location_questions').first('id', 'image_hash', 'payload')).toEqual(original);
      expect(await db('location_questions').first('map_id', 'point_id', 'u', 'v')).toEqual({ map_id: question.mapId, point_id: question.capturePointId, u: question.u, v: question.v });
      expect(JSON.parse((await db('location_points').where({ map_id: question.mapId, point_id: question.capturePointId }).first()).payload)).toMatchObject({ u: question.u, v: question.v, floorId: question.floorId });
      const plans = await db.raw('explain query plan select id from location_questions where map_id = ? and floor_id = ? and u between ? and ?', [question.mapId, question.floorId, 0, 1]);
      expect(plans.some((plan: any) => plan.detail.includes('INDEX'))).toBe(true);
    } finally { await db.destroy(); }
  });
});
