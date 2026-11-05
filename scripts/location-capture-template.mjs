import fs from 'node:fs/promises';
import path from 'node:path';
const catalog = JSON.parse(await fs.readFile(new URL('../server/src/location/catalog.json', import.meta.url), 'utf8'));
const target = path.resolve(process.argv[2] || '.local-data/location-capture/capture.csv');
const lines = ['id,imageFile,mapId,floorId,capturePointId,tier,worldX,worldY,worldZ,pitch,yaw,roll,fov,capturedAt,build,source'];
for (const map of catalog) for (const [tier, count] of [['easy', 20], ['medium', 20], ['hard', 10]]) for (let i = 1; i <= count; i++) {
  const id = `${map.id}-${tier}-${String(i).padStart(2, '0')}`;
  lines.push([id, `images/${id}.png`, map.id, map.floors.length === 1 ? map.floors[0].id : '', '', tier, '', '', '', '', '', '', '90', '', '', ''].join(','));
}
await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '\ufeff' + lines.join('\n') + '\n');
console.log(`Wrote ${lines.length - 1} EMPTY capture checklist rows to ${target}. These are not playable questions.`);
