import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../src/db/knex', () => ({ db: mocks }));
import { transaction } from '../../src/card-link/transaction';
beforeEach(() => { mocks.transaction.mockReset(); });
describe('card transaction error compatibility', () => {
  it('retries numeric SQLite busy snapshots as well as PostgreSQL serialization failures', async () => {
    mocks.transaction.mockRejectedValueOnce({ code: 'ERR_SQLITE_ERROR', errcode: 517 })
      .mockRejectedValueOnce({ code: '40001' }).mockResolvedValue('committed');
    expect(await transaction(async () => 'committed')).toBe('committed');
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
  });
  it('does not retry SQLite constraint errors and bounds persistent busy retries', async () => {
    const constraint = { code: 'ERR_SQLITE_ERROR', errcode: 19 };
    mocks.transaction.mockRejectedValue(constraint);
    await expect(transaction(async () => null)).rejects.toBe(constraint);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    mocks.transaction.mockReset().mockRejectedValue({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
    await expect(transaction(async () => null)).rejects.toMatchObject({ errcode: 5 });
    expect(mocks.transaction).toHaveBeenCalledTimes(6);
  });
});
