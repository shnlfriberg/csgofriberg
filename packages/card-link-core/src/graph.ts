import type { GraphData } from "./types";
export type Graph = ReadonlyMap<number, ReadonlySet<number>>;
export function graphIndex(data: Pick<GraphData, "players" | "edges">): Graph {
  const graph = new Map(data.players.map((p) => [p.id, new Set<number>()]));
  for (const { a, b } of data.edges)
    if (a !== b && graph.has(a) && graph.has(b)) {
      graph.get(a)!.add(b);
      graph.get(b)!.add(a);
    }
  return graph;
}
export function shortestPath(
  graph: Graph,
  start: number,
  end: number,
  allowed?: ReadonlySet<number>,
): number[] | null {
  if (!graph.has(start) || !graph.has(end)) return null;
  const queue = [start],
    previous = new Map<number, number | null>([[start, null]]);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === end) return trace(previous, end);
    for (const next of graph.get(node) ?? [])
      if (!previous.has(next) && (!allowed || allowed.has(next))) {
        previous.set(next, node);
        queue.push(next);
      }
  }
  return null;
}
function trace(previous: Map<number, number | null>, end: number): number[] {
  const path: number[] = [];
  let node: number | null = end;
  while (node !== null) {
    path.push(node);
    node = previous.get(node) ?? null;
  }
  return path.reverse();
}
// 0-1 BFS minimizes newly drawn nodes, rather than hops. No path enumeration.
export function recoveryPath(
  graph: Graph,
  start: number,
  end: number,
  free: ReadonlySet<number>,
  draw: ReadonlySet<number>,
): number[] | null {
  const deque = new Map<number, number>([[0, start]]),
    dist = new Map([[start, 0]]),
    previous = new Map<number, number | null>([[start, null]]);
  let left = 0,
    right = 1;
  while (left < right) {
    const node = deque.get(left)!;
    deque.delete(left++);
    for (const next of graph.get(node) ?? []) {
      if (!free.has(next) && !draw.has(next)) continue;
      const cost = free.has(next) ? 0 : 1,
        total = dist.get(node)! + cost;
      if (total >= (dist.get(next) ?? Infinity)) continue;
      dist.set(next, total);
      previous.set(next, node);
      if (cost) deque.set(right++, next);
      else deque.set(--left, next);
    }
  }
  return dist.has(end) ? trace(previous, end) : null;
}
export function links(graph: Graph, path: number[]): boolean[] {
  return path.slice(1).map((id, i) => graph.get(path[i])?.has(id) ?? false);
}
