import fs from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assetDirectory,
  assetPath,
  uploadAsset,
} from '../../src/location/assets';

const created: string[] = [];
beforeAll(() => {
  sharp.cache(false);
});
async function upload(
  bytes: Buffer,
  purpose: 'question' | 'radar' = 'question'
) {
  const asset = await uploadAsset(bytes, purpose);
  created.push(asset.url, asset.thumbnailUrl);
  return asset;
}
afterAll(async () => {
  await Promise.all(created.map((url) => fs.unlink(assetPath(url))));
});

async function screenshot(width: number, height: number, orientation = 1) {
  // The outer frame represents HUD. Four colored center quadrants make crop and rotation observable.
  const center = Buffer.from(
    '<svg width="360" height="360"><rect width="180" height="180" fill="red"/><rect x="180" width="180" height="180" fill="lime"/><rect y="180" width="180" height="180" fill="blue"/><rect x="180" y="180" width="180" height="180" fill="yellow"/></svg>'
  );
  return sharp({
    create: { width, height, channels: 3, background: '#ff00ff' },
  })
    .composite([
      {
        input: center,
        left: Math.floor((width - 360) / 2),
        top: Math.floor((height - 360) / 2),
      },
    ])
    .png()
    .withMetadata({ orientation })
    .toBuffer();
}
async function quadrants(url: string) {
  const { data, info } = await sharp(assetPath(url))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [
    [0.15, 0.15],
    [0.85, 0.15],
    [0.15, 0.85],
    [0.85, 0.85],
  ].map(([u, v]) => {
    const offset =
      (Math.floor(v * info.height) * info.width + Math.floor(u * info.width)) *
      info.channels;
    return [...data.subarray(offset, offset + 3)];
  });
}
function expectColors(actual: number[][], expected: number[][]) {
  actual.forEach((pixel, index) =>
    pixel.forEach((value, channel) =>
      expect(Math.abs(value - expected[index][channel])).toBeLessThan(12)
    )
  );
}
const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];

describe('centered capture image processing', () => {
  it.each([
    [1920, 1080],
    [1280, 960],
    [1921, 1081],
  ])(
    'keeps only the exact center 360 pixels of a %i×%i capture',
    async (width, height) => {
      const asset = await upload(await screenshot(width, height));
      expect(asset).toMatchObject({ width: 360, height: 360 });
      const metadata = await sharp(assetPath(asset.url)).metadata();
      expect(metadata).toMatchObject({
        width: 360,
        height: 360,
        format: 'webp',
      });
      expect(metadata.exif).toBeUndefined();
      expect(
        await sharp(assetPath(asset.thumbnailUrl)).metadata()
      ).toMatchObject({ width: 240, height: 240 });
      expectColors(await quadrants(asset.url), colors);
      expectColors(await quadrants(asset.thumbnailUrl), colors);
    }
  );

  it('applies EXIF orientation before locating the center crop', async () => {
    const asset = await upload(await screenshot(960, 1280, 6));
    expectColors(await quadrants(asset.url), [
      colors[2],
      colors[0],
      colors[3],
      colors[1],
    ]);
  });

  it('hashes the final crop so different HUD borders do not bypass duplicate detection', async () => {
    const wide = await upload(await screenshot(1920, 1080));
    const standard = await upload(await screenshot(1280, 960));
    expect(wide.hash).toBe(standard.hash);
  });

  it('preserves radar dimensions when explicitly uploading a radar', async () => {
    const bytes = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: '#244453' },
    })
      .png()
      .toBuffer();
    const radar = await upload(bytes, 'radar');
    expect(radar).toMatchObject({ width: 1000, height: 500 });
    expect(await sharp(assetPath(radar.url)).metadata()).toMatchObject({
      width: 1000,
      height: 500,
    });
  });

  it('rejects undersized and invalid images without leaving partially saved files', async () => {
    const before = await fs.readdir(assetDirectory);
    const small = await sharp({
      create: { width: 359, height: 960, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(uploadAsset(small)).rejects.toMatchObject({
      code: 'LOCATION_CAPTURE_TOO_SMALL',
    });
    await expect(uploadAsset(Buffer.from('invalid'))).rejects.toMatchObject({
      code: 'LOCATION_INVALID_ASSET',
    });
    expect(await fs.readdir(assetDirectory)).toEqual(before);
  });
});
