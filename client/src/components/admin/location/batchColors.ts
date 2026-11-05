// Sort IDs before resolving palette collisions so API order and filters never
// change the colors of the same set of batches.
const palette = ['#176b53', '#275cc4', '#9c3838', '#7544b0', '#9a501d', '#086b80', '#98386f', '#535bb0', '#65701a', '#655046'];

export function batchColors(ids: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    let hash = 2166136261;
    for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    let index = (hash >>> 0) % palette.length;
    if (used.size < palette.length) {
      while (used.has(index)) index = (index + 1) % palette.length;
      used.add(index);
      colors.set(id, palette[index]);
    } else {
      colors.set(id, `hsl(${((hash >>> 0) * 137.508) % 360} 55% 34%)`);
    }
  }
  return colors;
}
