import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import authRoutes from '../../src/routes/auth';
import { errorHandler } from '../../src/middleware/common';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { config } from '../../src/config';
import { buildPasswordResetEmail, issuePasswordReset, recoveryEmailKey, reservePasswordReset, resetPassword } from '../../src/services/passwordReset';
import { hashPassword, verifyPassword } from '../../src/services/password';

const sendEmail = vi.hoisted(() => vi.fn());
const disconnectSockets = vi.fn();
const socketRoom = vi.fn(() => ({ disconnectSockets }));
vi.mock('../../src/services/emailVerification', async (original) => ({
  ...await original<typeof import('../../src/services/emailVerification')>(), sendEmail,
}));

let server: http.Server;
let baseUrl: string;
let counter = 0;
const run = Date.now().toString(36);
const originalGeeTest = config.geetest.enabled;
const oldPassword = 'Old-strong-password';
const newPassword = 'New-strong-password';
async function account(verified = true) {
  const username = `reset${run}${++counter}`;
  const email = `${username}@example.com`;
  const [user] = await db('users').insert({ username, email, password_hash: await hashPassword(oldPassword),
    email_verified_at: verified ? new Date() : null }).returning('*');
  return user;
}
function deliveredCode(email: string): string {
  const mail = sendEmail.mock.calls.filter((call) => call[0] === email).at(-1);
  return String(mail?.[2]).match(/\b\d{6}\b/)![0];
}
async function post(path: string, body: object, ip = `2001:db8:abcd::${++counter}`, cookie?: string) {
  const response = await fetch(`${baseUrl}/api/auth${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}
describe('password recovery', () => {
  beforeAll(async () => {
    await initDb(); await initRedis(); config.geetest.enabled = false;
    const app = express(); app.set('trust proxy', 1); app.use(express.json());
    app.set('io', { in: socketRoom });
    app.use('/api/auth', authRoutes); app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => { sendEmail.mockReset(); sendEmail.mockResolvedValue(undefined); socketRoom.mockClear(); disconnectSockets.mockClear(); });
  afterAll(async () => {
    config.geetest.enabled = originalGeeTest;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uses the existing sender and a code-only template without any URL', () => {
    const body = buildPasswordResetEmail('012345');
    expect(body).toContain('012345'); expect(body).toContain('10 分钟');
    expect(body).not.toMatch(/https?:|www\.|\.online|\.org|重置链接/);
  });
  it('requires the existing human verification before sending', async () => {
    const user = await account(); config.geetest.enabled = true;
    try {
      const result = await post('/password/request', { email: user.email });
      expect(result.response.status).toBe(400); expect(result.data.code).toBe('GEETEST_REQUIRED');
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await redis()!.get(redisKey(`password-reset-cooldown:${recoveryEmailKey(user.email)}`))).toBeNull();
    } finally { config.geetest.enabled = false; }
  });
  it('returns the same response for bound, absent, unverified and throttled mailboxes', async () => {
    const user = await account(); const unverified = await account(false);
    const bound = await post('/password/request', { email: ` ${user.email.toUpperCase()} ` });
    const absent = await post('/password/request', { email: `missing${run}@example.com` });
    const pending = await post('/password/request', { email: unverified.email });
    const cooldown = await post('/password/request', { email: user.email });
    for (const result of [bound, absent, pending, cooldown]) {
      expect(result.response.status).toBe(200); expect(result.data).toEqual({ ok: true, retryAfterSeconds: 30 });
    }
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0][0]).toBe(user.email);
    const row = await db('password_resets').where({ user_id: user.id }).first();
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(new Date(row.expires_at)) - Date.now()).toBeGreaterThan(590_000);
  });
  it('verifies the supplied GeeTest proof server-side and rejects failed proofs', async () => {
    const user = await account(); const originalFetch = globalThis.fetch;
    let accepted = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === config.geetest.validateUrl) {
        expect(String(init?.body)).toContain('lot_number=test-lot');
        return Promise.resolve(new Response(JSON.stringify({ result: accepted ? 'success' : 'fail' }), { status: 200 }));
      }
      return originalFetch(input, init);
    });
    config.geetest.enabled = true;
    const body = { email: user.email, lot_number: 'test-lot', captcha_output: 'test-output', pass_token: 'test-token', gen_time: '123' };
    try {
      expect((await post('/password/request', body)).data.code).toBe('GEETEST_FAILED');
      expect(sendEmail).not.toHaveBeenCalled();
      accepted = true;
      expect((await post('/password/request', body)).response.status).toBe(200);
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    } finally { config.geetest.enabled = false; fetchSpy.mockRestore(); }
  });
  it('does not wait for SMTP and does not expose SMTP failure to the requester', async () => {
    const user = await account();
    let rejectSend!: (error: Error) => void;
    sendEmail.mockImplementation(() => new Promise((_, reject) => { rejectSend = reject; }));
    const result = await post('/password/request', { email: user.email });
    expect(result.data).toEqual({ ok: true, retryAfterSeconds: 30 });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    rejectSend(new Error('SMTP failure with private recipient'));
    await vi.waitFor(async () => expect(await db('password_resets').where({ user_id: user.id }).first()).toBeUndefined());
  });
  it('identifies the account by its verified email alone and returns the login name after reset', async () => {
    const user = await account();
    expect((await post('/password/request', {})).response.status).toBe(400);
    // Older clients may still send a username; it is stripped rather than matched.
    const legacy = await post('/password/request', { username: 'another-user', email: user.email });
    expect(legacy.data).toEqual({ ok: true, retryAfterSeconds: 30 });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    const result = await post('/password/reset', { username: 'another-user', email: user.email, code: deliveredCode(user.email), password: newPassword });
    expect(result.response.status).toBe(200);
    expect(result.data).toEqual({ ok: true, username: user.username });
    expect((await db('users').where({ id: user.id }).first()).token_version).toBe(1);
  });
  it('resets once, invalidates access and refresh cookies, and keeps account data', async () => {
    const user = await account();
    const login = await post('/login', { username: user.username, password: oldPassword });
    const cookie = login.response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    // Prime the shared auth cache before resetting.
    expect((await post('/refresh', {}, undefined, cookie)).response.status).toBe(200);
    await issuePasswordReset(user.email); const code = deliveredCode(user.email);
    const result = await post('/password/reset', { email: user.email, code, password: newPassword });
    expect(result.response.status).toBe(200); expect(result.data).toEqual({ ok: true, username: user.username });
    expect(socketRoom).toHaveBeenCalledWith(`identity:u:${user.id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    const changed = await db('users').where({ id: user.id }).first();
    expect(changed).toMatchObject({ username: user.username, email: user.email, token_version: 1, role: user.role });
    expect(await verifyPassword(newPassword, changed.password_hash)).toBe(true);
    expect(await verifyPassword(oldPassword, changed.password_hash)).toBe(false);
    expect((await post('/refresh', {}, undefined, cookie)).response.status).toBe(401);
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } }); expect(me.status).toBe(401);
    expect(await resetPassword(user.email, code, oldPassword)).toBeNull();
    expect((await post('/login', { username: user.username, password: newPassword })).response.status).toBe(200);
  });
  it('rejects cross-purpose codes, wrong codes, expired codes and unverified mailboxes uniformly', async () => {
    const user = await account(); await issuePasswordReset(user.email); const code = deliveredCode(user.email);
    expect((await post('/email/verify-code', { code })).response.status).toBe(401);
    const wrong = code === '000000' ? '000001' : '000000';
    const unknown = await post('/password/reset', { email: 'absent@example.com', code, password: newPassword });
    const bad = await post('/password/reset', { email: user.email, code: wrong, password: newPassword });
    expect(bad.data).toEqual(unknown.data); expect(bad.data.code).toBe('PASSWORD_RESET_CODE_INVALID');
    for (let i = 0; i < 4; i++) expect(await resetPassword(user.email, wrong, newPassword)).toBeNull();
    expect(await resetPassword(user.email, code, newPassword)).toBeNull();
    await issuePasswordReset(user.email);
    await db('password_resets').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() - 1000) });
    expect(await resetPassword(user.email, deliveredCode(user.email), newPassword)).toBeNull();
    const pending = await account(false); await issuePasswordReset(pending.email);
    expect(sendEmail.mock.calls.some((call) => call[0] === pending.email)).toBe(false);
  });
  it('replaces old codes and permits only one concurrent consumption', async () => {
    const user = await account(); await issuePasswordReset(user.email); const oldCode = deliveredCode(user.email);
    await issuePasswordReset(user.email); let code = deliveredCode(user.email);
    // Random codes may repeat; avoid a probabilistic assertion in the test.
    if (code === oldCode) { await issuePasswordReset(user.email); code = deliveredCode(user.email); }
    if (code !== oldCode) expect(await resetPassword(user.email, oldCode, newPassword)).toBeNull();
    const results = await Promise.all([resetPassword(user.email, code, newPassword), resetPassword(user.email, code, 'Other-strong-password')]);
    expect(results.filter(Boolean)).toEqual([{ userId: user.id, username: user.username }]);
    expect((await db('users').where({ id: user.id }).first()).token_version).toBe(1);
  });
  it('rejects a challenge if the account email or login version changed', async () => {
    const user = await account(); await issuePasswordReset(user.email);
    await db('users').where({ id: user.id }).increment('token_version', 1);
    expect(await resetPassword(user.email, deliveredCode(user.email), newPassword)).toBeNull();
    await issuePasswordReset(user.email);
    await db('users').where({ id: user.id }).update({ email: `changed${run}@example.com` });
    expect(await resetPassword(user.email, deliveredCode(user.email), newPassword)).toBeNull();
  });
  it('limits sends per mailbox across IPs, with a shared cooldown', async () => {
    const email = `quota${run}@example.com`;
    expect(await reservePasswordReset(email)).toBe(true);
    expect(await reservePasswordReset(email.toUpperCase())).toBe(false);
    const key = redisKey(`password-reset-cooldown:${recoveryEmailKey(email)}`);
    for (let i = 0; i < 2; i++) { await redis()!.del(key); expect(await reservePasswordReset(email)).toBe(true); }
    await redis()!.del(key); expect(await reservePasswordReset(email)).toBe(false);
  });
  it('enforces password policy before consuming the code', async () => {
    const user = await account(); await issuePasswordReset(user.email);
    const result = await post('/password/reset', { email: user.email, code: deliveredCode(user.email), password: 'short' });
    expect(result.response.status).toBe(400);
    expect((await db('password_resets').where({ user_id: user.id }).first()).attempts).toBe(0);
  });
  it('limits verification attempts by IP even when mailboxes keep changing', async () => {
    const ip = '2001:db8:abce::1';
    for (let i = 0; i < 10; i++) {
      expect((await post('/password/reset', { email: `absent${i}@example.com`, code: '123456', password: newPassword }, ip)).response.status).toBe(400);
    }
    expect((await post('/password/reset', { email: 'another@example.com', code: '123456', password: newPassword }, ip)).response.status).toBe(429);
  });
});
