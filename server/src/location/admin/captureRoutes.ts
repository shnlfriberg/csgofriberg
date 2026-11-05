import { db } from '../../db/knex';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validateBody } from '../../middleware/common';
import { captureAssetSchema, capturePointSchema } from '../validation';
import {
  listCaptureDrafts,
  saveCapturePoints,
  attachCaptureAsset,
  removeCaptureDraft,
  appendCaptureImage,
  removeCaptureImage,
} from './captures';

export const captureDraftRoutes = Router();
const version = z.number().int().positive();

captureDraftRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const revision = String((await db('location_catalog_revision').where({ id: 1 }).first())?.revision ?? -1);
    if (revision !== '-1' && req.query.revision === revision) { res.json({ revision, unchanged: true }); return; }
    res.json({ revision, items: await listCaptureDrafts() });
  })
);
captureDraftRoutes.post(
  '/',
  validateBody(
    z
      .object({
        points: z
          .array(capturePointSchema)
          .min(1)
          .max(500)
          .refine(
            (points) => new Set(points.map((p) => p.id)).size === points.length
          ),
      })
      .strict()
  ),
  asyncHandler(async (req, res) => {
    res.json({ items: await saveCapturePoints(req.body.points) });
  })
);
captureDraftRoutes.patch(
  '/:id/asset',
  validateBody(z.object({ version, asset: captureAssetSchema }).strict()),
  asyncHandler(async (req, res) => {
    res.json(
      await attachCaptureAsset(req.params.id, req.body.version, req.body.asset)
    );
  })
);
captureDraftRoutes.delete(
  '/:id',
  validateBody(z.object({ version }).strict()),
  asyncHandler(async (req, res) => {
    await removeCaptureDraft(req.params.id, req.body.version);
    res.json({ ok: true });
  })
);
captureDraftRoutes.post(
  '/:id/images',
  validateBody(z.object({ version, imageId: z.string().uuid(), asset: captureAssetSchema }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await appendCaptureImage(req.params.id, req.body.version, req.body.imageId, req.body.asset));
  })
);
captureDraftRoutes.delete(
  '/:id/images/:imageId',
  validateBody(z.object({ version }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await removeCaptureImage(req.params.id, req.params.imageId, req.body.version));
  })
);
