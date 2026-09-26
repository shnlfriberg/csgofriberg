// Admin HTTP contracts are shared by the route declarations and handlers.
import { z } from 'zod';

export const playerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  search: z.string().trim().max(100).default(''),
});

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  search: z.string().trim().max(64).default(''),
});

export const userGameListQuerySchema = z.object({
  type: z.enum(['single', 'multi']).default('single'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(5).max(30).default(10),
});

export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const userLeaderboardVisibilitySchema = z.object({ hidden: z.boolean() });

export const userMatchmakingRestrictionSchema = z.object({ restricted: z.boolean() });

export const banSchema = z.object({ banned: z.boolean() });

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export const userGameReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  gameId: z.coerce.number().int().positive(),
});

export const userMatchReplayParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  matchId: z.coerce.number().int().positive(),
});

export const reportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(['all', 'pending', 'resolved', 'dismissed']).default('all'),
  reporterFilter: z.enum(['all', 'multiple', 'single']).default('all'),
  search: z.string().trim().max(64).default(''),
});

export const reportParamsSchema = z.object({ reportId: z.coerce.number().int().positive() });

export const reportIdentityKeySchema = z.string().trim().min(3).max(80)
  .refine((key) => key.startsWith('u:') || key.startsWith('g:'));

export const reportUpdateSchema = z.object({
  status: z.enum(['pending', 'resolved', 'dismissed']),
  adminNote: z.string().trim().max(500).default(''),
});

export const reportBatchUpdateSchema = reportUpdateSchema.extend({
  reportedKey: reportIdentityKeySchema,
});

export const reportSelectedUpdateSchema = reportUpdateSchema.extend({
  reportIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const reportWhitelistSchema = z.object({
  reportedKey: reportIdentityKeySchema,
  adminNote: z.string().trim().max(500).default(''),
});

export const reportWhitelistParamsSchema = z.object({
  reportedKey: reportIdentityKeySchema,
});

export const analysisRequestSchema = z.object({
  locale: z.enum(['zh-CN', 'en-US', 'ja-JP']).default('zh-CN'),
});

export const reportQuickDismissSchema = z.object({
  adminNote: z.string().trim().min(1).max(500),
  reportedKeys: z.array(reportIdentityKeySchema).min(1).max(100),
});

export const playerChangeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(['all', 'pending', 'approved', 'rejected', 'conflict']).default('pending'),
  search: z.string().trim().max(100).default(''),
});

export const playerChangeReviewSchema = z.object({
  itemIds: z.array(z.number().int().positive()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  decision: z.enum(['approve', 'reject']),
}).strict();

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(128),
  content: z.string().trim().min(1).max(10000),
  is_popup: z.boolean().default(false),
});

export const resourceVersionBroadcastSchema = z.object({
  version: z.string().trim().regex(/^\d{13}$/),
});
