import type { Knex } from "knex";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { lockRow, transaction } from "./transaction";
import type { Owner } from "./types";

export async function identityKeys(
  owner: Owner,
  reader: Knex | Knex.Transaction = db,
): Promise<string[]> {
  if (!owner.userId) return [owner.key];
  const claims = await reader("card_claims")
    .where({ user_id: owner.userId })
    .select("guest_key");
  return [owner.key, ...claims.map((row) => `g:${row.guest_key}`)];
}

// The original seat identity and command receipts stay immutable after login.
export async function matchOwner(id: string, owner: Owner): Promise<Owner> {
  if (!owner.userId) return owner;
  const keys = await identityKeys(owner);
  const rows = await db("card_seats")
    .where({ match_id: id })
    .whereIn("identity_key", keys);
  const row = rows.find((r) => r.identity_key === owner.key) ?? rows[0];
  return row ? { ...owner, key: row.identity_key } : owner;
}

export async function claimCardResults(
  guestKey: string,
  userId: number,
): Promise<number> {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const existing = await trx("card_claims")
      .where({ guest_key: guestKey })
      .first();
    if (existing && Number(existing.user_id) !== userId)
      throw new HttpError(409, "CARD_CLAIM_CONFLICT");
    await trx("card_claims")
      .insert({ guest_key: guestKey, user_id: userId })
      .onConflict("guest_key")
      .ignore();
    const identity = `g:${guestKey}`;
    const attempts = await trx("card_daily_attempts").where({
      identity_key: identity,
    });
    for (const attempt of attempts) {
      await trx("card_daily_attempts")
        .insert({ ...attempt, identity_key: `u:${userId}` })
        .onConflict(["day", "variant", "identity_key"])
        .ignore();
    }
    return trx("card_participants")
      .where({ identity_key: identity })
      .whereNull("user_id")
      .update({ user_id: userId });
  });
}
