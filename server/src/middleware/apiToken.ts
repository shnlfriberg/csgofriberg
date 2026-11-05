import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/knex';
import { hashApiToken, isApiTokenFormat } from '../services/apiTokens';

import { readTokenScopes, type ApiTokenScope } from '../services/apiTokenScopes';

declare global {
  namespace Express {
    interface Request {
      apiToken?: {
        scopes: ApiTokenScope[];
        id: number;
        name: string;
        createdByUserId: number;
      };
    }
  }
}

function expiresAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  return new Date(String(value)).getTime();
}

export async function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const authorization = req.headers.authorization;
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match || !isApiTokenFormat(match[1])) {
    return res.status(401).json({ code: 'API_TOKEN_REQUIRED' });
  }
  try {
    const row = await db('api_tokens as token')
      .join('users as owner', 'owner.id', 'token.created_by_user_id')
      .where({ 'token.token_hash': hashApiToken(match[1]), 'owner.role': 'admin' })
      .first(
        'token.id',
        'token.name',
        'token.created_by_user_id',
        'token.expires_at', 'token.scopes'
      );
    if (!row || expiresAtMs(row.expires_at) <= Date.now()) {
      return res.status(401).json({ code: 'API_TOKEN_INVALID' });
    }
    req.apiToken = {
      scopes: readTokenScopes(row.scopes),
      id: Number(row.id),
      name: String(row.name),
      createdByUserId: Number(row.created_by_user_id),
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireApiScope(scope: ApiTokenScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.apiToken?.scopes.includes(scope)) return res.status(403).json({ code: 'API_TOKEN_SCOPE_REQUIRED' });
    next();
  };
}
