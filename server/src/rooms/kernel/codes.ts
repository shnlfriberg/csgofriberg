import { kernelKey, kernelRedis } from './state';

/**
 * One five-character invite-code namespace shared by classic rooms and 图寻 rooms.
 * (卡牌连接 keeps its historical 8-hex SQL codes, validated separately.)
 */
export const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RESERVATION_SECONDS = 60;

export interface CodeNamespace {
  /** Redis keys whose existence means the code is taken. */
  redisKeys(id: string): string[];
  /** Single-instance fallback check. */
  localExists(id: string): Promise<boolean>;
}

const namespaces = new Map<string, CodeNamespace>();

export function registerCodeNamespace(name: string, namespace: CodeNamespace): () => void {
  namespaces.set(name, namespace);
  return () => {
    if (namespaces.get(name) === namespace) namespaces.delete(name);
  };
}

function randomCode(): string {
  return Array.from({ length: 5 }, () => ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)]).join('');
}

/**
 * Allocate a code that no registered game uses. A short reservation key closes
 * the window between allocation and the first save of the new room.
 */
export async function allocateRoomCode(owner: string): Promise<string> {
  const client = kernelRedis();
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = randomCode();
    if (!client) {
      let taken = false;
      for (const namespace of namespaces.values()) if (await namespace.localExists(id)) taken = true;
      if (!taken) return id;
      continue;
    }
    const keys = [...namespaces.values()].flatMap((namespace) => namespace.redisKeys(id));
    const existing = keys.length ? await client.exists(keys) : 0;
    if (existing) continue;
    if (await client.set(kernelKey(`kernel:code:${id}`), owner, { NX: true, EX: CODE_RESERVATION_SECONDS })) return id;
  }
  throw new Error('ROOM_ID_EXHAUSTED');
}
