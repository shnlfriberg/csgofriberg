import type { Server } from 'socket.io';
import { z } from 'zod';
import { db } from '../../db/knex';
import { asyncHandler, HttpError } from '../../middleware/common';
import { invalidateCached } from '../../services/queryCache';
import { publishResourceVersion } from '../../services/resourceVersion';
import { createApiToken, listApiTokens, revokeApiToken } from '../../services/apiTokens';
import { idParamsSchema } from '../../routes/adminSchemas';

export const getApiTokens = asyncHandler(async (req, res) => {
    res.json({ tokens: await listApiTokens(req.user!.id) });
  });

export const addApiToken = asyncHandler(async (req, res) => {
    const token = await createApiToken(
      req.user!.id,
      req.body.name,
      req.body.expiresInDays
    );
    res.status(201).json(token);
  });

export const revokeApiTokenForAdmin = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await revokeApiToken(req.user!.id, id);
    res.json({ ok: true });
  });

export const addAnnouncement = asyncHandler(async (req, res) => {
    const [id] = await db('announcements')
      .insert(req.body)
      .returning('id')
      .then((rows) => rows.map((r: any) => (typeof r === 'object' ? r.id : r)));
    await invalidateCached('announcements');
    res.json({ id });
  });

export const deleteAnnouncement = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    const count = await db('announcements').where({ id }).del();
    if (!count) throw new HttpError(404, 'NOT_FOUND');
    await invalidateCached('announcements');
    res.json({ ok: true });
  });

export const broadcastResourceVersion = asyncHandler(async (req, res) => {
    const io = req.app.get('io') as Server | undefined;
    if (!io) throw new HttpError(503, 'SERVICE_UNAVAILABLE');
    const notice = await publishResourceVersion(req.body.version);
    io.emit('resource:version', notice);
    res.json(notice);
  });
