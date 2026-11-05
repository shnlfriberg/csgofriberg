import { randomUUID } from "crypto";
import { z } from "zod";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { lockRow, receipt, transaction } from "./transaction";
import { mergeCareer, sameCareerData } from "./careerSync";
import { tenureProjection } from "./careerProjection";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
const sourceUrl = z
  .string()
  .url()
  .max(500)
  .refine((v) => ["http:", "https:"].includes(new URL(v).protocol));
export const sourceTenureSchema = z
  .object({
    teamId: z.string().min(1).max(180),
    team: z.string().min(1).max(120),
    game: z.enum(["csgo", "cs2"]),
    start: date.nullable(),
    end: date.nullable(),
    precision: z.enum(["day", "month", "year", "unknown"]),
    status: z.enum([
      "active",
      "loan",
      "inactive",
      "staff",
      "trial",
      "standin",
      "unknown",
    ]),
    rawDates: z.string().max(300),
    source: sourceUrl,
    verified: z.boolean().default(false),
  })
  .strict();
export const tenureSchema = sourceTenureSchema.extend({
  sourceSnapshot: sourceTenureSchema.optional(),
  manual: z.object({
    fields: z.array(z.enum(["teamId", "team", "game", "start", "end", "precision", "status", "rawDates", "source", "verified"])).min(1).max(10),
    source: sourceUrl,
    checkedAt: date,
    note: z.string().max(2000),
  }).strict().optional(),
}).strict();
export const careerSchema = z
  .object({
    personKey: z.string().min(1).max(180),
    page: sourceUrl,
    sourceRevision: z.string().max(100),
    observedAt: date,
    aliases: z.array(z.string().min(1).max(64)).max(30),
    tenures: z.array(tenureSchema).max(250),
    locked: z.boolean().default(false),
    syncWarnings: z.array(z.string().max(500)).max(500).optional(),
  })
  .strict();
export type Career = z.infer<typeof careerSchema>;
export const hasReversedExactDates = (career: Career) => career.tenures.some(t =>
  t.precision === 'day' && t.start !== null && t.end !== null && t.start > t.end);
export const careerSubmissionSchema = z
  .object({
    playerId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    career: careerSchema,
  })
  .strict();
export async function submitCareer(
  input: z.infer<typeof careerSubmissionSchema>,
  source: string,
  requestId: string,
) {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    return receipt(trx, `career:${source}`, requestId, input, async () => {
      if (!(await trx("players").where({ id: input.playerId }).first()))
        throw new HttpError(404, "PLAYER_NOT_FOUND");
      const current = await trx("card_careers")
        .where({ player_id: input.playerId })
        .first();
      const previous: Career | null = current ? careerSchema.parse(JSON.parse(current.payload)) : null;
      const admin = source.startsWith("admin:");
      const merged = mergeCareer(previous, careerSchema.parse(input.career), admin);
      const id = randomUUID(),
        conflict =
          Number(current?.revision ?? 0) !== input.expectedRevision ||
          (previous?.locked && !admin) || merged.conflict || hasReversedExactDates(merged.career);
      if (!conflict && previous && sameCareerData(previous, merged.career))
        return { id: "", status: "unchanged" };
      await trx("card_career_reviews").insert({
        id,
        player_id: input.playerId,
        expected_revision: input.expectedRevision,
        payload: JSON.stringify(merged.career),
        status: conflict ? "conflict" : "pending",
        source,
        created_at: Date.now(),
      });
      return { id, status: conflict ? "conflict" : "pending" };
    });
  });
}
export async function reviewCareer(
  id: string,
  approve: boolean,
  userId: number,
) {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const row = await lockRow(trx, "card_career_reviews", { id });
    if (!row) throw new HttpError(404, "CARD_REVIEW_NOT_FOUND");
    if (!["pending", "conflict"].includes(row.status))
      return { status: row.status };
    if (!approve) {
      await trx("card_career_reviews")
        .where({ id })
        .update({ status: "rejected", handled_by: userId });
      return { status: "rejected" };
    }
    const current = await trx("card_careers")
      .where({ player_id: row.player_id })
      .first();
    if (
      Number(current?.revision ?? 0) !== Number(row.expected_revision) ||
      (current &&
        JSON.parse(current.payload).locked &&
        !String(row.source).startsWith("admin:"))
    ) {
      await trx("card_career_reviews")
        .where({ id })
        .update({ status: "conflict" });
      return { status: "conflict" };
    }
    const career = careerSchema.parse(JSON.parse(row.payload));
    if (hasReversedExactDates(career)) throw new HttpError(409, 'CARD_CAREER_DATES');
    await trx("card_careers")
      .insert({
        player_id: row.player_id,
        revision: Number(row.expected_revision) + 1,
        payload: JSON.stringify(career),
      })
      .onConflict("player_id")
      .merge();
    const indexed = await trx("card_career_tenures").where({ player_id: row.player_id });
    const oldByOrdinal = new Map(indexed.map(t => [Number(t.ordinal), t]));
    for (const ordinal of career.tenures.keys()) {
      const value = tenureProjection(Number(row.player_id), career, ordinal);
      const old = oldByOrdinal.get(ordinal);
      if (!old) await trx("card_career_tenures").insert(value);
      else if (old.payload !== value.payload || old.person_key !== value.person_key)
        await trx("card_career_tenures").where({ player_id: row.player_id, ordinal }).update(value);
    }
    await trx("card_career_tenures").where({ player_id: row.player_id }).where("ordinal", ">=", career.tenures.length).delete();
    await trx("card_career_reviews")
      .where({ id })
      .update({ status: "approved", handled_by: userId });
    await trx("card_catalog").where({ id: 1 }).increment("revision", 1);
    return { status: "approved" };
  });
}
export async function exportCareers() {
  const rows = await db("players as p")
    .leftJoin("card_careers as c", "c.player_id", "p.id")
    .select("p.id", "p.nickname", "p.is_enabled", "c.revision", "c.payload");
  return rows.map((r) => ({
    playerId: Number(r.id),
    nickname: r.nickname,
    enabled: Boolean(r.is_enabled),
    revision: Number(r.revision ?? 0),
    career: r.payload ? JSON.parse(r.payload) : null,
  }));
}
