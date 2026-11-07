import { z } from "zod";
export const variantSchema = z.enum(["unlimited", "limited"]);
export const requestId = z.string().regex(/^[\w-]{8,64}$/);
// 单人 (practice) starts through the shared single-player API (/api/game).
export const createMatchSchema = z.object({
  scene: z.enum(["daily", "friend"]),
  variant: variantSchema,
  difficulty: z.enum(["easy", "normal", "hard"]).default("normal"),
  duration: z.union([z.literal(0), z.literal(120), z.literal(180), z.literal(300)]).default(180),
  requestId,
}).strict().refine(value => value.duration !== 0 || value.scene !== "friend", {
  path: ["duration"], message: "Unlimited time is available only for single-player games",
});
const id = z.number().int().positive();
export const commandSchema = z
  .object({
    requestId,
    revision: z.number().int().nonnegative(),
    phaseRevision: z.number().int().nonnegative(),
    command: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("play"),
          playerId: id,
          index: z.number().int().min(0).max(10000),
        })
        .strict(),
      z.object({ type: z.literal("remove"), playerId: id }).strict(),
      z
        .object({ type: z.literal("reorder"), board: z.array(id).max(10000) })
        .strict(),
      z.object({ type: z.literal("swap"), playerId: id }).strict(),
      z.object({ type: z.literal("refresh") }).strict(),
      z.object({ type: z.literal("lock") }).strict(),
    ]),
  })
  .strict();
