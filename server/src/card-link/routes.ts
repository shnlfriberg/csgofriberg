import { reviewPreview } from "./reviewPreview";
import { cardDirectory } from './directory';
import { dailyLeaderboard } from "./leaderboard";
import { config } from "../config";
import { identityKeys, matchOwner } from "./claims";
import { queueBuild } from "./buildJobs";
import { Router, type Request } from "express";
import { z } from "zod";
import {
  optionalAuth,
  requireAuth,
  requireAdmin,
  userNameFromUsername,
} from "../middleware/auth";
import { asyncHandler, HttpError, validateBody, validateQuery } from "../middleware/common";
import { rateLimit, requestIdentity } from "../middleware/rateLimit";
import { db } from "../db/knex";
import { RULES } from "@friberg/card-link-core";
import {
  createMatch,
  readView,
  commandMatch,
  controlMatch,
  joinMatch,
  getMatch,
  today,
} from "./matches";
import { createMatchSchema, commandSchema, requestId, variantSchema } from "./validation";
import { queueMatch, cancelQueue, heartbeatQueue, QUEUE_LEASE_MS } from "./matchmaking";
import { activeReservation } from './reservations';
import {
  careerSubmissionSchema,
  exportCareers,
  submitCareer,
  reviewCareer,
} from "./careers";
import { loadGraph, publishGraph, rollbackGraph } from "./graphs";
import { configureScenes, sceneFlags } from './operations';
import { metricsSnapshot } from './metrics';
import type { Owner } from "./types";
import { notifyMatch } from "./socket";
export function ownerOf(req: Request): Owner {
  if (req.user)
    return {
      key: `u:${req.user.id}`,
      userId: req.user.id,
      name: userNameFromUsername(req.user.username),
    };
  if (!req.guestKey) throw new HttpError(401, "IDENTITY_REQUIRED");
  return {
    key: `g:${req.guestKey}`,
    userId: null,
    name: req.guestName ?? "Guest",
  };
}
const router = Router();
const pageQuery = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
const leaderboardQuery = z.object({ variant: variantSchema.default('unlimited') }).strict();
const dailyLeaderboardQuery = leaderboardQuery.extend({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
router.use(optionalAuth);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(
  rateLimit({
    name: "card-api",
    limit: 180,
    windowSeconds: 60,
    key: requestIdentity,
  }),
);
router.get(
  "/config",
  asyncHandler(async (_req, res) => {
    // Short private cache: scene switches still reach pages within 30 s.
    res.set("Cache-Control", "private, max-age=30");
    const c = await db("card_catalog").where({ id: 1 }).first();
    res.json({ enabled: Boolean(c?.enabled && c.graph_version), scenes: sceneFlags(c ?? {}), rules: RULES });
  }),
);
router.post(
  "/matches",
  validateBody(createMatchSchema),
  asyncHandler(async (req, res) => {
    const { scene, variant, difficulty, duration, requestId } = req.body;
    res.json(
      await createMatch(
        ownerOf(req),
        scene,
        variant,
        difficulty,
        duration,
        requestId,
      ),
    );
  }),
);
router.get(
  "/active",
  asyncHandler(async (req, res) => {
    const me = ownerOf(req),
      keys = await identityKeys(me);
    await db("card_queue")
      .where({ identity_key: me.key })
      .where("queued_at", "<", Date.now() - 120000)
      .delete();
    const reserved = await activeReservation(db, keys);
    const queuedRow = await db('card_queue').where({ identity_key: me.key }).first();
    const queue = queuedRow && JSON.parse(queuedRow.payload);
    const queued = !!queue?.heartbeatAt && queue.heartbeatAt > Date.now() - QUEUE_LEASE_MS;
    res.json({
      id: reserved?.match_id ?? null,
      queued,
      ticket: queued ? queue.ticket : null,
    });
  }),
);
router.get(
  "/matches/:id",
  asyncHandler(async (req, res) =>
    res.json(await readView(req.params.id, ownerOf(req))),
  ),
);
const directoryCache = new Map<string, { body: string; expiresAt: number }>();
router.get(
  "/matches/:id/directory",
  asyncHandler(async (req, res) => {
    // Membership only (indexed seat lookup); the directory itself is the same
    // for every member of a graph version and variant, so it is cached.
    const owner = await matchOwner(req.params.id, ownerOf(req));
    const seat = await db("card_seats").where({ match_id: req.params.id, identity_key: owner.key }).first("identity_key");
    if (!seat) throw new HttpError(403, "FORBIDDEN");
    const m = await getMatch(req.params.id);
    const cacheKey = `${m.questions[0].graphVersion}:${m.variant}`;
    let cached = directoryCache.get(cacheKey);
    if (!cached || cached.expiresAt <= Date.now()) {
      const g = await loadGraph(m.questions[0].graphVersion);
      cached = { body: JSON.stringify({ version: g.data.version, players: await cardDirectory(g.data.players, m.variant) }), expiresAt: Date.now() + 60_000 };
      directoryCache.set(cacheKey, cached);
      if (directoryCache.size > 32) directoryCache.delete(directoryCache.keys().next().value!);
    }
    // Revalidated with Express's ETag (304 without a body when unchanged).
    res.set("Cache-Control", "private, max-age=300");
    res.type("application/json").send(cached.body);
  }),
);
router.post(
  "/matches/:id/commands",
  validateBody(commandSchema),
  asyncHandler(async (req, res) => {
    const result = await commandMatch(req.params.id, ownerOf(req), req.body);
    res.json(result);
    void notifyMatch(req.params.id).catch(() => undefined);
  }),
);
router.post(
  "/matches/:id/control",
  validateBody(
    z
      .object({ action: z.enum(["ready", "start", "leave"]), requestId })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await controlMatch(
        req.params.id,
        ownerOf(req),
        req.body.action,
        req.body.requestId,
      ),
    );
    void notifyMatch(req.params.id).catch(() => undefined);
  }),
);
router.post(
  "/join",
  validateBody(z.object({ code: z.string().regex(/^[A-F0-9]{8}$/) }).strict()),
  asyncHandler(async (req, res) => {
    const result = await joinMatch(req.body.code, ownerOf(req));
    res.json(result);
    void notifyMatch(result.id).catch(() => undefined);
  }),
);
router.post(
  "/queue",
  validateBody(z.object({ variant: variantSchema }).strict()),
  asyncHandler(async (req, res) =>
    res.json(await queueMatch(ownerOf(req), req.body.variant)),
  ),
);
router.delete(
  "/queue",
  validateBody(z.object({ ticket: requestId.optional() }).strict()),
  asyncHandler(async (req, res) => res.json(await cancelQueue(ownerOf(req), req.body.ticket))),
);
router.post('/queue/heartbeat', validateBody(z.object({ ticket: requestId }).strict()),
  asyncHandler(async (req, res) => res.json(await heartbeatQueue(ownerOf(req), req.body.ticket))));
router.get(
  "/leaderboard",
  validateQuery(leaderboardQuery),
  asyncHandler(async (req, res) => {
    if (!config.showLeaderboard) throw new HttpError(404, "FEATURE_DISABLED");
    const variant = variantSchema.parse(req.query.variant ?? "unlimited");
    const rows = await db("card_ratings as r")
      .join("users as u", "u.id", "r.user_id")
      .where({ "r.variant": variant, "u.leaderboard_hidden": false })
      .whereNull("u.banned_at")
      .orderBy("r.rating", "desc")
      .limit(100)
      .select("u.username", "r.rating");
    res.json(
      rows.map((r) => ({
        username: userNameFromUsername(r.username),
        rating: r.rating,
      })),
    );
  }),
);
router.get(
  "/daily-leaderboard",
  validateQuery(dailyLeaderboardQuery),
  asyncHandler(async (req, res) => {
    const variant = variantSchema.parse(req.query.variant ?? "unlimited");
    const day = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .parse(req.query.day ?? today());
    res.json(await dailyLeaderboard(variant, day));
  }),
);
export default router;
export const adminCardRoutes = Router();
adminCardRoutes.use(requireAuth, requireAdmin);
adminCardRoutes.get(
  "/careers",
  asyncHandler(async (_req, res) => res.json(await exportCareers())),
);
adminCardRoutes.post(
  "/careers",
  validateBody(careerSubmissionSchema.extend({ requestId })),
  asyncHandler(async (req, res) => {
    const { requestId, ...input } = req.body;
    res.json(await submitCareer(input, `admin:${req.user!.id}`, requestId));
  }),
);
adminCardRoutes.get(
  "/reviews",
  validateQuery(pageQuery),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page);
    res.json(
      await db("card_career_reviews")
        .whereIn("status", ["pending", "conflict"])
        .orderBy("created_at")
        .limit(50)
        .offset(page * 50),
    );
  }),
);
adminCardRoutes.get(
  "/reviews/:id/preview",
  asyncHandler(async (req, res) =>
    res.json(await reviewPreview(req.params.id)),
  ),
);
adminCardRoutes.post(
  "/reviews/:id",
  validateBody(z.object({ approve: z.boolean() }).strict()),
  asyncHandler(async (req, res) =>
    res.json(await reviewCareer(req.params.id, req.body.approve, req.user!.id)),
  ),
);
adminCardRoutes.post(
  "/build",
  asyncHandler(async (_req, res) => res.json(await queueBuild())),
);
adminCardRoutes.get(
  "/graphs",
  asyncHandler(async (_req, res) =>
    res.json({
      jobs: await db("card_build_jobs").orderBy("due_at", "desc").limit(10),
      catalog: await db("card_catalog").where({ id: 1 }).first(),
      graphs: await db("card_graphs")
        .orderBy("created_at", "desc")
        .limit(30)
        .select("version", "source_revision", "created_at", "source_hash", "published_at"),
      events: await db('card_admin_events').orderBy('created_at', 'desc').limit(30),
      monitoring: { ...metricsSnapshot(), outbox: await db('card_outbox').count({ pending: '*' }).min({ oldestDueAt: 'due_at' }).max({ maxAttempts: 'attempts' }).first() },
      outbox: await db("card_outbox").where("attempts", ">=", 10).limit(30),
    }),
  ),
);
adminCardRoutes.post(
  "/publish",
  validateBody(z.object({ version: z.string().length(64) })),
  asyncHandler(async (req, res) =>
    res.json(await publishGraph(req.body.version, req.user!.id)),
  ),
);
adminCardRoutes.post(
  "/enabled",
  validateBody(z.object({ enabled: z.boolean().optional(), scenes: z.object({ practice: z.boolean().optional(), daily: z.boolean().optional(), friend: z.boolean().optional(), ranked: z.boolean().optional() }).strict().optional() }).strict().refine(v => v.enabled !== undefined || Object.keys(v.scenes ?? {}).length > 0)),
  asyncHandler(async (req, res) => {
    res.json(await configureScenes(req.body, req.user!.id));
  }),
);
adminCardRoutes.post('/rollback',
  validateBody(z.object({ version: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(300) }).strict()),
  asyncHandler(async (req, res) => res.json(await rollbackGraph(req.body.version, req.body.expectedVersion, req.body.reason, req.user!.id))));
adminCardRoutes.post(
  "/outbox/:id/retry",
  asyncHandler(async (req, res) => {
    await db("card_outbox")
      .where({ match_id: req.params.id })
      .update({ attempts: 0, due_at: Date.now(), error: null });
    res.json({ ok: true });
  }),
);
