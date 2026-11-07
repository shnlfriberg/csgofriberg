import type { View } from "./types";

export type Patch = Pick<
  View,
  "id" | "phaseRevision" | "revision" | "players"
> &
  Partial<Pick<View, "current" | "publicRevision" | "connections" | "dueAt" | "expiresAt">> & {
    baseRevision: number | null;
  };

export function acceptState(old: View | null, next: View): View {
  if (
    !old ||
    old.id !== next.id ||
    next.phaseRevision > old.phaseRevision ||
    (next.phaseRevision === old.phaseRevision &&
      next.revision >= old.revision &&
      (next.publicRevision ?? 0) >= (old.publicRevision ?? 0))
  )
    return next;
  return old;
}

export function acceptPatch(
  old: View | null,
  patch: Patch,
): { view: View | null; reload: boolean } {
  if (!old || old.id !== patch.id) return { view: old, reload: true };
  if (
    patch.phaseRevision < old.phaseRevision ||
    (patch.phaseRevision === old.phaseRevision &&
      (patch.revision < old.revision ||
        (patch.publicRevision ?? 0) < (old.publicRevision ?? 0)))
  )
    return { view: old, reload: false };
  // The HTTP command response already advanced this seat: the matching push is
  // a duplicate. Keep only newer public data instead of reloading the match.
  if (old.phaseRevision === patch.phaseRevision && old.revision === patch.revision) {
    if ((patch.publicRevision ?? 0) <= (old.publicRevision ?? 0)) return { view: old, reload: false };
    return {
      view: {
        ...old,
        publicRevision: patch.publicRevision ?? old.publicRevision,
        players: patch.players,
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      },
      reload: false,
    };
  }
  if (
    old.phaseRevision !== patch.phaseRevision ||
    old.revision !== patch.baseRevision
  )
    return { view: old, reload: true };
  return {
    view: {
      ...old,
      revision: patch.revision,
      publicRevision: patch.publicRevision ?? old.publicRevision,
      players: patch.players,
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.current !== undefined ? { current: patch.current } : {}),
      ...(patch.connections !== undefined ? { connections: patch.connections } :
        patch.current !== undefined ? { connections: [] } : {}),
    },
    reload: false,
  };
}
