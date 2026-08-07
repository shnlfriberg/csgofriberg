import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { resolveUmamiConfig } from './services/umami';

const repoEnvPath = path.resolve(__dirname, '../../.env');
const serverEnvPath = path.resolve(__dirname, '../.env');

// The repository-level .env is the primary configuration used by the root scripts.
// Keep server/.env as a fallback for existing deployments.
dotenv.config({ path: repoEnvPath });
dotenv.config({ path: serverEnvPath });

const configuredJwtSecret = process.env.JWT_SECRET?.trim();
const configuredGuestIdSalt = process.env.GUEST_ID_SALT?.trim();
const unsafeJwtSecrets = new Set(['dev-secret', 'change-me-in-production']);
const jwtSecret = configuredJwtSecret || crypto.randomBytes(48).toString('base64url');
const configuredPasswordWorkers = Number(process.env.PASSWORD_WORKERS || 2);
const configuredPasswordQueueLimit = Number(process.env.PASSWORD_QUEUE_LIMIT || 64);
const configuredBcryptRounds = Number(process.env.BCRYPT_ROUNDS || 8);
const configuredAdminImportBodyLimitBytes = Number(
  process.env.ADMIN_IMPORT_BODY_LIMIT_BYTES || 2 * 1024 * 1024
);
const configuredPowDifficulty = Number(process.env.POW_DIFFICULTY || 17);
const configuredPowRegisterDifficulty = Number(
  process.env.POW_REGISTER_DIFFICULTY || Math.min(24, configuredPowDifficulty + 2)
);
const configuredEmailAllowedSuffixes = (process.env.EMAIL_ALLOWED_SUFFIXES || '')
  .split(',')
  .map((suffix) => suffix.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);
const configuredDisplayIdForbiddenTokens = (process.env.DISPLAY_ID_FORBIDDEN_TOKENS ?? '')
  .split(',')
  .map((token) => token.trim().toUpperCase())
  .filter(Boolean);
const configuredCheatAnalysisTimeoutMs = Number(process.env.CHEAT_ANALYSIS_TIMEOUT_MS || 15_000);
const configuredGeeTestCaptchaId = process.env.GEETEST_CAPTCHA_ID?.trim() || '';
const configuredGeeTestPrivateKey = process.env.GEETEST_PRIVATE_KEY?.trim() || '';
const invalidDisplayIdForbiddenToken = configuredDisplayIdForbiddenTokens.find(
  (token) => !/^[0-9A-Z]{2,5}$/.test(token)
);
if (invalidDisplayIdForbiddenToken) {
  throw new Error('DISPLAY_ID_FORBIDDEN_TOKENS_MUST_BE_2_TO_5_BASE36_CHARACTERS');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret,
  guestIdSalt: configuredGuestIdSalt || jwtSecret,
  displayIdForbiddenTokens: [...new Set(configuredDisplayIdForbiddenTokens)],
  dbClient: (process.env.DB_CLIENT || 'sqlite') as 'sqlite' | 'pg',
  dbUrl: process.env.DB_URL || './data/csgofriberg.sqlite3',
  dbPoolMin: Number(process.env.DB_POOL_MIN || 2),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 20),
  dbAcquireTimeoutMs: Math.max(500, Number(process.env.DB_ACQUIRE_TIMEOUT_MS || 3000)),
  trustProxy: process.env.TRUST_PROXY === 'true',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisPrefix: process.env.REDIS_PREFIX || 'csgofriberg:',
  redisRequired: process.env.REDIS_REQUIRED === 'true',
  redisCommandTimeoutMs: Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1500),
  roomLockWaitMs: Math.max(
    100,
    Math.min(5_000, Number(process.env.ROOM_LOCK_WAIT_MS) || 1_000)
  ),
  passwordWorkers: Number.isInteger(configuredPasswordWorkers)
    ? Math.max(1, Math.min(4, configuredPasswordWorkers))
    : 2,
  passwordQueueLimit: Number.isInteger(configuredPasswordQueueLimit)
    ? Math.max(8, configuredPasswordQueueLimit)
    : 64,
  bcryptRounds: Number.isInteger(configuredBcryptRounds)
    ? Math.max(8, Math.min(12, configuredBcryptRounds))
    : 8,
  adminImportBodyLimitBytes:
    Number.isInteger(configuredAdminImportBodyLimitBytes) && configuredAdminImportBodyLimitBytes >= 64 * 1024
      ? configuredAdminImportBodyLimitBytes
      : 2 * 1024 * 1024,
  email: {
    host: process.env.EMAIL_SMTP_HOST?.trim() || '',
    port: Number(process.env.EMAIL_SMTP_PORT || 587),
    secure: process.env.EMAIL_SMTP_SECURE === 'true',
    startTls: process.env.EMAIL_SMTP_STARTTLS !== 'false',
    username: process.env.EMAIL_SMTP_USERNAME?.trim() || '',
    password: process.env.EMAIL_SMTP_PASSWORD || '',
    from: process.env.EMAIL_FROM?.trim() || '',
    allowedSuffixes: configuredEmailAllowedSuffixes,
    verifyTtlSeconds: Math.max(300, Number(process.env.EMAIL_VERIFY_TTL_SECONDS || 1800)),
  },
  geetest: {
    enabled: Boolean(configuredGeeTestCaptchaId && configuredGeeTestPrivateKey),
    captchaId: configuredGeeTestCaptchaId,
    privateKey: configuredGeeTestPrivateKey,
    validateUrl: process.env.GEETEST_VALIDATE_URL?.trim() || 'https://gcaptcha4.geetest.com/validate',
    timeoutMs: Math.max(1_000, Math.min(10_000, Number(process.env.GEETEST_TIMEOUT_MS || 3_000))),
  },
  cheatAnalysis: {
    apiUrl: process.env.CHEAT_ANALYSIS_API_URL?.trim() || '',
    apiToken: process.env.CHEAT_ANALYSIS_API_TOKEN?.trim() || '',
    timeoutMs: Number.isFinite(configuredCheatAnalysisTimeoutMs)
      ? Math.max(1_000, Math.min(30_000, configuredCheatAnalysisTimeoutMs))
      : 15_000,
  },
  disconnectForfeitMs: Math.max(100, Number(process.env.DISCONNECT_FORFEIT_MS || 30_000)),
  matchReadyTimeoutMs: 30_000,
  powDifficulty: configuredPowDifficulty,
  powRegisterDifficulty: configuredPowRegisterDifficulty,
  powChallengeTtlSeconds: Number(process.env.POW_CHALLENGE_TTL_SECONDS || 120),
  powTokenTtlSeconds: Number(process.env.POW_TOKEN_TTL_SECONDS || 600),
  showLeaderboard: process.env.SHOW_LEADERBOARD !== 'false',
  umami: resolveUmamiConfig({
    websiteId: process.env.UMAMI_WEBSITE_ID,
    scriptUrl: process.env.UMAMI_SCRIPT_URL,
  }),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function validateProductionConfig(): void {
  if (!Number.isInteger(config.powDifficulty) || config.powDifficulty < 16 || config.powDifficulty > 24) {
    throw new Error('POW_DIFFICULTY_MUST_BE_BETWEEN_16_AND_24');
  }
  if (
    !Number.isInteger(config.powRegisterDifficulty) ||
    config.powRegisterDifficulty < 16 ||
    config.powRegisterDifficulty > 24
  ) {
    throw new Error('POW_REGISTER_DIFFICULTY_MUST_BE_BETWEEN_16_AND_24');
  }
  if (config.powRegisterDifficulty <= config.powDifficulty) {
    throw new Error('POW_REGISTER_DIFFICULTY_MUST_EXCEED_POW_DIFFICULTY');
  }
  if (Boolean(config.cheatAnalysis.apiUrl) !== Boolean(config.cheatAnalysis.apiToken)) {
    throw new Error('CHEAT_ANALYSIS_API_URL_AND_TOKEN_MUST_BE_CONFIGURED_TOGETHER');
  }
  if (process.env.NODE_ENV !== 'production') return;
  if (Boolean(configuredGeeTestCaptchaId) !== Boolean(configuredGeeTestPrivateKey)) {
    throw new Error('GEETEST_CAPTCHA_ID_AND_PRIVATE_KEY_MUST_BE_CONFIGURED_TOGETHER');
  }
  if (!config.geetest.enabled) {
    throw new Error('GEETEST_MUST_BE_CONFIGURED_IN_PRODUCTION');
  }
  if (
    !configuredJwtSecret ||
    Buffer.byteLength(configuredJwtSecret, 'utf8') < 32 ||
    unsafeJwtSecrets.has(configuredJwtSecret)
  ) {
    throw new Error('JWT_SECRET_MUST_BE_AT_LEAST_32_RANDOM_BYTES');
  }
  if (configuredGuestIdSalt && Buffer.byteLength(configuredGuestIdSalt, 'utf8') < 32) {
    throw new Error('GUEST_ID_SALT_MUST_BE_AT_LEAST_32_RANDOM_BYTES');
  }
  if (config.dbClient !== 'pg') throw new Error('POSTGRESQL_REQUIRED_IN_PRODUCTION');
  if (!config.redisRequired) throw new Error('REDIS_REQUIRED_MUST_BE_TRUE_IN_PRODUCTION');
}
