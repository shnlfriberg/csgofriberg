'use strict';

// Current-code regression runner. The original vulnerability probes are kept
// in .local-data/verification/security-fix/baseline-probe.cjs as audit evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const value = process.argv.find(arg => arg.startsWith('--redis-url='))?.slice('--redis-url='.length);
if (!value) {
  console.error('Usage: node server/scripts/audit-security-performance-20261107.cjs --redis-url=redis://127.0.0.1:TEST_PORT/15');
  process.exit(2);
}
const url = new URL(value);
if (url.protocol !== 'redis:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/15' || url.username || url.password) throw Error('ISOLATED_LOCAL_REDIS_DB_15_REQUIRED');

(async () => {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 6379) });
    socket.setTimeout(1500, () => socket.destroy(Error('TEST_REDIS_NOT_LISTENING')));
    socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
  });
  const run = path.join(root, '.local-data/verification', `security-regression-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  const shim = path.join(root, '.tools/sqlite-shim.cjs');
  const env = { ...process.env, NODE_ENV: 'test', DB_CLIENT: 'sqlite', DB_URL: path.join(run, 'tests.sqlite3'),
    LOCATION_ASSET_DIR: path.join(run, 'assets'), REDIS_URL: url.href, REDIS_REQUIRED: 'false',
    REDIS_PREFIX: `integration-tests:security-${crypto.randomUUID()}:`, TEMP: run, TMP: run,
    JWT_SECRET: crypto.randomBytes(48).toString('hex'), GUEST_ID_SALT: crypto.randomBytes(48).toString('hex'),
    GEETEST_CAPTCHA_ID: '', GEETEST_PRIVATE_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_FROM: '',
    NODE_OPTIONS: fs.existsSync(shim) ? `--require="${shim.replaceAll('\\', '/')}"` : '',
  };
  const files = ['test/routes/security.integration.test.ts', 'test/services/securityCache.test.ts',
    'test/services/queryCache.test.ts', 'test/services/auditPerformance.test.ts', 'test/services/trafficMetrics.test.ts',
    'test/socket/options.test.ts', 'test/card-link/watch.test.ts', 'test/location/storageQuota.test.ts', 'test/db/schema.test.ts'];
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', ...files], {
    cwd: path.join(root, 'server'), env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(run, 'tests.log'), (result.stdout || '') + (result.stderr || ''));
  fs.writeFileSync(path.join(run, 'verification.json'), JSON.stringify({ observedAt: new Date().toISOString(),
    node: process.version, redis: url.href, isolatedPrefix: env.REDIS_PREFIX, files,
    exitCode: result.status, error: result.error?.message || null }, null, 2));
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  console.log(`VERIFICATION=${path.join(run, 'verification.json')}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
