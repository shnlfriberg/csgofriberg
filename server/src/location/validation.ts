import { z } from 'zod';
export const difficultySchema = z.enum(['easy', 'normal', 'hard']);
const name = z.string().trim().min(1).max(100);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const startGameSchema = z.object({
  mode: z.enum(['random', 'daily']),
  difficulty: difficultySchema,
  bannedMapIds: z.array(id).max(2).refine(ids => new Set(ids).size === ids.length).default([]),
}).refine(input => input.mode === 'random' || input.bannedMapIds.length === 0);
const unit = z.number().finite().min(0).max(1);
const asset = z
  .string()
  .max(150)
  .regex(/^\/location-assets\/[a-f0-9-]{36}(?:-thumb)?\.webp$/);
export const guessSchema = z.object({
  mapId: id,
  floorId: id,
  u: unit,
  v: unit,
});
export const captureAssetSchema = z
  .object({
    url: asset,
    thumbnailUrl: asset,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const capturePointSchema = guessSchema
  .extend({
    id: z.string().uuid(),
    batchId: z.string().uuid(),
    batchName: name,
    order: z.number().int().min(1).max(10000),
    capturePointId: id,
  })
  .strict();
export const captureDraftSchema = capturePointSchema.extend({
  version: z.number().int().positive(),
  mapVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  asset: captureAssetSchema.optional(),
  images: z.array(z.object({
    id: z.string().uuid(),
    asset: captureAssetSchema,
    createdAt: z.string().datetime(),
  }).strict()).max(100).optional(),
  world: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().optional(),
});
export const answerSchema = guessSchema
  .extend({
    round: z.number().int().min(1).max(5),
    requestId: z.string().uuid(),
    version: z.number().int().min(0),
  })
  .strict();
export const mapSchema = z
  .object({
    id,
    name,
    enabled: z.boolean(),
    order: z.number().int().min(0).max(100),
    version: z.number().int().min(1),
    width: z.number().int().min(64).max(4096),
    height: z.number().int().min(64).max(4096),
    bounds: z
      .object({
        u: unit,
        v: unit,
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      })
      .refine((b) => b.u + b.width <= 1 && b.v + b.height <= 1),
    floors: z
      .array(
        z.object({
          id,
          name,
          radarUrl: z.union([
            asset,
            z
              .string()
              .regex(
                /^\/location-radars\/de_[a-z0-9]+_(?:main|upper|lower)\.webp$/
              ),
            z.literal(''),
          ]),
        })
      )
      .min(1)
      .max(8)
      .refine((f) => new Set(f.map((i) => i.id)).size === f.length),
    calibration: z.object({
      posX: z.number().finite(),
      posY: z.number().finite(),
      scale: z.number().positive(),
      points: z
        .array(
          z.object({
            x: z.number().finite(),
            y: z.number().finite(),
            u: unit,
            v: unit,
            floorId: id,
          })
        )
        .max(100),
    }),
  })
  .strict();
export const questionSchema = guessSchema
  .extend({
    id: id.optional(),
    version: z.number().int().positive().optional(),
    mapVersion: z.number().int().positive().optional(),
    capturePointId: id,
    tier: z.enum(['easy', 'medium', 'hard']),
    imageUrl: asset,
    thumbnailUrl: asset,
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z
      .enum(['draft', 'review', 'published', 'disabled'])
      .default('draft'),
    capturedAt: z.string().datetime().default(() => new Date().toISOString()),
    build: z.string().trim().max(100).default(''),
    source: z.string().trim().max(500).default(''),
    world: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .optional(),
    view: z
      .object({
        pitch: z.number().finite(),
        yaw: z.number().finite(),
        roll: z.number().finite(),
        fov: z.number().positive().lt(180),
      })
      .optional(),
  })
  .strict();
