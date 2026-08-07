export interface GeeTestProof {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
}

export interface GeeTestChallengeResult {
  enabled: boolean;
  proof: GeeTestProof | null;
}

interface GeeTestCaptcha {
  appendTo(selector: string): GeeTestCaptcha;
  showCaptcha(): void;
  onSuccess(callback: () => void): GeeTestCaptcha;
  onError(callback: () => void): GeeTestCaptcha;
  onClose(callback: () => void): GeeTestCaptcha;
  getValidate(): Partial<GeeTestProof> | null;
  destroy?(): void;
}

declare global {
  interface Window {
    initGeetest4?: (
      options: { captchaId: string; product: 'bind' },
      callback: (captcha: GeeTestCaptcha) => void,
    ) => void;
  }
}

const scriptUrl = 'https://static.geetest.com/v4/gt4.js';
let scriptPromise: Promise<void> | null = null;
let captchaIdPromise: Promise<string | null> | null = null;

async function getCaptchaId(): Promise<string | null> {
  if (captchaIdPromise) return captchaIdPromise;
  captchaIdPromise = fetch('/api/runtime-config', { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error('GEETEST_CONFIG_FAILED');
      const payload = await response.json() as { geetest?: { enabled?: unknown; captchaId?: unknown } };
      if (!payload.geetest?.enabled) return null;
      const value = typeof payload.geetest.captchaId === 'string' ? payload.geetest.captchaId.trim() : '';
      if (!value) throw new Error('GEETEST_CONFIG_FAILED');
      return value;
    })
    .catch((error) => {
      captchaIdPromise = null;
      throw error;
    });
  return captchaIdPromise;
}

function loadScript(): Promise<void> {
  if (window.initGeetest4) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('GEETEST_LOAD_FAILED')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('GEETEST_LOAD_FAILED'));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

/** Opens a GeeTest v4 challenge and returns the one-time server proof. */
export async function requestGeeTest(): Promise<GeeTestChallengeResult> {
  const captchaId = await getCaptchaId();
  if (!captchaId) return { enabled: false, proof: null };
  await loadScript();
  if (!window.initGeetest4) throw new Error('GEETEST_LOAD_FAILED');
  return new Promise<GeeTestChallengeResult>((resolve, reject) => {
    window.initGeetest4!({ captchaId, product: 'bind' }, (captcha) => {
      captcha
        .onSuccess(() => {
          const proof = captcha.getValidate();
          if (proof?.lot_number && proof.captcha_output && proof.pass_token && proof.gen_time) {
            resolve({ enabled: true, proof: proof as GeeTestProof });
          } else {
            reject(new Error('GEETEST_FAILED'));
          }
          captcha.destroy?.();
        })
        .onError(() => reject(new Error('GEETEST_FAILED')))
        .onClose(() => resolve({ enabled: true, proof: null }));
      captcha.showCaptcha();
    });
  });
}
