import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { withKeyLock } from '../lock';
import { assetPath, verifyAsset } from '../assets';
import { mapGeometry } from '../coordinates';
import { applyCalibration } from '../calibration';
import type { MapDefinition } from '../types';

export async function saveMap(input: MapDefinition): Promise<MapDefinition> {
  return withKeyLock('location:catalog', () =>
    withKeyLock(`location:map:${input.id}`, async () => {
      const row = await db('location_maps').where({ id: input.id }).first();
      const old: MapDefinition | null = row ? JSON.parse(row.payload) : null;
      if (old && input.version !== old.version)
        throw new HttpError(409, 'LOCATION_STALE_STATE');
      for (const floor of input.floors)
        if (floor.radarUrl) {
          await verifyAsset(floor.radarUrl);
          // Read a buffer so libvips cannot retain a Windows file lock on a
          // radar in client/dist after calibration is saved during local tests.
          const metadata = await sharp(
            await readFile(assetPath(floor.radarUrl))
          ).metadata();
          if (
            metadata.width !== input.width ||
            metadata.height !== input.height
          )
            throw new HttpError(400, 'LOCATION_RADAR_SIZE');
        }
      // Submitted origin/scale are never calibration constraints. Recompute
      // from all measured pairs, including when an advanced editor saves them.
      const calibrated = applyCalibration(input);
      const value = {
        ...calibrated,
        version:
          old && mapGeometry(old) !== mapGeometry(calibrated)
            ? old.version + 1
            : old?.version || 1,
      };
      await db.transaction(async (trx) => {
        await trx('location_maps')
          .insert({ id: value.id, payload: JSON.stringify(value) })
          .onConflict('id')
          .merge();
        await trx('location_versions')
          .insert({
            key: `map:${value.id}:${value.version}`,
            payload: JSON.stringify(value),
          })
          .onConflict('key')
          .ignore();
      });
      return value;
    })
  );
}
