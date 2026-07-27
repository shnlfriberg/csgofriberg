import crypto from 'crypto';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';

const TOKEN_PREFIX = 'csgf_';
const MAX_ACTIVE_TOKENS_PER_ADMIN = 20;

export interface ApiTokenView {
  id: number;
  name: string;
  prefix: string;
  created_at: string | Date;
  expires_at: string | Date;
}

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isApiTokenFormat(token: string): boolean {
  return /^csgf_[A-Za-z0-9_-]{43}$/.test(token);
}

export async function listApiTokens(userId: number): Promise<ApiTokenView[]> {
  await db('api_tokens')
    .where({ created_by_user_id: userId })
    .where('expires_at', '<=', new Date())
    .del();
  const tokens = await db('api_tokens')
    .where({ created_by_user_id: userId })
    .orderBy('created_at', 'desc')
    .limit(MAX_ACTIVE_TOKENS_PER_ADMIN)
    .select('id', 'name', 'prefix', 'created_at', 'expires_at');
  return tokens as ApiTokenView[];
}

export async function createApiToken(
  userId: number,
  name: string,
  expiresInDays: number
): Promise<ApiTokenView & { token: string }> {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const prefix = `${token.slice(0, 13)}...`;
  const id = await db.transaction(async (trx) => {
    const owner = await trx('users').where({ id: userId, role: 'admin' }).forUpdate().first('id');
    if (!owner) throw new HttpError(403, 'FORBIDDEN');
    await trx('api_tokens')
      .where({ created_by_user_id: userId })
      .where('expires_at', '<=', new Date())
      .del();
    const row = await trx('api_tokens')
      .where({ created_by_user_id: userId })
      .count<{ count: string | number }[]>({ count: 'id' });
    if (Number(row[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS_PER_ADMIN) {
      throw new HttpError(409, 'API_TOKEN_LIMIT_REACHED');
    }
    const [createdId] = await trx('api_tokens')
      .insert({
        name,
        token_hash: hashApiToken(token),
        prefix,
        created_by_user_id: userId,
        expires_at: expiresAt,
      })
      .returning('id')
      .then((rows) => rows.map((row: unknown) => (
        typeof row === 'object' && row !== null && 'id' in row ? row.id : row
      )));
    return Number(createdId);
  });
  const created = await db('api_tokens')
    .where({ id, created_by_user_id: userId })
    .first('id', 'name', 'prefix', 'created_at', 'expires_at');
  if (!created) throw new HttpError(500, 'INTERNAL_ERROR');
  return { ...(created as ApiTokenView), token };
}

export async function revokeApiToken(userId: number, tokenId: number): Promise<void> {
  const count = await db('api_tokens').where({ id: tokenId, created_by_user_id: userId }).del();
  if (!count) throw new HttpError(404, 'API_TOKEN_NOT_FOUND');
}
