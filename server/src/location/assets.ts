import path from 'path';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import { randomUUID, createHash } from 'crypto';
import { HttpError } from '../middleware/common';
import { processLocationImage, type AssetPurpose } from './imageProcessing';

export const assetDirectory = path.resolve(
  process.env.LOCATION_ASSET_DIR ||
    path.resolve(__dirname, '../../../data/location-assets')
);
export function assetPath(url: string): string {
  if (
    /^\/location-radars\/de_[a-z0-9]+_(?:main|upper|lower)\.webp$/.test(url)
  ) {
    const client = path.resolve(__dirname, '../../../client');
    const built = path.join(client, 'dist/location-radars', path.basename(url));
    return existsSync(built)
      ? built
      : path.join(client, 'public/location-radars', path.basename(url));
  }
  if (!/^\/location-assets\/[a-f0-9-]{36}(?:-thumb)?\.webp$/.test(url))
    throw new HttpError(400, 'LOCATION_INVALID_ASSET');
  return path.join(assetDirectory, path.basename(url));
}
export async function verifyAsset(url: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(assetPath(url));
  } catch {
    throw new HttpError(400, 'LOCATION_INVALID_ASSET');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
export async function uploadAsset(
  input: Buffer,
  purpose: AssetPurpose = 'question'
) {
  const id = randomUUID();
  const created: string[] = [];
  try {
    const { full, thumbnail, width, height } = await processLocationImage(
      input,
      purpose
    );
    await fs.mkdir(assetDirectory, { recursive: true });
    const fullPath = path.join(assetDirectory, `${id}.webp`);
    const thumbPath = path.join(assetDirectory, `${id}-thumb.webp`);
    await fs.writeFile(fullPath, full, {
      flag: 'wx',
    });
    created.push(fullPath);
    await fs.writeFile(thumbPath, thumbnail, {
      flag: 'wx',
    });
    created.push(thumbPath);
    return {
      url: `/location-assets/${id}.webp`,
      thumbnailUrl: `/location-assets/${id}-thumb.webp`,
      hash: createHash('sha256').update(full).digest('hex'),
      width,
      height,
    };
  } catch (error) {
    await Promise.allSettled(created.map((filename) => fs.unlink(filename)));
    if (error instanceof HttpError) throw error;
    if (
      error instanceof Error &&
      error.message === 'LOCATION_CAPTURE_TOO_SMALL'
    )
      throw new HttpError(400, error.message);
    throw new HttpError(400, 'LOCATION_INVALID_ASSET');
  }
}
