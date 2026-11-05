import path from 'node:path';
import fs from 'node:fs/promises';
import { initDb } from '../db/init';
import { db } from '../db/knex';
import { initRedis, closeRedis } from '../redis';
import { exportBank } from './bank';

async function main() {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: pnpm --filter server location:export /absolute/path/bank.zip'
    );
  await initDb();
  if (!(await initRedis()))
    throw new Error('Redis is required for the catalog transfer lock.');
  const filename = path.resolve(process.argv[2]);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const file = await fs.open(filename, 'wx');
  const output = file.createWriteStream();
  try {
    await exportBank(output);
    console.log(`Exported: ${filename}`);
  } catch (error) {
    output.destroy();
    await file.close().catch(() => undefined);
    await fs.unlink(filename).catch(() => undefined);
    throw error;
  }
}
void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await db.destroy();
  });
