import { describe, expect, it, vi } from 'vitest';
import { emitted, metricsSnapshot, measured, observe } from '../../src/card-link/metrics';
describe('bounded private card telemetry', () => {
  it('keeps aggregate byte windows, records failures and excludes payloads and identities', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let i = 0; i < 1200; i++) emitted(`private-room-${i}`, { hand: ['private-card'], userId: 'secret-person' });
      clock.mockReturnValue(3000);
      await expect(measured('command_ms', async () => { throw Error('failed'); })).rejects.toThrow('failed');
      observe('version_conflict');
      const snapshot = metricsSnapshot();
      expect(snapshot.metrics.socket_room_bytes_per_second.count).toBe(1200);
      expect(snapshot.metrics.command_ms.count).toBe(1);
      expect(snapshot.metrics.version_conflict.count).toBe(1);
      expect(JSON.stringify(snapshot)).not.toMatch(/private-room|private-card|secret-person/);
    } finally { clock.mockRestore(); }
  });
});
