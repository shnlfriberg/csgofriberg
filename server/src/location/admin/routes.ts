import { retryResult } from '../resultOutbox';
import express, { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import { asyncHandler, HttpError, validateBody } from '../../middleware/common';
import { rateLimit, requestIdentity } from '../../middleware/rateLimit';
import { uploadAsset } from '../assets';
import { ensureDaily } from '../games';
import { exportBank, importBank, previewBank, stageBank } from '../bank';
import { captureDraftRoutes } from './captureRoutes';
import { mapSchema, questionSchema } from '../validation';
import { saveMap } from './maps';
import { publishQuestions, saveQuestion } from './questions';
import { getOverview, checkBank } from './overview';
import { listSubmissions, reviewSubmission, submissionPageQuery, submissionReview } from '../submissions';
import { validateQuery, validateParams } from '../../middleware/common';
import { locationMetrics, observeMetric } from '../metrics';
import { imageBudget, imageRequestBudget } from '../workBudget';
import { assetInventory } from '../assetInventory';
import { db } from '../../db/knex';
import { questionQuery, queryQuestions } from './questionQuery';
import { listMergePoints, mergePoints, mergePointQuery, mergePointsSchema } from './pointMerge';

export const adminLocationRoutes = Router();
adminLocationRoutes.use(requireAuth, requireAdmin);
adminLocationRoutes.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

adminLocationRoutes.use((req, res, next) => {
  const start = performance.now();
  res.once('finish', () => observeMetric(`admin.${req.method}.${req.route?.path || 'other'}`, performance.now() - start));
  next();
});
adminLocationRoutes.get('/metrics', asyncHandler(async (_req, res) => {
  const outbox = await db('location_result_outbox').count({ pending: '*' }).min({ oldestDueAt: 'due_at' }).max({ maxAttempts: 'attempts' }).first();
  const deletions = await db('location_asset_tasks').count({ pending: '*' }).first();
  const deadLetters = await db('location_result_outbox').where('attempts', '>=', 10).count({ count: '*' }).first();
  res.json({ ...locationMetrics(), imageBudget: imageBudget(), outbox: { ...outbox, deadLetters: Number(deadLetters?.count || 0) }, deletions });
}));
adminLocationRoutes.get('/outbox', asyncHandler(async (_req, res) => {
  res.json({ items: await db('location_result_outbox').orderBy('due_at').limit(100).select('game_id', 'attempts', 'due_at', 'last_error') });
}));
adminLocationRoutes.get('/assets/inventory', asyncHandler(async (_req, res) => res.json(await assetInventory())));
adminLocationRoutes.get(
  '/bank/export',
  asyncHandler(async (_req, res) => {
    res.attachment(
      `location-bank-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })}.zip`
    );
    try {
      await exportBank(res);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else throw error;
    }
  })
);
adminLocationRoutes.post(
  '/bank/preview',
  rateLimit({
    name: 'location-bank-upload',
    limit: 6,
    windowSeconds: 3600,
    key: requestIdentity,
  }),
  asyncHandler(async (req, res) => {
    if (!req.is('application/zip') && !req.is('application/octet-stream'))
      throw new HttpError(400, 'LOCATION_BANK_INVALID');
    if (Number(req.headers['content-length']) > 1024 * 1024 * 1024)
      throw new HttpError(413, 'LOCATION_BANK_TOO_LARGE');
    res.json(await stageBank(req, req.user!.id));
  })
);
adminLocationRoutes.post(
  '/assets',
  rateLimit({ name: 'location-admin-assets', limit: 60, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  imageRequestBudget,
  express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
    limit: '16mb',
  }),
  asyncHandler(async (req, res) => {
    const purpose = z
      .enum(['question', 'radar'])
      .default('question')
      .safeParse(req.query.purpose);
    if (!purpose.success) throw new HttpError(400, 'VALIDATION_FAILED');
    res.json(await uploadAsset(req.body, purpose.data, `u:${req.user!.id}`));
  })
);
adminLocationRoutes.use(express.json({ limit: '2mb' }));
adminLocationRoutes.get('/points', validateQuery(mergePointQuery), asyncHandler(async (req, res) =>
  res.json(await listMergePoints(String(req.query.mapId), String(req.query.floorId)))));
adminLocationRoutes.get('/submission-points', validateQuery(mergePointQuery), asyncHandler(async (req, res) =>
  res.json(await listMergePoints(String(req.query.mapId), String(req.query.floorId), true))));
adminLocationRoutes.post('/points/merge', validateBody(mergePointsSchema), asyncHandler(async (req, res) =>
  res.json(await mergePoints(req.body))));
adminLocationRoutes.post('/outbox/:id/retry', asyncHandler(async (req, res) => {
  await retryResult(req.params.id);
  res.json({ ok: true });
}));
adminLocationRoutes.get('/submissions', validateQuery(submissionPageQuery),
  asyncHandler(async (req, res) => res.json(await listSubmissions(Number(req.query.page)))));
adminLocationRoutes.post('/submissions/:id/review',
  rateLimit({ name: 'location-submission-review', limit: 60, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateParams(z.object({ id: z.string().uuid() })), validateBody(submissionReview),
  asyncHandler(async (req, res) => res.json(await reviewSubmission(req.params.id, req.body))));
adminLocationRoutes.use('/capture-drafts', captureDraftRoutes);
const transferInput = z
  .object({
    token: z.string().uuid(),
    updateQuestions: z.boolean().default(false),
  })
  .strict();
adminLocationRoutes.post(
  '/bank/recheck',
  validateBody(transferInput),
  asyncHandler(async (req, res) =>
    res.json(
      await previewBank(req.body.token, req.user!.id, req.body.updateQuestions)
    )
  )
);
adminLocationRoutes.post(
  '/bank/import',
  validateBody(
    transferInput.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  ),
  asyncHandler(async (req, res) =>
    res.json(
      await importBank(
        req.body.token,
        req.user!.id,
        req.body.fingerprint,
        req.body.updateQuestions
      )
    )
  )
);

adminLocationRoutes.get(
  '/overview',
  asyncHandler(async (req, res) => res.json(await getOverview(req.query.compact === '1', req.query.daily === '1')))
);
adminLocationRoutes.get('/questions', validateQuery(questionQuery), asyncHandler(async (req, res) => res.json(await queryQuestions(req.query as any))));
adminLocationRoutes.get('/questions/pending', asyncHandler(async (_req, res) => {
  const rows = await db('location_questions').whereIn('status', ['draft', 'review']).orderBy('id').select('id', 'payload');
  res.json({ items: rows.map(row => ({ id: row.id, version: JSON.parse(row.payload).version })) });
}));
adminLocationRoutes.get('/questions/:id', asyncHandler(async (req, res) => {
  const row = await db('location_questions').where({ id: req.params.id }).first('payload');
  if (!row) throw new HttpError(404, 'LOCATION_QUESTION_NOT_FOUND');
  const question = JSON.parse(row.payload);
  const world = db.client.config.client === 'pg' ? "payload::jsonb ->> 'world'" : "json_extract(payload, '$.world')";
  const reference = await db('location_questions').where({ map_id: question.mapId, point_id: question.capturePointId }).whereNot({ id: question.id }).whereRaw(`${world} is not null`).orderBy('id').first('payload');
  res.json({ question, reference: reference ? JSON.parse(reference.payload) : null });
}));
adminLocationRoutes.get(
  '/checks',
  asyncHandler(async (_req, res) => res.json(await checkBank()))
);
adminLocationRoutes.put(
  '/maps/:id',
  validateBody(mapSchema),
  asyncHandler(async (req, res) => {
    if (req.body.id !== req.params.id)
      throw new HttpError(400, 'VALIDATION_FAILED');
    res.json(await saveMap(req.body));
  })
);
adminLocationRoutes.post(
  '/questions',
  validateBody(questionSchema),
  asyncHandler(async (req, res) => res.json(await saveQuestion(req.body)))
);
adminLocationRoutes.post(
  '/questions/publish',
  validateBody(z.object({
    questions: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      version: z.number().int().positive(),
    }).strict()).min(1).max(500)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  }).strict()),
  asyncHandler(async (req, res) => res.json(await publishQuestions(req.body.questions)))
);
adminLocationRoutes.post(
  '/capture-drafts/:id/complete',
  validateBody(
    z
      .object({
        version: z.number().int().positive(),
        imageId: z.string().uuid().optional(),
        question: questionSchema,
      })
      .strict()
  ),
  asyncHandler(async (req, res) =>
    res.json(
      await saveQuestion(
        { ...req.body.question, id: req.body.imageId || req.params.id },
        { id: req.params.id, version: req.body.version, imageId: req.body.imageId }
      )
    )
  )
);
adminLocationRoutes.post(
  '/questions/import',
  validateBody(
    z.object({ questions: z.array(questionSchema).min(1).max(500) })
  ),
  asyncHandler(async (req, res) => {
    const results = [];
    for (const input of req.body.questions)
      try {
        results.push({ ok: true, question: await saveQuestion(input) });
      } catch (error) {
        results.push({
          ok: false,
          code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
          id: input.id || null,
        });
      }
    res.json({ results });
  })
);
adminLocationRoutes.post(
  '/daily/generate',
  asyncHandler(async (_req, res) => res.json(await ensureDaily()))
);
