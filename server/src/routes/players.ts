import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validateQuery } from '../middleware/common';
import { getPublicPlayerList, searchCachedPlayers } from '../services/playerCache';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();
const playerSearchQuery = z.object({
  search: z.string().trim().max(100).default(''),
  suggest: z.enum(['0', '1']).default('0').transform((value) => value === '1'),
});

router.get(
  '/list',
  asyncHandler(async (req, res) => {
    const list = await getPublicPlayerList();
    const etag = `\"players-${list.version}\"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-Player-List-Version', list.version);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json(list);
  })
);

/**
 * 查选手 / 自动补全。
 * - ?search=xxx 模糊搜索昵称/队伍
 * - ?suggest=1 仅返回 id+nickname(猜测输入补全用,不泄露属性)
 */
router.get(
  '/',
  rateLimit({
    name: 'player-search',
    limit: 60,
    windowSeconds: 60,
    failClosed: true,
  }),
  validateQuery(playerSearchQuery),
  asyncHandler(async (req, res) => {
    const { search, suggest } = req.query as unknown as z.infer<typeof playerSearchQuery>;

    const players = searchCachedPlayers(search, suggest ? 10 : 100);

    if (suggest) {
      return res.json(players.map((p) => ({ id: p.id, nickname: p.nickname })));
    }
    res.json(
      players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        nationality: p.nationality,
        region: p.region,
        team: p.team,
        age: p.age,
        role: p.role,
        majorChampionships: p.major_championships,
        majorAppearances: p.major_appearances,
        isActive: Boolean(p.is_active),
      }))
    );
  })
);

export default router;
