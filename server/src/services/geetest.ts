import crypto from 'crypto';
import { config } from '../config';

export interface GeeTestProof {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
}

export class GeeTestVerificationError extends Error {
  constructor(public readonly code: 'GEETEST_REQUIRED' | 'GEETEST_FAILED') {
    super(code);
  }
}

/** Verify a GeeTest v4 challenge on the server. Disabled environments remain usable locally. */
export async function verifyGeeTest(proof: Partial<GeeTestProof> | null | undefined): Promise<void> {
  if (!config.geetest.enabled) return;
  if (!proof?.lot_number || !proof.captcha_output || !proof.pass_token || !proof.gen_time) {
    throw new GeeTestVerificationError('GEETEST_REQUIRED');
  }

  const signToken = crypto
    .createHmac('sha256', config.geetest.privateKey)
    .update(proof.lot_number)
    .digest('hex');
  const body = new URLSearchParams({
    captcha_id: config.geetest.captchaId,
    lot_number: proof.lot_number,
    captcha_output: proof.captcha_output,
    pass_token: proof.pass_token,
    gen_time: proof.gen_time,
    sign_token: signToken,
  });

  try {
    const response = await fetch(config.geetest.validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(config.geetest.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const result = await response.json() as { result?: string };
    if (result.result !== 'success') throw new Error('REJECTED');
  } catch (error) {
    console.warn('[geetest:verify]', error instanceof Error ? error.message : error);
    throw new GeeTestVerificationError('GEETEST_FAILED');
  }
}
