import type { Variant } from "@friberg/card-link-core";
import { config } from "../config";
import { db } from "../db/knex";
import { userNameFromUsername } from "../middleware/auth";
import { HttpError } from "../middleware/common";

export async function dailyLeaderboard(variant: Variant, day: string) {
  if (!config.showLeaderboard) throw new HttpError(404, "FEATURE_DISABLED");
  // Rank all settled attempts before limiting the board. Each account contributes
  // one real result (hops first, then elapsed), including claimed guest retries.
  const attempts = db("card_participants as p")
    .join("users as u", "u.id", "p.user_id")
    .where({
      "p.scene": "daily",
      "p.variant": variant,
      "p.day": day,
      "u.leaderboard_hidden": false,
    })
    .whereNull("u.banned_at")
    .where("p.solved", ">", 0)
    .select(
      "u.id",
      "u.username",
      "p.hops",
      "p.elapsed",
    )
    .rowNumber('attempt_rank', function () {
      this.partitionBy('p.user_id').orderBy('p.hops').orderBy('p.elapsed').orderBy('p.match_id');
    });
  const rows = await db.from(attempts.as('best'))
    .where('attempt_rank', 1)
    .select('id', 'username', 'hops', 'elapsed')
    .orderBy('hops').orderBy('elapsed').orderBy('id').limit(100);
  return rows
    .map((row) => ({
      username: userNameFromUsername(row.username),
      hops: Number(row.hops),
      elapsed: Number(row.elapsed),
    }));
}
