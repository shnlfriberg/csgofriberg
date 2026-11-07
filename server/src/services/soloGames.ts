/**
 * Entertainment single-player games on the shared `/api/game` API.
 *
 * Classic and 海龟汤 games live in the shared single-game store. 图寻 单人 and
 * 卡牌连接 单人 keep their own authoritative storage (图寻 Redis state plus SQL
 * results, 卡牌 SQL matches), so they plug in as adapters: the routes keep one
 * contract for every variant — `POST /start` creates or resumes the identity's
 * game for `mode` + `variant`, and `/:id/state|guess|command|giveup|exit` are
 * dispatched by the variant that owns the game id.
 */
export interface SoloOwner {
  key: string;
  userId: number | null;
  guestKey: string | null;
  name: string;
}

export interface SoloContext {
  owner: SoloOwner;
  /** Request header lookup (lower-case names), e.g. the maps a page holds. */
  header(name: string): string | undefined;
}

export interface SoloVariantAdapter {
  /** Create or resume this identity's game for `mode` (the difficulty). */
  start(ctx: SoloContext, mode: string, options: Record<string, unknown>): Promise<object>;
  /** Whether `id` is a game of this variant owned by `owner`. */
  owns(id: string, owner: SoloOwner): Promise<boolean>;
  state(ctx: SoloContext, id: string): Promise<object>;
  guess?(ctx: SoloContext, id: string, body: unknown): Promise<object>;
  command?(ctx: SoloContext, id: string, body: unknown): Promise<object>;
  giveup?(ctx: SoloContext, id: string, body: unknown): Promise<object>;
  exit(ctx: SoloContext, id: string): Promise<void>;
}
