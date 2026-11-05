import { db } from '../../db/knex';

export async function captureCounts(): Promise<{ points: number; withImages: number }> {
  const hasImages = db.client.config.client === 'pg'
    ? "jsonb_typeof(payload::jsonb->'asset') = 'object' or (case when jsonb_typeof(payload::jsonb->'images') = 'array' then jsonb_array_length(payload::jsonb->'images') else 0 end) > 0"
    : "json_type(payload, '$.asset') = 'object' or coalesce(json_array_length(payload, '$.images'), 0) > 0";
  const row = await db('location_capture_drafts').count({ points: '*' })
    .sum({ withImages: db.raw(`case when ${hasImages} then 1 else 0 end`) }).first();
  return { points: Number(row?.points ?? 0), withImages: Number(row?.withImages ?? 0) };
}

export async function captureImageIdExists(id: string): Promise<boolean> {
  const match = db.client.config.client === 'pg'
    ? "exists (select 1 from jsonb_array_elements(case when jsonb_typeof(payload::jsonb->'images') = 'array' then payload::jsonb->'images' else '[]'::jsonb end) image where image->>'id' = ?)"
    : "exists (select 1 from json_each(payload, '$.images') image where json_extract(image.value, '$.id') = ?)";
  return Boolean(await db('location_capture_drafts').where('id', id).orWhereRaw(match, [id]).first('id'));
}
