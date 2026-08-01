import crypto from 'crypto';
import { config } from '../config';

const DISPLAY_ID_SPACE = 36 ** 5;
const MAX_DISPLAY_ID_ATTEMPTS = 128;

type DisplayIdentityKind = 'guest' | 'user';

export function containsForbiddenDisplayToken(
  code: string,
  forbiddenTokens: readonly string[] = config.displayIdForbiddenTokens
): boolean {
  const normalized = code.toUpperCase();
  return forbiddenTokens.some((token) => normalized.includes(token.toUpperCase()));
}

export function displayCodeFromSeed(
  kind: DisplayIdentityKind,
  seed: string,
  forbiddenTokens: readonly string[] = config.displayIdForbiddenTokens
): string {
  for (let attempt = 0; attempt < MAX_DISPLAY_ID_ATTEMPTS; attempt += 1) {
    const digest = crypto
      .createHmac('sha256', config.guestIdSalt)
      .update(`csgofriberg-${kind}-id-v1\0`, 'ascii')
      .update(seed, 'utf8');
    if (attempt > 0) {
      digest
        .update('\0display-id-filter\0', 'ascii')
        .update(String(attempt), 'ascii');
    }
    const value = digest.digest().readUInt32BE(0) % DISPLAY_ID_SPACE;
    const code = value.toString(36).padStart(5, '0').toUpperCase();
    if (!containsForbiddenDisplayToken(code, forbiddenTokens)) return code;
  }
  throw new Error('DISPLAY_ID_FILTER_EXHAUSTED');
}

export function guestNameFromKey(key: string): string {
  return `访客#${displayCodeFromSeed('guest', key)}`;
}

export function userNameFromUsername(username: string): string {
  return `用户#${displayCodeFromSeed('user', username)}`;
}
