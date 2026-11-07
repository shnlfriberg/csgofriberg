import { logTransientError } from '../../services/transientLog';
import { INSTANCE_TTL_MS, instanceAliveKey, instanceId, instancesKey } from './instance';
import { countKernel } from './metrics';
import { kernelKey, kernelRedis, kernelScript } from './state';

/**
 * Cluster-wide socket presence without `fetchSockets` RPCs.
 *
 * A scope is a small hash `sid -> identity\ninstance`. Entries count as live
 * only while their owning instance publishes its liveness key, so a crashed
 * process stops counting within INSTANCE_TTL_MS and the reaper then removes
 * its entries and reports the resulting offline transitions.
 *
 * Scopes in use: `id:<identity>` (every socket of an identity, 图寻 seats) and
 * `watch:<game>:<roomId>` (sockets watching one room, 卡牌连接 seats).
 */
const SCOPE_TTL_SECONDS = 6 * 60 * 60;
const SEP = '\n';

export const identityScope = (identity: string) => `id:${identity}`;
export const watchScope = (game: string, roomId: string) => `watch:${game}:${roomId}`;
const scopeKey = (scope: string) => kernelKey(`kernel:presence:${scope}`);
const instanceScopesKey = (instance: string) => kernelKey(`kernel:instance-scopes:${instance}`);

export interface PresenceTransition {
  scope: string;
  identity: string;
  online: boolean;
}

/** Sockets attached by this process, for detaching on disconnect and re-attaching after a false reap. */
const localSockets = new Map<string, { identity: string; scopes: Set<string> }>();
/** Single-instance fallback without Redis. */
const memory = new Map<string, Map<string, string>>();

const ATTACH_SCRIPT = `local before = 0
local entries = redis.call('HGETALL', KEYS[1])
for index = 1, #entries, 2 do
  local field = entries[index]
  local value = entries[index + 1]
  local sep = string.find(value, '\\n', 1, true)
  if sep and field ~= ARGV[1] then
    local identity = string.sub(value, 1, sep - 1)
    local instance = string.sub(value, sep + 1)
    if identity == ARGV[2] and redis.call('EXISTS', ARGV[4] .. instance) == 1 then before = before + 1 end
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '\\n' .. ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('SADD', KEYS[2], ARGV[5] .. '\\n' .. ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[6])
return before`;

const DETACH_SCRIPT = `redis.call('SREM', KEYS[2], ARGV[3] .. '\\n' .. ARGV[1])
local value = redis.call('HGET', KEYS[1], ARGV[1])
if not value then return {'', -1} end
redis.call('HDEL', KEYS[1], ARGV[1])
local sep = string.find(value, '\\n', 1, true)
if not sep then return {'', -1} end
local identity = string.sub(value, 1, sep - 1)
local remaining = 0
local entries = redis.call('HGETALL', KEYS[1])
for index = 1, #entries, 2 do
  local other = entries[index + 1]
  local otherSep = string.find(other, '\\n', 1, true)
  if otherSep and string.sub(other, 1, otherSep - 1) == identity
    and redis.call('EXISTS', ARGV[2] .. string.sub(other, otherSep + 1)) == 1 then
    remaining = remaining + 1
  end
end
return {identity, remaining}`;

const ONLINE_SCRIPT = `local result = {}
for index, key in ipairs(KEYS) do
  local live = {}
  local entries = redis.call('HGETALL', key)
  for entry = 1, #entries, 2 do
    local value = entries[entry + 1]
    local sep = string.find(value, '\\n', 1, true)
    if sep and redis.call('EXISTS', ARGV[1] .. string.sub(value, sep + 1)) == 1 then
      live[string.sub(value, 1, sep - 1)] = true
    end
  end
  local names = {}
  for identity, _ in pairs(live) do table.insert(names, identity) end
  table.insert(result, table.concat(names, '\\n'))
end
return result`;

function memoryLiveCount(scope: string, identity: string, exceptSid?: string): number {
  let count = 0;
  for (const [sid, owner] of memory.get(scope) ?? []) if (owner === identity && sid !== exceptSid) count++;
  return count;
}

/** Attach a socket to a scope. Returns true when this made the identity online in the scope. */
export async function attachPresence(sid: string, identity: string, scope: string): Promise<boolean> {
  const local = localSockets.get(sid) ?? { identity, scopes: new Set<string>() };
  local.scopes.add(scope);
  localSockets.set(sid, local);
  const client = kernelRedis();
  if (!client) {
    const before = memoryLiveCount(scope, identity, sid);
    const entries = memory.get(scope) ?? new Map<string, string>();
    entries.set(sid, identity);
    memory.set(scope, entries);
    return before === 0;
  }
  const before = await kernelScript('kernel-presence-attach-v1', ATTACH_SCRIPT, [scopeKey(scope), instanceScopesKey(instanceId)], [
    sid,
    identity,
    instanceId,
    kernelKey('kernel:instance:'),
    scope,
    String(SCOPE_TTL_SECONDS),
  ]);
  countKernel('presence.attach');
  return Number(before) === 0;
}

async function detachEntry(scope: string, sid: string, instance: string): Promise<PresenceTransition | null> {
  const client = kernelRedis();
  if (!client) {
    const entries = memory.get(scope);
    const identity = entries?.get(sid);
    if (!entries || !identity) return null;
    entries.delete(sid);
    if (!entries.size) memory.delete(scope);
    return memoryLiveCount(scope, identity) === 0 ? { scope, identity, online: false } : null;
  }
  const [identity, remaining] = await kernelScript('kernel-presence-detach-v1', DETACH_SCRIPT, [
    scopeKey(scope),
    instanceScopesKey(instance),
  ], [sid, kernelKey('kernel:instance:'), scope]) as [string, number];
  countKernel('presence.detach');
  if (!identity || Number(remaining) !== 0) return null;
  return { scope, identity, online: false };
}

/** Detach one socket from one scope. Returns the offline transition, if any. */
export async function detachPresence(sid: string, scope: string): Promise<PresenceTransition | null> {
  const local = localSockets.get(sid);
  local?.scopes.delete(scope);
  return detachEntry(scope, sid, instanceId);
}

/** Detach a disconnected socket from every scope it joined on this instance. */
export async function detachSocketPresence(sid: string): Promise<PresenceTransition[]> {
  const local = localSockets.get(sid);
  localSockets.delete(sid);
  if (!local) return [];
  const transitions: PresenceTransition[] = [];
  for (const scope of local.scopes) {
    const transition = await detachEntry(scope, sid, instanceId);
    if (transition) transitions.push(transition);
  }
  return transitions;
}

/** Live identities per scope (one round trip for many scopes). */
export async function onlineIdentities(scopes: string[]): Promise<Array<Set<string>>> {
  if (!scopes.length) return [];
  const client = kernelRedis();
  if (!client) {
    return scopes.map((scope) => new Set(memory.get(scope)?.values() ?? []));
  }
  const result = await kernelScript('kernel-presence-online-v1', ONLINE_SCRIPT, scopes.map(scopeKey), [
    kernelKey('kernel:instance:'),
  ]) as string[];
  return result.map((joined) => new Set(joined ? joined.split(SEP) : []));
}

export async function isIdentityOnline(identity: string): Promise<boolean> {
  const [live] = await onlineIdentities([identityScope(identity)]);
  return live.has(identity);
}

/** Re-attach every local socket after this instance's liveness key unexpectedly expired. */
export async function reattachLocalSockets(): Promise<PresenceTransition[]> {
  const transitions: PresenceTransition[] = [];
  for (const [sid, local] of localSockets) {
    for (const scope of local.scopes) {
      if (await attachPresence(sid, local.identity, scope)) transitions.push({ scope, identity: local.identity, online: true });
    }
  }
  countKernel('presence.reattached', transitions.length);
  return transitions;
}

/** Remove entries owned by instances whose liveness key expired. */
export async function reapDeadInstances(): Promise<PresenceTransition[]> {
  const client = kernelRedis();
  if (!client) return [];
  const cutoff = Date.now() - INSTANCE_TTL_MS;
  const candidates = await client.zRangeByScore(instancesKey(), '-inf', cutoff, { LIMIT: { offset: 0, count: 20 } });
  const transitions: PresenceTransition[] = [];
  for (const dead of candidates) {
    if (dead === instanceId) continue;
    if (await client.exists(instanceAliveKey(dead))) continue;
    const members = await client.sMembers(instanceScopesKey(dead));
    for (const member of members) {
      const sep = member.lastIndexOf(SEP);
      if (sep < 0) continue;
      try {
        const transition = await detachEntry(member.slice(0, sep), member.slice(sep + 1), dead);
        if (transition) transitions.push(transition);
      } catch (err) {
        logTransientError('[room-kernel:reap]', err);
      }
    }
    await client.multi().del(instanceScopesKey(dead)).zRem(instancesKey(), dead).exec();
    countKernel('presence.reapedInstances');
  }
  return transitions;
}

/** Detach all local sockets during graceful shutdown. */
export async function detachAllLocal(): Promise<PresenceTransition[]> {
  const transitions: PresenceTransition[] = [];
  for (const sid of [...localSockets.keys()]) transitions.push(...await detachSocketPresence(sid));
  return transitions;
}
