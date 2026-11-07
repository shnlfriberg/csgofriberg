import path from "path";
import { fork, type ChildProcess } from "child_process";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { io as connectSocket, type Socket } from "socket.io-client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { db } from "../../src/db/knex";
import { ensureSchema } from "../../src/db/schema";
import { config } from "../../src/config";
import { browserFingerprint } from "../../src/services/pow";
import { advanceById } from '../../src/card-link/matches';
import {
  graphIndex,
  shortestPath,
  type GraphData,
} from "@friberg/card-link-core";

describe("card private synchronization across real processes", () => {
  const children: ChildProcess[] = [],
    sockets: Socket[] = [],
    ports: number[] = [];
  const agent = "card-socket-drill",
    ip = "192.0.2.222";
  const keys = Array.from({ length: 3 }, () => `card-socket-${randomUUID()}`);
  const cookies = keys.map(
    (key) =>
      `csgofriberg_guest=${jwt.sign({ key, typ: "guest" }, config.jwtSecret, { expiresIn: "1h" })}; csgofriberg_pow=${jwt.sign({ typ: "pow", fp: browserFingerprint(agent, ip), jti: randomUUID(), difficulty: config.powDifficulty }, config.jwtSecret, { expiresIn: "1h" })}`,
  );
  let id: string;
  const extraMatches: string[] = [];
  const version = "c".repeat(64);
  const data: GraphData = {
    version,
    players: Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      nickname: `P${i + 1}`,
      nationality: "",
      age: 25,
      team: "",
      aliases: [],
    })),
    edges: Array.from({ length: 14 }, (_, i) => ({
      a: i + 1,
      b: i + 2,
      evidence: [],
    })),
    pairs: {
      easy: [
        [1, 3],
        [2, 4],
        [3, 5],
      ],
      normal: [
        [1, 4],
        [2, 5],
        [3, 6],
      ],
      hard: [
        [1, 6],
        [2, 7],
        [3, 8],
      ],
    },
  };
  async function instance() {
    const child = fork(path.resolve(__dirname, "instance.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        JWT_SECRET: config.jwtSecret,
        TRUST_PROXY: "true",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    child.stderr?.on("data", (data) => {
      if (!String(data).includes("ExperimentalWarning"))
        process.stderr.write(data);
    });
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("START_TIMEOUT")),
        15000,
      );
      child.once("message", (m: any) => {
        clearTimeout(timeout);
        resolve(m.port);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code) reject(new Error(`EXIT:${code}`));
      });
    });
  }
  async function request(
    processIndex: number,
    seat: number,
    url: string,
    body?: unknown,
  ) {
    const response = await fetch(
      `http://127.0.0.1:${ports[processIndex]}/api/card-link${url}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookies[seat],
          "User-Agent": agent,
          "X-Forwarded-For": ip,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  }
  async function connect(processIndex: number, seat: number) {
    const socket = connectSocket(`http://127.0.0.1:${ports[processIndex]}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        Cookie: cookies[seat],
        "User-Agent": agent,
        "X-Forwarded-For": ip,
      },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    await new Promise<void>((resolve, reject) =>
      socket
        .timeout(5000)
        .emit("card-link:watch", { id }, (error: unknown, result: any) =>
          error || !result.ok ? reject(error ?? result) : resolve(),
        ),
    );
    return socket;
  }
  beforeAll(async () => {
    if (!process.env.DB_URL?.includes("verification"))
      throw new Error("ISOLATED_DB_REQUIRED");
    await ensureSchema();
    await db.raw("PRAGMA journal_mode=WAL");
    await db("card_graphs").insert({
      version,
      source_revision: 0,
      payload: JSON.stringify(data),
      created_at: Date.now(),
    });
    await db("card_catalog")
      .where({ id: 1 })
      .update({ enabled: true, graph_version: version });
    ports.push(await instance(), await instance());
  }, 40000);
  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    for (const child of children)
      if (child.connected) {
        child.send("stop");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill();
            resolve();
          }, 10000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    const cleanupIds = new Set([...extraMatches, ...(id ? [id] : [])]);
    for (const id of cleanupIds) {
      for (const table of [
        "card_participants",
        "card_results",
        "card_outbox",
        "card_reservations",
        "card_seats",
      ])
        await db(table).where({ match_id: id }).delete();
      await db("card_matches").where({ id }).delete();
    }
    await db("card_requests").where("scope", "like", "%card-socket-%").delete();
    await db("card_catalog")
      .where({ id: 1 })
      .update({ enabled: false, graph_version: null });
    await db("card_graphs").where({ version }).delete();
    await db.destroy();
  }, 30000);
  it('returns validation errors for malformed queries without querying invalid SQL offsets', async () => {
    for (const url of ['/leaderboard?variant=unknown', '/daily-leaderboard?day=invalid']) {
      const response = await fetch(`http://127.0.0.1:${ports[0]}/api/card-link${url}`, {
        headers: { Cookie: cookies[0], 'User-Agent': agent, 'X-Forwarded-For': ip },
      });
      expect(response.status, url).toBe(400);
      expect(await response.json()).toEqual({ code: 'VALIDATION_FAILED' });
    }
  });
  it('creates, joins, restores, commands and rematches using only WS across two processes', async () => {
    const connectLobby = async (processIndex: number, seat: number) => {
      const socket = connectSocket(`http://127.0.0.1:${ports[processIndex]}`, { transports: ['websocket'], reconnection: false,
        extraHeaders: { Cookie: cookies[seat], 'User-Agent': agent, 'X-Forwarded-For': ip } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      return socket;
    };
    const send = async (socket: Socket, event: string, data: unknown): Promise<any> => {
      const result = await new Promise<any>((resolve, reject) => socket.timeout(10000).emit(event, data,
        (error: unknown, result: unknown) => error ? reject(error) : resolve(result)));
      expect(result, `${event}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      return result.data;
    };
    const a = await connectLobby(0, 0), b = await connectLobby(1, 1), c = await connectLobby(1, 2);
    const created = await send(a, 'card-link:create', { scene: 'friend', variant: 'limited', difficulty: 'normal', duration: 120, requestId: randomUUID() });
    const currentId = created.id; extraMatches.push(currentId);
    const original = await send(a, 'card-link:watch', { id: currentId });
    await send(b, 'card-link:join', { code: original.code });
    await send(b, 'card-link:watch', { id: currentId });
    await send(c, 'card-link:join', { code: original.code });
    await send(c, 'card-link:watch', { id: currentId });
    expect(await send(b, 'card-link:active', {})).toMatchObject({ id: currentId });
    expect((await send(a, 'card-link:directory', { id: currentId })).players).toHaveLength(15);
    for (const socket of [a, b, c]) await send(socket, 'card-link:control', { id: currentId, action: 'ready', requestId: randomUUID() });
    await send(a, 'card-link:control', { id: currentId, action: 'start', requestId: randomUUID() });
    let state: any;
    const until = Date.now() + 10000;
    do { state = await send(a, 'card-link:state', { id: currentId }); if (state.status === 'playing') break;
      await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < until);
    expect(state.status).toBe('playing');
    const input = { id: currentId, requestId: randomUUID(), revision: state.revision, phaseRevision: state.phaseRevision, command: { type: 'reorder', board: [] } };
    const result = await send(a, 'card-link:command', input);
    const anotherTab = await connectLobby(1, 0);
    await send(anotherTab, 'card-link:watch', { id: currentId });
    expect(await send(anotherTab, 'card-link:command', input)).toEqual(result);
    anotherTab.disconnect();
    // Advance a terminal test fixture through the real finish/settlement path.
    const raw = await db('card_matches').where({ id: currentId }).first();
    const m = JSON.parse(raw.payload); m.status = 'playing'; m.round = 2; m.dueAt = Date.now() - 1;
    await db('card_matches').where({ id: currentId }).update({ status: m.status, due_at: m.dueAt, payload: JSON.stringify(m) });
    await advanceById(currentId);
    expect((await send(a, 'card-link:state', { id: currentId })).status).toBe('finished');
    const oldSeats = await db('card_seats').where({ match_id: currentId }).orderBy('identity_key');
    await send(a, 'card-link:rematch', { id: currentId, wanted: true, requestId: randomUUID() });
    expect((await send(b, 'card-link:state', { id: currentId })).rematch).toMatchObject({ acceptedKeys: [state.me], requiredKeys: expect.any(Array) });
    await send(a, 'card-link:rematch', { id: currentId, wanted: false, requestId: randomUUID() });
    expect((await send(b, 'card-link:state', { id: currentId })).rematch.acceptedKeys).toEqual([]);
    await send(a, 'card-link:rematch', { id: currentId, wanted: true, requestId: randomUUID() });
    await send(b, 'card-link:rematch', { id: currentId, wanted: true, requestId: randomUUID() });
    expect((await send(a, 'card-link:state', { id: currentId })).rematch.nextId).toBeUndefined();
    const requestId = randomUUID();
    const next = await send(c, 'card-link:rematch', { id: currentId, wanted: true, requestId });
    extraMatches.push(next.nextId);
    expect(next.nextId).toBeTypeOf('string'); expect(next.nextId).not.toBe(currentId);
    expect(await send(c, 'card-link:rematch', { id: currentId, wanted: true, requestId })).toEqual(next);
    expect((await send(a, 'card-link:state', { id: currentId })).rematch.nextId).toBe(next.nextId);
    expect(await db('card_seats').where({ match_id: currentId }).orderBy('identity_key')).toEqual(oldSeats);
    const nextView = await send(a, 'card-link:watch', { id: next.nextId });
    await send(b, 'card-link:watch', { id: next.nextId });
    await send(c, 'card-link:watch', { id: next.nextId });
    expect(nextView).toMatchObject({ scene: 'friend', variant: 'limited', difficulty: 'normal', duration: 120, round: 0, status: 'preparing' });
    expect(nextView.players.every((p: any) => p.ready && p.results.length === 0 && !p.retired)).toBe(true);
    for (const socket of [a, b, c]) await send(socket, 'card-link:control', { id: next.nextId, action: 'leave', requestId: randomUUID() });
    a.disconnect(); b.disconnect(); c.disconnect();
  }, 30000);
  it("keeps opponent cards private, retries across instances, and resumes after process death", async () => {
    id = (
      await request(0, 0, "/matches", {
        scene: "friend",
        variant: "limited",
        difficulty: "normal",
        duration: 120,
        requestId: randomUUID(),
      })
    ).id;
    let v = await request(0, 0, `/matches/${id}`);
    await request(1, 1, "/join", { code: v.code });
    const a = await connect(0, 0),
      b = await connect(1, 1),
      opponentPackets: any[] = [];
    b.on("card-link:state", (v) => opponentPackets.push(v));
    b.on("card-link:patch", (v) => opponentPackets.push(v));
    for (const seat of [0, 1])
      await request(seat, seat, `/matches/${id}/control`, {
        action: "ready",
        requestId: randomUUID(),
      });
    await request(0, 0, `/matches/${id}/control`, {
      action: "start",
      requestId: randomUUID(),
    });
    const deadline = Date.now() + 10000;
    do {
      v = await request(0, 0, `/matches/${id}`);
      if (v.status === "playing") break;
      await new Promise((r) => setTimeout(r, 150));
    } while (Date.now() < deadline);
    expect(v.status).toBe("playing");
    const graph = graphIndex(data),
      route = shortestPath(
        graph,
        v.question.start,
        v.question.end,
        new Set([v.question.start, v.question.end, ...v.current.hand]),
      )!;
    const input = {
      requestId: randomUUID(),
      revision: v.revision,
      phaseRevision: v.phaseRevision,
      command: { type: "play", playerId: route[1], index: 0 },
    };
    const result = await request(0, 0, `/matches/${id}/commands`, input);
    expect(result.connections.some((edge: any) => [edge.a, edge.b].includes(route[0]) && [edge.a, edge.b].includes(route[1]))).toBe(true);
    expect(await request(1, 0, `/matches/${id}/commands`, input)).toEqual(
      result,
    );
    expect(opponentPackets.length).toBeGreaterThan(0);
    for (const packet of opponentPackets) {
      expect(JSON.stringify(packet)).not.toContain(keys[0]);
      expect(
        packet.players.every((p: any) => !("hand" in p) && !("board" in p)),
      ).toBe(true);
      if (packet.current) expect(packet.me === v.me).toBe(false);
      expect(packet.connections ?? []).toEqual([]);
    }
    // Membership is cluster-wide and supports multiple tabs for one identity.
    const extraTab = await connect(1, 0);
    a.disconnect();
    expect((await request(1, 0, `/matches/${id}`)).players.find((p: any) => p.id === v.me).connected).toBe(true);
    extraTab.disconnect();
    let offline: any;
    const offlineLimit = Date.now() + 5000;
    do {
      offline = (await request(1, 1, `/matches/${id}`)).players.find((p: any) => p.id === v.me);
      if (!offline.connected) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < offlineLimit);
    expect(offline.connected).toBe(false);
    expect(offline.disconnectAt - Date.now()).toBeGreaterThan(25000);
    await connect(0, 0);
    expect((await request(1, 1, `/matches/${id}`)).players.find((p: any) => p.id === v.me))
      .toMatchObject({ connected: true, retired: false, disconnectAt: null });
    children[0].kill();
    await new Promise((resolve) => children[0].once("exit", resolve));
    a.disconnect();
    await connect(1, 0);
    const restored = await request(1, 0, `/matches/${id}`);
    expect(restored.current).toEqual(result.current);
    expect(restored.connections).toEqual(result.connections);
    expect(await request(1, 0, `/matches/${id}/commands`, input)).toEqual(
      result,
    );
    for (const seat of [0, 1])
      await request(1, seat, `/matches/${id}/control`, {
        action: "leave",
        requestId: randomUUID(),
      });
    expect((await request(1, 0, `/matches/${id}`)).status).toBe("finished");
  }, 30000);
});
