import sharp from 'sharp';
import { withImageBudget, withRasterBudget } from './workBudget';

// Bound native memory as well as the JS heap in the shared game process.
sharp.cache(false);
sharp.concurrency(1);

export const CAPTURE_SIZE = 360;
export const THUMBNAIL_SIZE = 240;
export type AssetPurpose = 'question' | 'radar';

// Also used by the offline manifest checker, so duplicate detection matches uploaded images.
export async function processLocationImage(
  input: Buffer,
  purpose: AssetPurpose = 'question'
) {
  if (
    !Buffer.isBuffer(input) ||
    !input.length ||
    input.length > 16 * 1024 * 1024
  ) {
    throw new Error('LOCATION_INVALID_ASSET');
  }
  return withImageBudget(input.length, async () => {
  const image = sharp(input, { limitInputPixels: 16_000_000, animated: false });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format || ''))
    throw new Error('LOCATION_INVALID_ASSET');
  const { width, height } = metadata.autoOrient;
  return withRasterBudget(width * height, async () => {
  image.autoOrient();
  if (purpose === 'question') {
    if (width < CAPTURE_SIZE || height < CAPTURE_SIZE)
      throw new Error('LOCATION_CAPTURE_TOO_SMALL');
    // Crop source pixels directly. Resizing the whole frame would retain top/bottom HUD.
    image.extract({
      left: Math.floor((width - CAPTURE_SIZE) / 2),
      top: Math.floor((height - CAPTURE_SIZE) / 2),
      width: CAPTURE_SIZE,
      height: CAPTURE_SIZE,
    });
  } else if (width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw new Error('LOCATION_INVALID_ASSET');
  }
  const full = await image.webp({ quality: 88 }).toBuffer();
  const thumbnail = await sharp(full)
    .resize({
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    full,
    thumbnail,
    width: purpose === 'question' ? CAPTURE_SIZE : width,
    height: purpose === 'question' ? CAPTURE_SIZE : height,
  };
  });
  });
}
