import express, { Router } from 'express';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validateQuery } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { config } from '../config';
import { requestOwner } from './identity';
import { createSubmission, listSubmissions, contributorLeaderboard, submissionInput, submissionPageQuery } from './submissions';
import { z } from 'zod';
import { imageRequestBudget } from './workBudget';
import { SUBMISSION_LIMITS } from '@friberg/location-core';

const router = Router();
router.use(optionalAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', validateQuery(submissionPageQuery), asyncHandler(async (req, res) => {
  res.json(await listSubmissions(Number(req.query.page), requestOwner(req).key));
}));
router.get('/leaderboard',
  rateLimit({ name: 'location-contributors', limit: 30, windowSeconds: 60, key: requestIdentity, failClosed: true }),
  validateQuery(submissionPageQuery), asyncHandler(async (req, res) => {
    if (!config.showLeaderboard) throw new HttpError(404, 'FEATURE_DISABLED');
    res.json(await contributorLeaderboard(requestOwner(req), Number(req.query.page)));
  }));
router.post('/',
  rateLimit({ name: 'location-submission-ip', limit: SUBMISSION_LIMITS.ipPerHour, windowSeconds: 3600, failClosed: true }),
  rateLimit({ name: 'location-submission-identity', limit: SUBMISSION_LIMITS.identityPerHour, windowSeconds: 3600, key: requestIdentity, failClosed: true }),
  validateQuery(submissionInput),
  (req, _res, next) => {
    if (!req.is(['image/png', 'image/jpeg', 'image/webp'])) throw new HttpError(400, 'LOCATION_INVALID_ASSET');
    next();
  },
  imageRequestBudget,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '16mb' }),
  asyncHandler(async (req, res) => res.status(201).json(await createSubmission(
    requestOwner(req), req.query as unknown as z.infer<typeof submissionInput>, req.body
  ))));
export default router;
