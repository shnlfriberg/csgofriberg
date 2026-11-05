import type { Knex } from "knex";
import { db } from "../db/knex";
import { careerSchema } from "./careers";
import { playerTimelineAt, timelineDate } from "./timeline";

/** One statement gives a consistent approved snapshot on SQLite and PG.
 * Include disabled historical records: enablement is a game pool setting,
 * not evidence that a person was absent from a historical roster.
 * This data-tool query deliberately stays outside the gameplay hot path. */
export async function queryPlayerTimelineAt(
  playerId: number,
  at: string,
  reader: Knex | Knex.Transaction = db,
) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("INVALID_PLAYER_ID");
  const day = timelineDate(at);
  const rows = await reader("players as p")
    .leftJoin("card_careers as c", "c.player_id", "p.id")
    .select("p.id", "p.nickname", "c.payload");
  return playerTimelineAt(rows.map(row => ({
    playerId: Number(row.id),
    nickname: String(row.nickname),
    career: row.payload === null ? null : careerSchema.parse(JSON.parse(row.payload)),
  })), playerId, day);
}
