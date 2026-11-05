import { links, recoveryPath, shortestPath, type Graph } from "./graph";
import {
  RULES,
  RuleError,
  type Best,
  type Command,
  type PublicRound,
  type Question,
  type RoundState,
  type Variant,
} from "./types";
function check(value: unknown, code: string): asserts value {
  if (!value) throw new RuleError(code);
}
function nextRandom(state: { rng: number }) {
  let x = state.rng || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rng = x >>> 0;
  return state.rng / 4294967296;
}
export function shuffle<T>(items: T[], state: { rng: number }): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function refill(s: RoundState) {
  while (s.hand.length < RULES.handSize && s.deck.length)
    s.hand.push(s.deck.pop()!);
}
function earnToken(s: RoundState) {
  s.token = Math.min(RULES.maxTokens, s.token + 1) as RoundState['token'];
}
function pathOf(q: Question, s: RoundState) {
  return [q.start, ...s.board, q.end];
}
function record(graph: Graph, q: Question, s: RoundState, now: number) {
  const path = pathOf(q, s);
  if (
    links(graph, path).every(Boolean) &&
    (!s.best || path.length < s.best.path.length)
  )
    s.best = { path, elapsed: Math.max(0, now - s.startedAt) };
}
export function stopRound(s: RoundState, now: number) {
  s.locked = true;
  s.stoppedAt ??= Math.max(s.startedAt, Math.min(now, s.deadline ?? now));
}
function rescue(graph: Graph, q: Question, s: RoundState, now?: number) {
  const free = new Set([q.start, q.end, ...s.board]);
  if (shortestPath(graph, q.start, q.end, new Set([...free, ...s.hand])))
    return false;
  const route = recoveryPath(graph, q.start, q.end, free, new Set(s.deck));
  const needed = route?.filter((id) => !free.has(id));
  if (!needed || needed.length > RULES.handSize) {
    s.locked = true;
    if (now !== undefined) stopRound(s, now);
    s.exhausted = true;
    return true;
  }
  s.discarded.push(...s.hand);
  s.hand = needed;
  const chosen = new Set(needed);
  s.deck = s.deck.filter((id) => !chosen.has(id));
  refill(s);
  s.hand = shuffle(s.hand, s);
  s.refreshes++;
  return true;
}
function copyRound(original: RoundState): RoundState {
  return { ...original, board: [...original.board], hand: [...original.hand],
    deck: [...original.deck], discarded: [...original.discarded],
    best: original.best ? { path: [...original.best.path], elapsed: original.best.elapsed } : null };
}
// One proof-based rescue, including old persisted states. No random retry loop,
// no credit spent, and no resurrection of discarded cards.
export function recoverRound(graph: Graph, q: Question, original: RoundState, now?: number): RoundState | null {
  if (original.locked) return null;
  if (shortestPath(graph, q.start, q.end, new Set([q.start, q.end, ...original.board, ...original.hand]))) return null;
  const recovered = copyRound(original);
  return rescue(graph, q, recovered, now) ? recovered : null;
}
export function createRound(
  graph: Graph,
  q: Question,
  variant: Variant,
  seed: number,
  now: number,
  seconds: number | null,
): RoundState {
  const available = new Set(q.pool);
  check(
    q.start !== q.end &&
      !available.has(q.start) &&
      !available.has(q.end) &&
      available.size === q.pool.length &&
      q.pool.every((id) => graph.has(id)),
    "CARD_POOL_UNAVAILABLE",
  );
  const guaranteed = shortestPath(
    graph,
    q.start,
    q.end,
    new Set([q.start, q.end, ...q.pool]),
  );
  check(guaranteed && guaranteed.length >= 3, "CARD_POOL_UNAVAILABLE");
  const s: RoundState = {
    board: [],
    hand: [],
    deck: [],
    discarded: [],
    token: 0,
    best: null,
    locked: false,
    exhausted: false,
    refreshes: 0,
    rng: seed,
    startedAt: now,
    deadline: seconds === null ? null : now + seconds * 1000,
  };
  if (variant === "limited") {
    // Shuffle adjacency order to vary equally short seed routes reproducibly.
    const randomized = new Map(
      [...graph].map(([id, adj]) => [id, new Set(shuffle([...adj], s))]),
    );
    let route = shortestPath(
      randomized,
      q.start,
      q.end,
      new Set([q.start, q.end, ...q.pool]),
    );
    check(route && route.length - 2 <= RULES.handSize, "CARD_POOL_UNAVAILABLE");
    // A guaranteed hand need not already contain the global optimum. Explore a
    // bounded number of alternatives, leaving meaningful room to improve it.
    const blockers = shuffle(route.slice(1, -1), s).slice(0, 3);
    if (nextRandom(s) < 0.5)
      for (const blocked of blockers) {
        const alternative = shortestPath(
          randomized,
          q.start,
          q.end,
          new Set([q.start, q.end, ...q.pool.filter((id) => id !== blocked)]),
        );
        if (alternative && alternative.length - 2 <= RULES.handSize) {
          route = alternative;
          break;
        }
      }
    s.hand = route.slice(1, -1);
    const chosen = new Set(s.hand);
    const candidates = shuffle(
      q.pool.filter((id) => !chosen.has(id)),
      s,
    );
    // Nearby distractors create plausible branches instead of seven unrelated names.
    const nearby = new Set(route.flatMap((id) => [...(graph.get(id) ?? [])]));
    const distractors = candidates
      .filter((id) => nearby.has(id))
      .slice(0, RULES.handSize - s.hand.length);
    s.hand.push(...distractors);
    for (const id of distractors) chosen.add(id);
    s.deck = shuffle(
      q.pool.filter((id) => !chosen.has(id)),
      s,
    );
    refill(s);
    s.hand = shuffle(s.hand, s);
    check(
      shortestPath(graph, q.start, q.end, new Set([q.start, q.end, ...s.hand])),
      "CARD_POOL_UNAVAILABLE",
    );
  }
  return s;
}
export function applyCommand(
  graph: Graph,
  q: Question,
  variant: Variant,
  original: RoundState,
  command: Command,
  now: number,
): RoundState {
  check(!original.locked, "CARD_ROUND_LOCKED");
  check(
    original.deadline === null || now < original.deadline,
    "CARD_TIME_EXPIRED",
  );
  const s = copyRound(original);
  let setChanged = false;
  switch (command.type) {
    case "play": {
      const { playerId: id, index } = command;
      check(q.pool.includes(id) && !s.board.includes(id), "CARD_INVALID_CARD");
      check(
        Number.isInteger(index) && index >= 0 && index <= s.board.length,
        "CARD_INVALID_POSITION",
      );
      if (variant === "limited") {
        check(s.hand.includes(id), "CARD_NOT_IN_HAND");
        const path = pathOf(q, s);
        if (!graph.get(path[index])?.has(id) && !graph.get(id)?.has(path[index + 1])) {
          // A rejected insertion used to bypass the post-command rescue. Only
          // refresh when the whole available set is unsolvable, not on a bad guess.
          if (rescue(graph, q, s, now)) return s;
          throw new RuleError('CARD_NO_CONNECTION');
        }
        s.hand = s.hand.filter((p) => p !== id);
        refill(s);
        earnToken(s);
        setChanged = true;
      }
      s.board.splice(index, 0, id);
      break;
    }
    case "remove":
      check(s.board.includes(command.playerId), "CARD_INVALID_CARD");
      s.board = s.board.filter((id) => id !== command.playerId);
      if (variant === "limited") {
        s.discarded.push(command.playerId);
        earnToken(s);
        setChanged = true;
      }
      break;
    case "reorder":
      check(
        command.board.length === s.board.length &&
          new Set(command.board).size === s.board.length &&
          command.board.every((id) => s.board.includes(id)),
        "CARD_INVALID_POSITION",
      );
      s.board = [...command.board];
      break;
    case "swap":
    case "refresh": {
      if (variant === 'limited' && s.token === 0 &&
          (command.type === 'refresh' || s.hand.includes(command.playerId)) && rescue(graph, q, s, now)) return s;
      check(variant === "limited" && s.token > 0, "CARD_NO_TOKEN");
      const removed =
        command.type === "refresh" ? [...s.hand] : [command.playerId];
      check(
        removed.every((id) => s.hand.includes(id)),
        "CARD_NOT_IN_HAND",
      );
      s.discarded.push(...removed);
      s.hand = s.hand.filter((id) => !removed.includes(id));
      refill(s);
      s.token = s.token === 2 ? 1 : 0;
      setChanged = true;
      break;
    }
    case "lock":
      stopRound(s, now);
      break;
  }
  record(graph, q, s, now);
  if (setChanged && !s.locked) rescue(graph, q, s, now);
  return s;
}
export function publicRound(
  graph: Graph,
  q: Question,
  s: RoundState,
): PublicRound {
  const { deck, rng, ...view } = s;
  return { ...view, remaining: deck.length, links: links(graph, pathOf(q, s)) };
}
export function compareResults(a: (Best | null)[], b: (Best | null)[]): number {
  const summary = (v: (Best | null)[]) => {
    const solved = v.filter((x): x is Best => x !== null);
    return [
      solved.length,
      solved.reduce((n, x) => n + x.path.length - 1, 0),
      solved.reduce((n, x) => n + x.elapsed, 0),
    ];
  };
  const x = summary(a),
    y = summary(b);
  return y[0] - x[0] || x[1] - y[1] || x[2] - y[2];
}
