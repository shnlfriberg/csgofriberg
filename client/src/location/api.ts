import { api, errMsg } from '../api/client';
import { getSocket } from '../api/socket';
import i18n from '../i18n';
export { api };
export function message(error: unknown): string {
  const e = error as { response?: { data?: { code?: string } }; code?: string };
  const code = e?.response?.data?.code || e?.code;
  return code && i18n.exists(`location.errors.${code}`)
    ? String(i18n.t(`location.errors.${code}`))
    : errMsg(error);
}
export async function roomAction<T>(
  event: string,
  payload: unknown
): Promise<T> {
  // Socket events are not PoW-gated; only HTTP API requests carry the PoW cookie.
  return new Promise<T>((resolve, reject) =>
    getSocket()
      .timeout(10000)
      .emit(
        event,
        payload,
        (error: unknown, result: { ok: boolean; code?: string; data: T }) => {
          if (error) reject(error);
          else if (!result?.ok)
            reject({ code: result?.code || 'INTERNAL_ERROR' });
          else resolve(result.data);
        }
      )
  );
}
