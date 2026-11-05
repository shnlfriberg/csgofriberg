import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { processLocationImage } from '../server/src/location/imageProcessing.ts';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2); const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
if (!args.includes('--input')) { console.log('node scripts/prepare-location-import.mjs --input capture.csv|capture.json [--maps maps.json] [--out directory] [--check]'); process.exit(1); }
const inputPath = path.resolve(option('--input')); const base = path.dirname(inputPath);
const catalogFile = option('--maps', fileURLToPath(new URL('../server/src/location/catalog.json', import.meta.url)));
const rawMaps = JSON.parse(await fs.readFile(catalogFile, 'utf8')); const maps = Array.isArray(rawMaps) ? rawMaps : rawMaps.maps;
const source = (await fs.readFile(inputPath, 'utf8')).replace(/^\ufeff/, '');
function csv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (!quoted && (c === ',' || c === '\n')) { row.push(cell.replace(/\r$/, '')); cell = ''; if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; } } else cell += c; }
  if (quoted) throw new Error('Unclosed CSV quote'); if (cell || row.length) { row.push(cell); rows.push(row); }
  const headings = rows.shift(); return rows.map(row => Object.fromEntries(headings.map((key, i) => [key, row[i] ?? ''])));
}
const entries = inputPath.endsWith('.csv') ? csv(source) : JSON.parse(source).questions;
if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw new Error('Expected 1–500 captures');
const failures = []; const prepared = []; const ids = new Set(); const hashes = new Map(); const points = new Map();
for (const [index, entry] of entries.entries()) {
  try {
    const id = entry.id; if (!/^[\w-]{1,64}$/.test(id || '') || ids.has(id)) throw new Error('Missing/duplicate/invalid id'); ids.add(id);
    const map = maps.find(map => map.id === entry.mapId); if (!map) throw new Error('Unknown map');
    if (!map.floors.some(floor => floor.id === entry.floorId)) throw new Error('Choose an explicit valid floor');
    if (!/^[\w-]{1,64}$/.test(entry.capturePointId || '')) throw new Error('Missing capturePointId');
    if (!['easy', 'medium', 'hard'].includes(entry.tier)) throw new Error('Unknown question tier');
    const number = value => { if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error('Missing/invalid measured position or camera'); return Number(value); };
    const world = entry.world ? { x: number(entry.world.x), y: number(entry.world.y), z: number(entry.world.z) } : { x: number(entry.worldX), y: number(entry.worldY), z: number(entry.worldZ) };
    const view = entry.view ? Object.fromEntries(['pitch', 'yaw', 'roll', 'fov'].map(key => [key, number(entry.view[key])])) : { pitch: number(entry.pitch), yaw: number(entry.yaw), roll: number(entry.roll), fov: number(entry.fov) };
    if (view.fov <= 0 || view.fov >= 180) throw new Error('Invalid FOV');
    const u = (world.x - map.calibration.posX) / (map.calibration.scale * map.width); const v = (map.calibration.posY - world.y) / (map.calibration.scale * map.height);
    if (![u, v].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Position is outside radar canvas');
    if (!entry.build?.trim() || !entry.source?.trim() || !Number.isFinite(Date.parse(entry.capturedAt))) throw new Error('Missing build/source/capture timestamp');
    const pointKey = `${map.id}:${entry.capturePointId}`; const previous = points.get(pointKey);
    if (previous && Math.hypot(previous.x - world.x, previous.y - world.y, previous.z - world.z) > 1) throw new Error('Same capturePointId has different measured positions'); points.set(pointKey, world);
    const image = path.resolve(base, entry.imageFile || ''); const relative = path.relative(base, image);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('imageFile must stay inside capture directory');
    const bytes = await fs.readFile(image); if (bytes.length > 16 * 1024 * 1024) throw new Error('Image exceeds 16MB');
    const { full: pixels } = await processLocationImage(bytes); const hash = createHash('sha256').update(pixels).digest('hex');
    if (hashes.has(hash)) throw new Error(`Duplicate image: ${hashes.get(hash)}`); hashes.set(hash, id);
    const imageFile = `images/${id}${path.extname(image).toLowerCase()}`;
    prepared.push({ image, data: { id, imageFile, mapId: map.id, mapVersion: map.version, floorId: entry.floorId, capturePointId: entry.capturePointId, tier: entry.tier, u, v, world, view, capturedAt: new Date(entry.capturedAt).toISOString(), build: entry.build.trim(), source: entry.source.trim(), status: 'draft' } });
  } catch (error) { failures.push({ row: index + 2, id: entry.id, error: error.message }); }
}
if (failures.length) { console.error(JSON.stringify({ valid: prepared.length, errors: failures }, null, 2)); process.exit(1); }
const counts = maps.map(map => ({ mapId: map.id, ...Object.fromEntries(['easy', 'medium', 'hard'].map(tier => [tier, prepared.filter(q => q.data.mapId === map.id && q.data.tier === tier).length])) }));
console.log(JSON.stringify({ valid: prepared.length, counts, publication: 'DRAFT ONLY; human review and measured floor calibration required' }, null, 2));
if (!args.includes('--check')) { const out = path.resolve(option('--out', '.local-data/location-import')); await fs.mkdir(path.join(out, 'images'), { recursive: true }); for (const item of prepared) await fs.copyFile(item.image, path.join(out, item.data.imageFile)); await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ questions: prepared.map(q => q.data) }, null, 2)); console.log(`Import directory: ${out}`); }
