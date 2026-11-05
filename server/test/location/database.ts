import { db } from '../../src/db/knex';
import { dayWindow } from '../../src/location/rules';
import { testMap, testPool } from './fixtures';

export async function seedLocationFixtures() {
  const date = dayWindow().date;
  const previous = await db('location_daily').where({ date }).first();
  await db('location_daily').where({ date }).delete();
  const map = testMap();
  await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) }).onConflict('id').merge();
  for (const { question } of testPool()) await db('location_questions').insert({ id: question.id, image_hash: question.imageHash, payload: JSON.stringify(question) }).onConflict('id').merge();
  return async () => {
    await db('location_questions').where('id', 'like', 'test_location_%').delete();
    await db('location_maps').where({ id: map.id }).delete();
    await db('location_versions').where('key', 'like', '%test_location%').delete();
    await db('location_daily').where({ date }).delete();
    if (previous) await db('location_daily').insert(previous);
    await db('location_progress').where('identity_key', 'like', 'g:location-test-%').delete();
    await db('location_daily_attempts').where('identity_key', 'like', 'g:location-test-%').delete();
    await db('location_results').where('identity_key', 'like', 'g:location-test-%').delete();
  };
}
