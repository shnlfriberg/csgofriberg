import type { Knex } from "knex";
import { identityKeys } from "./claims";
import type { Variant } from "@friberg/card-link-core";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { activeGraph, loadGraph } from "./graphs";
import { createMatchIn } from "./matches";
import { lockRow, transaction } from "./transaction";
import type { Owner } from "./types";
import { activeReservation, clearEndedReservations, pendingRanked } from './reservations';
import { requireScene, sceneFlags } from './operations';
import { randomUUID } from 'crypto';
export const QUEUE_LEASE_MS = 10_000;
type QueuedOwner = Owner & { heartbeatAt?: number; ticket?: string };
export async function requireRanked(
  owner: Owner,
  reader: Knex | Knex.Transaction = db,
) {
  if (!owner.userId) throw new HttpError(403, "EMAIL_VERIFICATION_REQUIRED");
  const user = await reader("users").where({ id: owner.userId }).first();
  if (!user || user.banned_at) throw new HttpError(403, "USER_BANNED");
  if (!user.email || !user.email_verified_at)
    throw new HttpError(403, "EMAIL_VERIFICATION_REQUIRED");
  if (user.matchmaking_restricted)
    throw new HttpError(403, "MATCHMAKING_RESTRICTED");
}
export async function queueMatch(owner: Owner, variant: Variant) {
  try {
    await requireRanked(owner);
  } catch (e) {
    await db("card_queue").where({ identity_key: owner.key }).delete();
    throw e;
  }
  let g = await activeGraph();
  return transaction(async (trx) => {
    const catalog = await lockRow(trx, "card_catalog", { id: 1 });
    if (g.data.version !== catalog.graph_version)
      g = await loadGraph(catalog.graph_version, trx);
    await requireRanked(owner, trx);
    const keys = await identityKeys(owner, trx);
    await clearEndedReservations(trx, keys);
    const playing = await activeReservation(trx, keys);
    if (playing) return { id: String(playing.match_id) };
    requireScene(catalog, 'ranked');
    if (await pendingRanked(trx, keys, variant)) throw new HttpError(409, 'CARD_SETTLEMENT_PENDING');
    await trx("card_queue")
      .where("queued_at", "<", Date.now() - 120000)
      .delete();
    const candidates = await trx("card_queue")
      .where({ variant })
      .whereNot({ identity_key: owner.key })
      .orderBy("queued_at")
      .limit(30);
    for (const row of candidates) {
      const other: QueuedOwner = JSON.parse(row.payload);
      const user = await trx("users").where({ id: other.userId }).first();
      if (
        !other.heartbeatAt || other.heartbeatAt <= Date.now() - QUEUE_LEASE_MS ||
        !user?.email ||
        !user?.email_verified_at ||
        user.banned_at ||
        user.matchmaking_restricted ||
        (await activeReservation(trx, await identityKeys(other, trx))) ||
        (await pendingRanked(trx, await identityKeys(other, trx), variant))
      ) {
        await trx("card_queue").where({ identity_key: other.key }).delete();
        continue;
      }
      const m = await createMatchIn(
        trx,
        [{ key: other.key, userId: other.userId, name: other.name }, owner],
        "ranked",
        variant,
        "normal",
        180,
        g,
      );
      await trx("card_queue")
        .whereIn("identity_key", [owner.key, other.key])
        .delete();
      return { id: m.id };
    }
    const old = await trx("card_queue")
      .where({ identity_key: owner.key })
      .first();
    const ticket = old ? (JSON.parse(old.payload) as QueuedOwner).ticket ?? randomUUID() : randomUUID();
    if (!old)
      await trx("card_queue").insert({
        identity_key: owner.key,
        variant,
        queued_at: Date.now(),
        payload: JSON.stringify({ ...owner, ticket, heartbeatAt: Date.now() }),
      });
    else if (old.variant !== variant)
      throw new HttpError(409, "CARD_ALREADY_QUEUED");
    else await trx('card_queue').where({ identity_key: owner.key })
      .update({ payload: JSON.stringify({ ...owner, ticket, heartbeatAt: Date.now() }) });
    return { queued: true, ticket };
  });
}
export async function heartbeatQueue(owner: Owner, ticket: string) {
  await requireRanked(owner);
  return transaction(async trx => {
    const catalog = await lockRow(trx, 'card_catalog', { id: 1 });
    const keys = await identityKeys(owner, trx);
    const playing = await activeReservation(trx, keys);
    if (playing) return { id: String(playing.match_id), queued: false };
    const row = await trx('card_queue').where({ identity_key: owner.key }).first();
    if (!row) return { queued: false };
    const queued: QueuedOwner = JSON.parse(row.payload);
    if (queued.ticket !== ticket) return { queued: false };
    if (!catalog.enabled || !sceneFlags(catalog).ranked || await pendingRanked(trx, keys, row.variant)) {
      await trx('card_queue').where({ identity_key: owner.key }).delete();
      return { queued: false };
    }
    if (!queued.heartbeatAt || queued.heartbeatAt <= Date.now() - QUEUE_LEASE_MS || Number(row.queued_at) <= Date.now() - 120000) {
      await trx('card_queue').where({ identity_key: owner.key }).delete();
      return { queued: false };
    }
    await trx('card_queue').where({ identity_key: owner.key })
      .update({ payload: JSON.stringify({ ...queued, heartbeatAt: Date.now() }) });
    return { queued: true, ticket };
  });
}
export async function cancelQueue(owner: Owner, ticket?: string) {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const row = await trx('card_queue').where({ identity_key: owner.key }).first();
    if (!ticket || (row && JSON.parse(row.payload).ticket === ticket))
      await trx("card_queue").where({ identity_key: owner.key }).delete();
    const current = await activeReservation(trx, await identityKeys(owner, trx));
    return current ? { id: String(current.match_id) } : { queued: false };
  });
}
