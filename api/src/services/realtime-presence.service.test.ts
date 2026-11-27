/**
 * Realtime presence: the in-memory store (no REDIS_URL) and the Redis sorted
 * set (ioredis mocked), including the fail-open read on a Redis error.
 */
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, ...unknown[]];

const redisMock = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    ready: () => {},
    execResults: [] as Array<Array<[Error | null, unknown]> | null>,
    zremError: null as Error | null,
    execError: null as Error | null,
  };
  class FakeRedis {
    status = "ready";
    disconnect() {}
    on(event: string, callback: () => void) {
      if (event === "ready") state.ready = callback;
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    multi() {
      const queued: Call[] = [];
      const chain = {
        zadd: (...args: unknown[]) => {
          queued.push(["zadd", ...args]);
          return chain;
        },
        expire: (...args: unknown[]) => {
          queued.push(["expire", ...args]);
          return chain;
        },
        zremrangebyscore: (...args: unknown[]) => {
          queued.push(["zremrangebyscore", ...args]);
          return chain;
        },
        zcount: (...args: unknown[]) => {
          queued.push(["zcount", ...args]);
          return chain;
        },
        exec: async () => {
          state.calls.push(["multi"], ...queued, ["exec"]);
          if (state.execError) throw state.execError;
          if (state.execResults.length) return state.execResults.shift();
          return queued.map(() => [null, 0]);
        },
      };
      return chain;
    }
    async zrem(...args: unknown[]) {
      state.calls.push(["zrem", ...args]);
      if (state.zremError) throw state.zremError;
      return 1;
    }
  }
  return { state, FakeRedis };
});

vi.mock("ioredis", () => ({ Redis: redisMock.FakeRedis }));

import {
  clearRealtimePresence,
  hasAttachedClients,
  resetRealtimePresenceForTests,
  touchRealtimePresence,
} from "./realtime-presence.service";

const WS = "ws-a";
const OTHER_WS = "ws-b";
const T0 = 1_800_000_000_000;

describe("realtime presence (in-memory fallback)", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", undefined);
    resetRealtimePresenceForTests();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetRealtimePresenceForTests();
  });

  it("reports nothing attached for an unknown workspace", async () => {
    expect(await hasAttachedClients(WS)).toBe(false);
  });

  it("counts a touched client as attached within 60s", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    expect(await hasAttachedClients(WS)).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    expect(await hasAttachedClients(WS)).toBe(true);
  });

  it("drops a client more than 60s stale", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    vi.setSystemTime(T0 + 60_001);
    expect(await hasAttachedClients(WS)).toBe(false);
  });

  it("a fresh heartbeat revives a stale client", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    vi.setSystemTime(T0 + 120_000);
    expect(await hasAttachedClients(WS)).toBe(false);
    await touchRealtimePresence(WS, "tab-1", "user-1");
    expect(await hasAttachedClients(WS)).toBe(true);
  });

  it("clear removes the client", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    await clearRealtimePresence(WS, "tab-1");
    expect(await hasAttachedClients(WS)).toBe(false);
  });

  it("keeps other clients and workspaces apart", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    await touchRealtimePresence(WS, "tab-2", "user-2");
    await touchRealtimePresence(OTHER_WS, "tab-3", "user-1");
    await clearRealtimePresence(WS, "tab-1");
    expect(await hasAttachedClients(WS)).toBe(true);
    await clearRealtimePresence(WS, "tab-2");
    expect(await hasAttachedClients(WS)).toBe(false);
    expect(await hasAttachedClients(OTHER_WS)).toBe(true);
  });

  it("ignores an empty clientId", async () => {
    await touchRealtimePresence(WS, "", "user-1");
    expect(await hasAttachedClients(WS)).toBe(false);
    await touchRealtimePresence(WS, "tab-1", "user-1");
    await clearRealtimePresence(WS, "");
    expect(await hasAttachedClients(WS)).toBe(true);
  });
});

describe("realtime presence (Redis sorted set)", () => {
  const key = "mako:realtime:presence:ws-a";

  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "redis://presence.test:6379");
    resetRealtimePresenceForTests();
    redisMock.state.calls = [];
    redisMock.state.execResults = [];
    redisMock.state.zremError = null;
    redisMock.state.execError = null;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetRealtimePresenceForTests();
  });

  it("fails open when Redis aborts the transaction", async () => {
    redisMock.state.execResults = [null];
    expect(await hasAttachedClients(WS)).toBe(true);
  });

  it("touch refreshes the tab, prunes stale members and renews the key in one transaction", async () => {
    await touchRealtimePresence(WS, "tab-1", "user-1");
    expect(redisMock.state.calls).toEqual([
      ["multi"],
      ["zadd", key, T0, "tab-1"],
      ["zremrangebyscore", key, "-inf", T0 - 90_000],
      ["expire", key, 90],
      ["exec"],
    ]);
  });

  it("touch skips Redis for an empty clientId", async () => {
    await touchRealtimePresence(WS, "", "user-1");
    await clearRealtimePresence(WS, "");
    expect(redisMock.state.calls).toEqual([]);
  });

  it("clear runs ZREM", async () => {
    await clearRealtimePresence(WS, "tab-1");
    expect(redisMock.state.calls).toEqual([["zrem", key, "tab-1"]]);
  });

  it("hasAttachedClients prunes >90s and counts the last 60s", async () => {
    redisMock.state.execResults = [
      [
        [null, 2],
        [null, 1],
      ],
    ];
    expect(await hasAttachedClients(WS)).toBe(true);
    expect(redisMock.state.calls).toEqual([
      ["multi"],
      ["zremrangebyscore", key, "-inf", T0 - 90_000],
      ["zcount", key, T0 - 60_000, "+inf"],
      ["exec"],
    ]);
  });

  it("trusts an empty set only after heartbeats can repopulate a restarted Redis", async () => {
    expect(await hasAttachedClients(WS)).toBe(true);
    vi.setSystemTime(T0 + 30_001);
    expect(await hasAttachedClients(WS)).toBe(false);
    redisMock.state.ready();
    vi.setSystemTime(T0 + 45_000);
    expect(await hasAttachedClients(WS)).toBe(true);
    vi.setSystemTime(T0 + 61_000);
    redisMock.state.execResults = [
      [
        [null, 0],
        [null, 0],
      ],
    ];
    expect(await hasAttachedClients(WS)).toBe(false);
  });

  it("fails open when Redis throws", async () => {
    redisMock.state.execError = new Error("connection refused");
    expect(await hasAttachedClients(WS)).toBe(true);
  });

  it("fails open when a queued command errors", async () => {
    redisMock.state.execResults = [
      [
        [null, 0],
        [new Error("WRONGTYPE"), null],
      ],
    ];
    expect(await hasAttachedClients(WS)).toBe(true);
  });

  it("touch and clear swallow Redis errors", async () => {
    redisMock.state.execError = new Error("connection refused");
    redisMock.state.zremError = new Error("connection refused");
    await expect(
      touchRealtimePresence(WS, "tab-1", "user-1"),
    ).resolves.toBeUndefined();
    await expect(clearRealtimePresence(WS, "tab-1")).resolves.toBeUndefined();
  });
});

it("sends no Mongo commands during the Redis presence lifecycle", async () => {
  const mongo = await MongoMemoryServer.create();
  try {
    vi.stubEnv("DATABASE_URL", mongo.getUri());
    vi.stubEnv("REDIS_URL", "redis://presence.test:6379");
    await mongoose.connect(mongo.getUri(), { monitorCommands: true });
    const client = mongoose.connection.getClient();
    const commands: string[] = [];
    client.on("commandStarted", e => {
      if (e.command[e.commandName] === "realtime_presence") {
        commands.push(e.commandName);
      }
    });

    const workspaceId = new Types.ObjectId();
    const id = workspaceId.toHexString();
    await client.db().collection("realtime_presence").insertOne({
      workspaceId,
      clientId: "legacy-tab",
      userId: "user",
      lastSeenAt: new Date(),
    });
    // Positive control for the monitor, and a fresh legacy row that would
    // make an accidental Mongo fallback report a client after disconnect.
    expect(commands).toEqual(["insert"]);
    commands.length = 0;
    resetRealtimePresenceForTests();
    redisMock.state.execError = null;
    redisMock.state.execResults = [];
    redisMock.state.zremError = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    await touchRealtimePresence(id, "tab", "user");
    vi.setSystemTime(Date.now() + 31_000);
    await touchRealtimePresence(id, "tab", "user");
    redisMock.state.execResults.push([
      [null, 0],
      [null, 1],
    ]);
    expect(await hasAttachedClients(id)).toBe(true);
    await clearRealtimePresence(id, "tab");
    expect(await hasAttachedClients(id)).toBe(false);
    expect(commands).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetRealtimePresenceForTests();
    await mongoose.disconnect();
    await mongo.stop();
  }
});
