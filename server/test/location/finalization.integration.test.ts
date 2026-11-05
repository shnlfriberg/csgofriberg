import { randomUUID } from 'crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { startGame, answerGame, readGame, abandonGame, submitDaily, replay, claimLocation } from '../../src/location/games';
import { loadGame } from '../../src/location/store';
import { decodeReplay } from '../../src/location/replayStorage';
import { seedLocationFixtures } from './database';

let clean: () => Promise<void>;
beforeAll(async () => { await initDb(); await initRedis(); clean = await seedLocationFixtures(); });
afterAll(async () => { await clean(); });

async function failSave(action: () => Promise<unknown>) {
  const client: any = Object.getPrototypeOf(redis()!);
  const multi = client.multi;
  let injected = false;
  client.multi = function (...args: any[]) {
    const batch = multi.apply(this, args), exec = batch.exec;
    batch.exec = async function (...values: any[]) {
      if (!injected) { injected = true; throw new Error('FINAL_SAVE_FAILED'); }
      return exec.apply(this, values);
    };
    return batch;
  };
  try { await expect(action()).rejects.toThrow('FINAL_SAVE_FAILED'); expect(injected).toBe(true); }
  finally { client.multi = multi; }
}

it.each(['random', 'daily'] as const)('recovers immutable %s results after SQL commits and Redis fails, including missing cache and claims', async mode => {
  const owner = { key: `g:location-test-final-${randomUUID()}`, userId: null, name: 'Test' };
  let view = await startGame(owner, mode, 'normal');
  const initial = (await loadGame(view.id, owner))!;
  const inputs = initial.questions.map(({ question: q }, i) => ({ mapId: q.mapId, floorId: q.floorId, u: q.u, v: q.v, round: i + 1, version: i, requestId: randomUUID() }));
  for (const input of inputs.slice(0, 4)) view = await answerGame(view.id, owner, input);
  if (mode === 'random') await failSave(() => answerGame(view.id, owner, inputs[4]));
  else { await answerGame(view.id, owner, inputs[4]); await failSave(() => submitDaily(view.id, owner)); }
  const raw = await db('location_results').where({ game_id: view.id, identity_key: owner.key }).first();
  expect(Number(raw.score)).toBe(25000);
  expect((await loadGame(view.id, owner))!.status).not.toBe('finished');
  const final = await readGame(view.id, owner);
  expect(final.status).toBe('finished'); expect(final.totalScore).toBe(25000);
  expect(await answerGame(view.id, owner, inputs[4])).toEqual(final);
  await expect(answerGame(view.id, owner, { ...inputs[4], u: 0 })).rejects.toMatchObject({ code: 'LOCATION_REQUEST_CONFLICT' });
  expect(await answerGame(view.id, owner, { ...inputs[4], u: 0, requestId: randomUUID() })).toEqual(final);
  await expect(abandonGame(view.id, owner)).rejects.toMatchObject({ code: 'LOCATION_ALREADY_SUBMITTED' });
  if (mode === 'daily') expect(await submitDaily(view.id, owner)).toEqual(final);
  const resumed = await startGame(owner, mode, 'normal');
  if (mode === 'daily') expect(resumed).toEqual(final);
  else expect(resumed.id).not.toBe(view.id);
  await redis()!.del(redisKey(`location:game:${view.id}`));
  expect(await readGame(view.id, owner)).toEqual(final);
  await expect(readGame(view.id, { ...owner, key: 'g:stranger' })).rejects.toMatchObject({ code: 'LOCATION_GAME_NOT_FOUND' });
  const publicResult = await replay(view.id, owner);
  expect(publicResult).not.toHaveProperty('answerRequests');
  expect(JSON.stringify(publicResult)).not.toContain(owner.key);
  expect((await db('location_results').where({ game_id: view.id }).first()).payload).toBe(raw.payload);
  // Old payloads without receipts are still authoritative and never rescored.
  const legacy = await decodeReplay(raw.payload) as any;
  delete legacy.answerRequests;
  await db('location_results').where({ game_id: view.id }).update({ payload: JSON.stringify(legacy) });
  expect(await answerGame(view.id, owner, { ...inputs[4], u: 0 })).toEqual(final);
  const [user] = await db('users').insert({ username: `final_${randomUUID().slice(0, 16)}`, password_hash: 'unused' }).returning('id');
  const userId = Number(user.id);
  try {
    expect(await claimLocation(owner.key.slice(2), userId, 'Claimed')).toBe(1);
    expect(await readGame(view.id, { key: `u:${userId}`, userId, name: 'Claimed' })).toEqual(final);
  } finally {
    await db('location_results').where({ game_id: view.id }).delete();
    await db('location_daily_attempts').where({ identity_key: `u:${userId}` }).delete();
    await db('users').where({ id: userId }).delete();
  }
});
