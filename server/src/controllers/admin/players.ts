import { z } from 'zod';
import { db } from '../../db/knex';
import { asyncHandler } from '../../middleware/common';
import { createPlayer, deletePlayer, importPlayers, updatePlayer } from '../../services/playerMutations';
import { normalizeTeamHistory } from '../../services/teamHistory';
import { exportPlayers } from '../../services/playerExport';
import { listPlayerChangeItems, reviewPlayerChangeItems } from '../../services/playerChangeSubmissions';
import { playerListQuerySchema, idParamsSchema, playerChangeListQuerySchema, playerChangeReviewSchema } from '../../routes/adminSchemas';

export const listPlayers = asyncHandler(async (req, res) => {
    const parsed = req.query as unknown as z.infer<typeof playerListQuerySchema>;
    const { pageSize, search } = parsed;
    const query = db('players');
    if (search) {
      query.where((builder) => {
        builder.whereILike('nickname', `%${search}%`)
          .orWhereILike('nationality', `%${search}%`)
          .orWhereILike('region', `%${search}%`)
          .orWhereILike('team', `%${search}%`);
      });
    }
    const countRow = await query.clone().count({ count: 'id' }).first();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.page, totalPages);
    const players = await query.clone()
      .orderBy('nickname')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const playerIds = players.map((player) => Number(player.id));
    const memberships = playerIds.length
      ? await db('player_difficulties')
        .whereIn('player_id', playerIds)
        .orderBy('difficulty_key')
        .select('player_id', 'difficulty_key')
      : [];
    const difficultiesByPlayer = new Map<number, string[]>();
    for (const membership of memberships) {
      const list = difficultiesByPlayer.get(Number(membership.player_id)) ?? [];
      list.push(String(membership.difficulty_key));
      difficultiesByPlayer.set(Number(membership.player_id), list);
    }
    res.json({
      players: players.map((player) => ({
        ...player,
        team_history: normalizeTeamHistory(player.team_history),
        difficulties: difficultiesByPlayer.get(Number(player.id)) ?? [],
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  });

export const listPlayerChangeSubmissions = asyncHandler(async (req, res) => {
    res.json(await listPlayerChangeItems(
      req.query as unknown as z.infer<typeof playerChangeListQuerySchema>
    ));
  });

export const reviewPlayerChanges = asyncHandler(async (req, res) => {
    const { itemIds, decision } = req.body as z.infer<typeof playerChangeReviewSchema>;
    res.json(await reviewPlayerChangeItems(itemIds, decision, req.user!.id));
  });

export const exportPlayerList = asyncHandler(async (_req, res) => {
    res.attachment('players.json').json(await exportPlayers());
  });

export const addPlayer = asyncHandler(async (req, res) => {
    res.json({ id: await createPlayer(req.body) });
  });

export const editPlayer = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await updatePlayer(id, req.body);
    res.json({ ok: true });
  });

export const removePlayer = asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
    await deletePlayer(id);
    res.json({ ok: true });
  });

export const importPlayerList = asyncHandler(async (req, res) => {
    res.json(await importPlayers(req.body.players));
  });
