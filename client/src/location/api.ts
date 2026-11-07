import { api, errMsg } from '../api/client';
export { roomAction } from '../api/roomKernel';
import i18n from '../i18n';
export { api };
export function message(error: unknown): string {
  const e = error as { response?: { data?: { code?: string } }; code?: string };
  const code = e?.response?.data?.code || e?.code;
  return code && i18n.exists(`location.errors.${code}`)
    ? String(i18n.t(`location.errors.${code}`))
    : errMsg(error);
}
