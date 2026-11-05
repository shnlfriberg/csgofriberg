import type { Request } from 'express';
import { userNameFromUsername } from '../middleware/auth';
import { HttpError } from '../middleware/common';
import type { Identity } from './types';

export function requestOwner(req: Request): Identity {
  if (req.user) return { key: `u:${req.user.id}`, userId: req.user.id, name: userNameFromUsername(req.user.username) };
  if (!req.guestKey) throw new HttpError(401, 'IDENTITY_REQUIRED');
  return { key: `g:${req.guestKey}`, userId: null, name: req.guestName || 'Guest' };
}
