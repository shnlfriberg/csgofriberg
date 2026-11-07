import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { initRedis } from '../../src/redis';
import { assetDirectory } from '../../src/location/assets';
import { assertStorageRoom, chargeImageInput, storageLimits } from '../../src/location/storageQuota';
import { cleanupBankStages, stageBank } from '../../src/location/bank';

beforeAll(async () => { await initRedis(); });

describe('upload storage budgets preserve existing data', () => {
  it('rejects cumulative storage growth without removing an existing file', async () => {
    const directory = path.join(assetDirectory, `quota-test-${randomUUID()}`), filename = path.join(directory, 'keep');
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(filename, 'keep');
    try {
      await expect(assertStorageRoom(directory, 2, 5)).rejects.toMatchObject({ code: 'LOCATION_STORAGE_LIMIT' });
      expect(await fs.readFile(filename, 'utf8')).toBe('keep');
    } finally { await fs.unlink(filename); await fs.rmdir(directory); }
  });
  it('shares a byte budget across requests while keeping different owners separate', async () => {
    const previous = storageLimits.hourlyInput; storageLimits.hourlyInput = 32;
    try {
      const owner = `quota-${randomUUID()}`;
      await chargeImageInput(owner, 20);
      await expect(chargeImageInput(owner, 20)).rejects.toMatchObject({ code: 'LOCATION_UPLOAD_LIMIT' });
      await expect(chargeImageInput(`${owner}-other`, 20)).resolves.toBeUndefined();
    } finally { storageLimits.hourlyInput = previous; }
  });
  it('checks archive storage before buffering another package', async () => {
    const previous = storageLimits.stages; storageLimits.stages = 1;
    try { await expect(stageBank(Readable.from('not-consumed'), 1)).rejects.toMatchObject({ code: 'LOCATION_STORAGE_LIMIT' }); }
    finally { storageLimits.stages = previous; }
  });
  it('periodically removes only expired UUID staging directories, preserving published images', async () => {
    const directory = path.join(assetDirectory, '.bank-transfer', randomUUID()), published = path.join(assetDirectory, `${randomUUID()}.webp`);
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'stage.json'), '{}');
    await fs.writeFile(published, 'preserved');
    const old = new Date(Date.now() - 3 * 3600_000); await fs.utimes(directory, old, old);
    try {
      await cleanupBankStages();
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(published, 'utf8')).toBe('preserved');
    } finally { await fs.unlink(published); }
  });
});
