import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { careerSchema, type Career } from "./careers";
import { effectiveTenures } from "./tenures";

/** Admin-only review preview; no graph publication or gameplay queries. */
export async function reviewPreview(id: string) {
  const review = await db("card_career_reviews").where({ id }).first();
  if (!review) throw new HttpError(404, "CARD_REVIEW_NOT_FOUND");
  const rows = await db("card_careers as c")
    .join("players as p", "p.id", "c.player_id")
    .select("c.player_id", "c.payload", "p.nickname");
  const current = rows.find(
    (r) => Number(r.player_id) === Number(review.player_id),
  );
  const before: Career | null = current
    ? careerSchema.parse(JSON.parse(current.payload))
    : null;
  const after = careerSchema.parse(JSON.parse(review.payload));
  const neighbors = (career: Career | null) => {
    const intervals = career ? effectiveTenures(career.tenures) : [];
    return rows
      .filter((row) => {
        const other = careerSchema.parse(JSON.parse(row.payload));
        if (
          Number(row.player_id) === Number(review.player_id) ||
          other.personKey === career?.personKey
        )
          return false;
        return effectiveTenures(other.tenures).some((b) =>
          intervals.some(
            (a) => a.teamId === b.teamId && a.start < b.end && b.start < a.end,
          ),
        );
      })
      .map((row) => ({ id: Number(row.player_id), nickname: row.nickname }));
  };
  const previous = neighbors(before),
    next = neighbors(after);
  return {
    before,
    after,
    added: next.filter((p) => !previous.some((old) => old.id === p.id)),
    removed: previous.filter((p) => !next.some((fresh) => fresh.id === p.id)),
    conflict: review.status === "conflict",
  };
}
