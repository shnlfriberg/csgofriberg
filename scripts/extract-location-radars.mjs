import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const extracted = path.resolve(option('--from', '.local-data/location-source'));
if (args.includes('--vpk')) {
  const executable = option('--vrf'); if (!executable) throw new Error('Provide --vrf Source2Viewer-CLI.exe');
  const result = spawnSync(executable, ['-i', option('--vpk'), '-o', extracted, '--vpk_decompile', '--vpk_filepath', 'resource/overviews/,panorama/images/overheadmaps/de_'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Radar extraction failed');
}
const names = ['Dust2', 'Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Cache', 'Overpass', 'Vertigo', 'Train'];
const output = path.resolve('client/public/location-radars'); await fs.mkdir(output, { recursive: true });
const catalog = [];
for (const [order, name] of names.entries()) {
  const id = `de_${name.toLowerCase()}`;
  const text = await fs.readFile(path.join(extracted, 'resource/overviews', `${id}.txt`), 'utf8');
  const field = key => { const match = text.match(new RegExp(`"${key}"\\s+"([^"]+)"`)); return match ? Number(match[1]) : null; };
  const source = path.join(extracted, 'panorama/images/overheadmaps');
  const primary = path.join(source, `${id}_radar_psd.png`); const metadata = await sharp(primary).metadata();
  const hasLower = text.includes('"verticalsections"') && text.includes('"lower"');
  const floors = [];
  for (const floor of hasLower ? ['upper', 'lower'] : ['main']) {
    const image = floor === 'lower' ? path.join(source, `${id}_lower_radar_psd.png`) : primary;
    const filename = `${id}_${floor}.webp`;
    const dimensions = await sharp(image).metadata(); if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) throw new Error(`${id}: floor dimensions differ`);
    await sharp(image).webp({ lossless: true }).toFile(path.join(output, filename));
    floors.push({ id: floor, name: floor, radarUrl: `/location-radars/${filename}` });
  }
  const left = field('inset_left') || 0; const top = field('inset_top') || 0; const right = field('inset_right') || 0; const bottom = field('inset_bottom') || 0;
  catalog.push({ id, name, enabled: order < 7, order, version: 1, width: metadata.width, height: metadata.height, bounds: { u: left, v: top, width: 1 - left - right, height: 1 - top - bottom }, floors,
    calibration: { posX: field('pos_x'), posY: field('pos_y'), scale: field('scale'), points: [] } });
}
await fs.writeFile(path.resolve('server/src/location/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Extracted ${catalog.length} maps, ${catalog.reduce((sum, map) => sum + map.floors.length, 0)} radars. Real-world calibration is still required.`);
