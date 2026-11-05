import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { HttpError } from '../middleware/common';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])
  );
  return value;
}

/** The unique row serializes retries across processes, in the mutation transaction. */
export async function submitOnce<T>(trx: Knex.Transaction, tokenId: number, key: string | undefined,
  input: unknown, action: () => Promise<T>): Promise<T> {
  if (key === undefined) return action();
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID');
  const where = { token_id: tokenId, request_key: key };
  const hash = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
  await trx('external_submission_requests').insert({ ...where, payload_hash: hash }).onConflict(['token_id', 'request_key']).ignore();
  const row = await trx('external_submission_requests').where(where).forUpdate().first();
  if (row.payload_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
  if (row.response !== null) return JSON.parse(row.response) as T;
  const result = await action();
  await trx('external_submission_requests').where(where).update({ response: JSON.stringify(result) });
  return result;
}
