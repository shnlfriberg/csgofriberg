import path from 'node:path';
import { createReadStream } from 'node:fs';
import { initDb } from '../db/init';
import { db } from '../db/knex';
import { initRedis, closeRedis } from '../redis';
import { importBank, previewBank, stageBank } from './bank';

async function main() {
  const args = process.argv.slice(2);
  const filename = args.find((arg) => !arg.startsWith('--'));
  if (
    !filename ||
    args.some(
      (arg) =>
        arg.startsWith('--') && !['--check', '--update-existing'].includes(arg)
    )
  )
    throw new Error(
      'Usage: pnpm --filter server location:import /absolute/path/bank.zip [--check] [--update-existing]'
    );
  await initDb();
  if (!(await initRedis()))
    throw new Error('Redis is required for the catalog transfer lock.');
  let preview = await stageBank(createReadStream(path.resolve(filename)), 0);
  const update = args.includes('--update-existing');
  if (update) preview = await previewBank(preview.token, 0, true);
  console.log(JSON.stringify({ preview }, null, 2));
  if (!preview.canImport)
    throw new Error(
      'Import conflicts remain. No catalog changes were applied.'
    );
  if (!args.includes('--check'))
    console.log(
      JSON.stringify({
        imported: await importBank(
          preview.token,
          0,
          preview.fingerprint,
          update
        ),
      })
    );
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
