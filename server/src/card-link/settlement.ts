import { compareResults, RULES } from "@friberg/card-link-core";
import { db } from "../db/knex";
import { lockRow, transaction } from "./transaction";
import { rowsFor } from "./matches";
import { seatId } from "./views";
import type { Match, Seat } from "./types";
import { observe } from './metrics';
import { replaySummary } from './replaySummary';
export async function settle(id: string) {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const outbox = await lockRow(trx, "card_outbox", { match_id: id });
    if (!outbox) return;
    const row = await lockRow(trx, "card_matches", { id });
    const m: Match = JSON.parse(row.payload);
    if (m.status !== "finished") return;
    if (await trx("card_results").where({ match_id: id }).first()) {
      await trx("card_outbox").where({ match_id: id }).delete();
      await trx('card_reservations').where({ match_id: id }).delete();
      return;
    }
    const rows = await rowsFor(trx, id),
      seats = rows.map((r) => JSON.parse(r.payload) as Seat);
    const order = [...seats].sort(
      (a, b) =>
        Number(a.retired) - Number(b.retired) ||
        compareResults(a.results, b.results),
    );
    const result = {
      storageVersion: 1,
      match: {
        id: m.id,
        variant: m.variant,
        scene: m.scene,
        day: m.day,
        dailyPractice: m.dailyPractice === true,
        rulesVersion: m.rulesVersion,
        graphVersion: m.questions[0].graphVersion,
        questions: m.questions.map((q) => ({ start: q.start, end: q.end })),
      },
      players: order.map((s) => ({
        id: seatId(s.owner.key),
        name: s.owner.name,
        retired: s.retired,
        results: s.results,
      })),
    };
    await trx("card_results").insert({
      match_id: id,
      payload: JSON.stringify(result),
      created_at: Date.now(),
    });
    for (const s of seats) {
      const claimed =
        s.owner.userId === null
          ? await trx("card_claims")
              .where({ guest_key: s.owner.key.slice(2) })
              .first()
          : null;
      const solved = s.results.filter((x) => x !== null);
      await trx("card_participants").insert({
        match_id: id,
        identity_key: s.owner.key,
        user_id: s.owner.userId ?? claimed?.user_id ?? null,
        variant: m.variant,
        scene: m.scene,
        day: m.day,
        solved: solved.length,
        hops: solved.reduce((n, r) => n + r!.path.length - 1, 0),
        elapsed: solved.reduce((n, r) => n + r!.elapsed, 0),
        replay_summary: JSON.stringify(replaySummary(result, s.owner.key)),
      });
    }
    if (
      m.scene === "ranked" &&
      seats.length === 2 &&
      seats.every((s) => s.owner.userId !== null)
    ) {
      const sorted = [...seats].sort(
        (a, b) => a.owner.userId! - b.owner.userId!,
      );
      const ratings: number[] = [];
      for (const s of sorted) {
        const where = { user_id: s.owner.userId!, variant: m.variant };
        await trx("card_ratings")
          .insert({ ...where, rating: RULES.eloInitial })
          .onConflict(["user_id", "variant"])
          .ignore();
        ratings.push(
          Number((await lockRow(trx, "card_ratings", where)).rating),
        );
      }
      const cmp =
          Number(sorted[0].retired) - Number(sorted[1].retired) ||
          compareResults(sorted[0].results, sorted[1].results),
        score = cmp < 0 ? 1 : cmp > 0 ? 0 : 0.5;
      const change = Math.round(
        RULES.eloK *
          (score - 1 / (1 + 10 ** ((ratings[1] - ratings[0]) / 400))),
      );
      for (let i = 0; i < 2; i++) {
        const after = ratings[i] + (i === 0 ? change : -change),
          userId = sorted[i].owner.userId!;
        await trx("card_ratings")
          .where({ user_id: userId, variant: m.variant })
          .update({ rating: after });
        await trx("card_rating_ledger").insert({
          match_id: id,
          user_id: userId,
          before: ratings[i],
          after,
        });
      }
    }
    await trx("card_outbox").where({ match_id: id }).delete();
    await trx("card_reservations").where({ match_id: id }).delete();
  });
}
export async function flushSettlements() {
  const rows = await db("card_outbox")
    .where("attempts", "<", 10)
    .where("due_at", "<=", Date.now())
    .orderBy("due_at")
    .limit(30);
  for (const row of rows)
    try {
      await settle(row.match_id);
    } catch (error) {
      observe('outbox_retry');
      if (Number(row.attempts) + 1 >= 10) observe('outbox_stalled');
      console.warn(JSON.stringify({ event: Number(row.attempts) + 1 >= 10 ? 'CARD_SETTLEMENT_STALLED' : 'CARD_SETTLEMENT_RETRY', matchId: row.match_id, attempt: Number(row.attempts) + 1 }));
      await db("card_outbox")
        .where({ match_id: row.match_id })
        .update({
          attempts: db.raw("attempts + 1"),
          due_at:
            Date.now() + Math.min(300000, 5000 * 2 ** Number(row.attempts)),
          error:
            error instanceof Error ? error.message.slice(0, 300) : "FAILED",
        });
    }
}
