import { HttpError } from '../middleware/common';
import type { RequestHandler } from 'express';

// Reject excess work before retaining another image buffer in a waiting queue.
let active = 0;
let bytes = 0;
export async function withImageBudget<T>(size: number, action: () => Promise<T>): Promise<T> {
  if (active >= 2 || bytes + size > 32 * 1024 * 1024) throw new HttpError(429, 'LOCATION_BUSY');
  active++; bytes += size;
  try { return await action(); } finally { active--; bytes -= size; }
}
let pixels = 0;
const maxPixels = 16_000_000;
// Compressed byte size alone does not bound libvips/WebP working memory.
export async function withRasterBudget<T>(size: number, action: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(size) || size < 1 || pixels + size > maxPixels)
    throw new HttpError(429, 'LOCATION_BUSY');
  pixels += size;
  try { return await action(); } finally { pixels -= size; }
}
export const imageBudget = () => ({ active, bytes, pixels, maxPixels, maxActive: 2, maxBytes: 32 * 1024 * 1024 });
let uploads = 0;
export const imageRequestBudget: RequestHandler = (_req, res, next) => {
  if (uploads >= 4) { next(new HttpError(429, 'LOCATION_BUSY')); return; }
  uploads++;
  let released = false;
  const release = () => { if (!released) { released = true; uploads--; } };
  res.once('finish', release); res.once('close', release);
  next();
};
