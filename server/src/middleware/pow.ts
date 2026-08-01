import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { getRequestPow } from '../services/pow';

export function requirePow(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS') return next();
  // Verification links are bearer tokens delivered through email and must work
  // when opened directly without a JavaScript PoW client.
  if (req.method === 'GET' && req.path === '/auth/email/verify') return next();
  const access = getRequestPow(req);
  const requiredDifficulty = req.method === 'POST' && req.path === '/auth/register'
    ? config.powRegisterDifficulty
    : config.powDifficulty;
  if (!access || access.difficulty < requiredDifficulty) {
    return res.status(428).json({ code: 'POW_REQUIRED', requiredDifficulty });
  }
  res.setHeader('X-PoW-Expires-At', String(access.expiresAt));
  res.setHeader('X-PoW-Expires-In', String(Math.max(0, access.expiresAt - Date.now())));
  next();
}
