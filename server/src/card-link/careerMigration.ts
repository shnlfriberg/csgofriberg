import type { Knex } from "knex";
import { careerSchema } from "./careers";
import { tenureProjection } from "./careerProjection";
import { lockRow } from "./transaction";

/** Migration only: fill absent projection rows, never rewrite source JSON or
 * existing index rows. A failed parse/insert rolls back this entire backfill. */
export async function backfillCareerTenures(k: Knex): Promise<void> {
  await k.transaction(async (trx) => {
    // Share approval's lock: PostgreSQL must not mix a pre-approval payload
    // with post-approval ordinals while filling an incomplete projection.
    await lockRow(trx, "card_catalog", { id: 1 });
    const careers = await trx("card_careers").orderBy("player_id");
    const indexed = await trx("card_career_tenures").select("player_id", "ordinal");
    const existing = new Set(indexed.map(r => `${r.player_id}:${r.ordinal}`));
    for (const row of careers) {
      const career = careerSchema.parse(JSON.parse(row.payload));
      const missing = career.tenures.flatMap((_, ordinal) =>
        existing.has(`${row.player_id}:${ordinal}`) ? [] :
          [tenureProjection(Number(row.player_id), career, ordinal)],
      );
      // Stay below SQLite's conservative binding limit (seven columns/row).
      for (let offset = 0; offset < missing.length; offset += 100)
        await trx("card_career_tenures").insert(missing.slice(offset, offset + 100))
          .onConflict(["player_id", "ordinal"]).ignore();
    }
  });
}
