import { z } from "zod";
import { HttpError } from "../middleware/common";

const id = z.number().int().positive();
const best = z
  .object({ path: z.array(id).min(2), elapsed: z.number().nonnegative() })
  .nullable();
const replaySchema = z.object({
  storageVersion: z.literal(1),
  match: z.object({
    id: z.string().uuid(),
    variant: z.enum(["limited", "unlimited"]),
    scene: z.enum(["practice", "daily", "friend", "ranked"]),
    day: z.string().nullable(),
    dailyPractice: z.boolean().optional(),
    rulesVersion: z.literal(1),
    graphVersion: z.string().length(64),
    questions: z
      .array(z.object({ start: id, end: id }))
      .min(1)
      .max(3),
  }),
  players: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        retired: z.boolean(),
        results: z.array(best).max(3),
      }),
    )
    .min(1)
    .max(8),
});

export function decodeReplay(payload: string) {
  try {
    return replaySchema.parse(JSON.parse(payload));
  } catch {
    throw new HttpError(503, "CARD_REPLAY_VERSION");
  }
}
