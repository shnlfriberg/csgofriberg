import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type { Scene } from '@friberg/card-link-core';
import { transaction, lockRow } from './transaction';
import { HttpError } from '../middleware/common';

export const scenes = ['practice', 'daily', 'friend', 'ranked'] as const;
export function sceneFlags(catalog: Record<string, unknown>) {
  return Object.fromEntries(scenes.map(scene => [scene, catalog[`${scene}_enabled`] === undefined || Boolean(catalog[`${scene}_enabled`])])) as Record<Scene, boolean>;
}
export function requireScene(catalog: Record<string, unknown>, scene: Scene) {
  if (!catalog.enabled || !catalog.graph_version) throw new HttpError(503, 'CARD_NOT_READY');
  if (!sceneFlags(catalog)[scene]) throw new HttpError(503, 'CARD_SCENE_DISABLED');
}
export async function auditOperation(trx: Knex.Transaction, action: string, actor: number | null, payload: unknown) {
  await trx('card_admin_events').insert({ id: randomUUID(), action, actor, payload: JSON.stringify(payload), created_at: Date.now() });
}
export async function configureScenes(input: { enabled?: boolean; scenes?: Partial<Record<Scene, boolean>> }, actor: number) {
  return transaction(async trx => {
    const before = await lockRow(trx, 'card_catalog', { id: 1 });
    const update: Record<string, boolean> = {};
    if (input.enabled !== undefined) update.enabled = input.enabled;
    for (const scene of scenes) if (input.scenes?.[scene] !== undefined) update[`${scene}_enabled`] = input.scenes[scene]!;
    await trx('card_catalog').where({ id: 1 }).update(update);
    if (input.enabled === false || input.scenes?.ranked === false) await trx('card_queue').delete();
    await auditOperation(trx, 'configure', actor, { before: { enabled: Boolean(before.enabled), scenes: sceneFlags(before) }, changes: input });
    return { ok: true };
  });
}
