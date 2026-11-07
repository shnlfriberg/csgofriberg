import { kernelKey, kernelRedis, kernelScript } from './state';

/**
 * A sorted-set deadline source shared by every room game. Members are
 * `<kind>|<roomId>|<discriminator>` and the score is the due time.
 *
 * Claiming leases an item by moving its score into the future, so two
 * instances never process the same due deadline concurrently. This is the
 * classic `room:schedules` algorithm, now reusable per game.
 */
export const SCHEDULE_LEASE_MS = 15_000;

/** Same script text and name as the classic room schedule claim, so its SHA is shared. */
const CLAIM_SCRIPT = `local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
     for _, item in ipairs(items) do
       redis.call('ZADD', KEYS[1], 'XX', ARGV[3], item)
     end
     return items`;

const CLAIM_ONE_SCRIPT = `local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[3], ARGV[1])
return 1`;

export class ScheduleSource {
  private readonly local = new Map<string, number>();

  constructor(readonly name: string, private readonly key: string) {}

  private redisKey() {
    return kernelKey(this.key);
  }

  async add(member: string, at: number): Promise<boolean> {
    const client = kernelRedis();
    if (!client) {
      this.local.set(member, at);
      return true;
    }
    await client.zAdd(this.redisKey(), { score: at, value: member });
    return true;
  }

  async remove(member: string): Promise<void> {
    const client = kernelRedis();
    if (!client) {
      this.local.delete(member);
      return;
    }
    await client.zRem(this.redisKey(), member);
  }

  async claimDue(limit: number, now = Date.now()): Promise<string[]> {
    const client = kernelRedis();
    if (!client) {
      const due = [...this.local].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
      for (const member of due) this.local.set(member, now + SCHEDULE_LEASE_MS);
      return due;
    }
    return kernelScript('room-schedule-claim-v1', CLAIM_SCRIPT, [this.redisKey()], [
      String(now),
      String(limit),
      String(now + SCHEDULE_LEASE_MS),
    ]) as Promise<string[]>;
  }

  /**
   * Lease one specific item if it is due (with a small tolerance for local
   * timers firing marginally early). Returns false when another instance
   * already claimed it or it moved to a later deadline.
   */
  async claimOne(member: string, now = Date.now()): Promise<boolean> {
    const client = kernelRedis();
    if (!client) {
      const at = this.local.get(member);
      if (at === undefined || at > now + 50) return false;
      this.local.set(member, now + SCHEDULE_LEASE_MS);
      return true;
    }
    const result = await kernelScript('kernel-schedule-claim-one-v1', CLAIM_ONE_SCRIPT, [this.redisKey()], [
      member,
      String(now + 50),
      String(now + SCHEDULE_LEASE_MS),
    ]);
    return Number(result) === 1;
  }

  async score(member: string): Promise<number | null> {
    const client = kernelRedis();
    if (!client) return this.local.get(member) ?? null;
    return client.zScore(this.redisKey(), member);
  }
}

export function parseScheduleItem(item: string): { kind: string; roomId: string; discriminator: string } {
  const [kind = '', roomId = '', ...rest] = item.split('|');
  return { kind, roomId, discriminator: rest.join('|') };
}
