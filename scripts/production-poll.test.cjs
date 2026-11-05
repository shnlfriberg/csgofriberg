const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pollState } = require('./production-poll.cjs');

test('checks fresh server state after a delayed 250 ms timer crosses the 12 s deadline', async () => {
  let time = 0, reads = 0;
  const result = await pollState(async () => { reads++; return time >= 3000 ? 'playing' : 'preparing'; }, s => s === 'playing', {
    now: () => time, sleep: async ms => { assert.equal(ms, 250); time += 15000; },
  });
  assert.equal(result, 'playing'); assert.equal(reads, 2);
});
test('still returns a genuine stalled state at the deadline without extending polling', async () => {
  let time = 0, reads = 0;
  const result = await pollState(async () => { reads++; return 'preparing'; }, s => s === 'playing', {
    now: () => time, sleep: async ms => { time += ms; },
  });
  assert.equal(result, 'preparing'); assert.equal(time, 12000); assert.equal(reads, 49);
});
test('does not hide failed server requests', async () => {
  await assert.rejects(() => pollState(async () => { throw new Error('REQUEST_FAILED'); }, () => false), /REQUEST_FAILED/);
});
