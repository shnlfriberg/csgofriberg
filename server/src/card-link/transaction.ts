import type { Knex } from "knex";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { createHash } from "crypto";
import { measured, observe } from './metrics';
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const commitHooks = new WeakMap<Knex.Transaction, Array<() => unknown>>();

/**
 * Run `hook` only after the surrounding transaction commits (room-kernel
 * occupancy release, deadline scheduling, settlement wake-ups). A retried or
 * rolled-back attempt discards its hooks.
 */
export function onCommit(trx: Knex.Transaction, hook: () => unknown): void {
  const hooks = commitHooks.get(trx);
  if (hooks) hooks.push(hook);
  else void (trx as unknown as { executionPromise?: Promise<unknown> }).executionPromise
    ?.then(hook).catch((error) => console.error('[card-link:commit-hook]', error));
}

/** Run `hook` when this transaction attempt rolls back (undo external claims). */
export function onRollback(trx: Knex.Transaction, hook: () => unknown): void {
  void (trx as unknown as { executionPromise?: Promise<unknown> }).executionPromise
    ?.catch(() => Promise.resolve().then(hook).catch((error) => console.error('[card-link:rollback-hook]', error)));
}

// SQLite upgrades deferred transactions conservatively; retries rerun deterministic commands.
export async function transaction<T>(
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      let hooks: Array<() => unknown> = [];
      const result = await measured('transaction_ms', () => db.transaction((trx) => {
        hooks = [];
        commitHooks.set(trx, hooks);
        return fn(trx);
      }));
      for (const hook of hooks) {
        try { await hook(); } catch (error) { console.error('[card-link:commit-hook]', error); }
      }
      return result;
    } catch (e) {
      const code = String((e as { code?: string }).code ?? "");
      // Node's SQLite shim exposes numeric extended result codes (e.g. 517
      // SQLITE_BUSY_SNAPSHOT), whereas better-sqlite3 exposes string codes.
      const sqlitePrimary = Number((e as { errcode?: number }).errcode) & 0xff;
      const sqliteBusy = code === 'ERR_SQLITE_ERROR' && [5, 6].includes(sqlitePrimary);
      if (
        attempt >= 5 ||
        (!sqliteBusy && !["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", "40001", "40P01"].includes(
          code,
        ))
      )
        throw e;
      observe('transaction_retry');
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    }
}
export async function lockRow(
  trx: Knex.Transaction,
  table: string,
  where: Record<string, unknown>,
) {
  let query = trx(table).where(where);
  if (trx.client.config.client === "pg") query = query.forUpdate();
  return query.first();
}
export async function receipt<T>(
  trx: Knex.Transaction,
  scope: string,
  id: string,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!/^[\w-]{8,64}$/.test(id)) throw new HttpError(400, "VALIDATION_FAILED");
  const hash = fingerprint(input),
    old = await trx("card_requests").where({ scope, request_id: id }).first();
  if (old) {
    if (old.fingerprint !== hash)
      throw new HttpError(409, "CARD_REQUEST_CONFLICT");
    return JSON.parse(old.response);
  }
  const result = await work();
  await trx("card_requests").insert({
    scope,
    request_id: id,
    fingerprint: hash,
    response: JSON.stringify(result),
  });
  return result;
}
