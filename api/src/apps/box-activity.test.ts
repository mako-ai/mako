/**
 * Real use is recorded; polls are not; a paused box is not woken by a poll.
 * No E2B and no database: both are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppsMetadataRepository } from "../repositories/apps-metadata";

const appsMetadataRepo = vi.hoisted(() => ({
  bumpWorktreeActivity: vi.fn(async () => undefined),
  listWorktreesActivity:
    vi.fn<AppsMetadataRepository["listWorktreesActivity"]>(),
}));
vi.mock("../repositories/apps-metadata", async importOriginal => ({
  ...(await importOriginal<typeof import("../repositories/apps-metadata")>()),
  appsMetadataRepo,
}));

const provider = vi.hoisted(() => ({
  id: "e2b",
  hasSession: vi.fn(async () => true),
  isRunning: vi.fn(async (_ctx: unknown) => false),
  exec: vi.fn(async () => ({
    exitCode: 0,
    stdout: "12\nhello",
    stderr: "",
    timedOut: false,
    durationMs: 1,
    truncated: false,
  })),
}));
vi.mock("./sandbox/provider", () => ({
  getSandboxProvider: () => provider,
  boxIsRunning: (ctx: unknown) => provider.isRunning(ctx),
  isSandboxGone: () => false,
}));

import {
  getBoxActivity,
  parseSessionKey,
  recordBoxActivity,
  clearBoxResume,
  lastBoxResume,
  noteBoxResume,
  resetBoxActivityThrottleForTests,
  setBoxActivityRedisForTests,
} from "./box-activity";
import { tailBoxLog } from "./sandbox-ops.service";
import { discoverDevServers } from "./dev-server/status";

const WS = "6846e6a01b05af0948070582";
const USER = "6846e6a01b05af0948070999";
const KEY = `${WS}:${USER}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetBoxActivityThrottleForTests();
  setBoxActivityRedisForTests(null);
});

describe("parseSessionKey", () => {
  it("splits workspace and user", () => {
    expect(parseSessionKey(KEY)).toEqual({
      workspaceId: WS,
      userId: "6846e6a01b05af0948070999",
    });
    expect(parseSessionKey(`${WS}:publish`)?.userId).toBe("publish");
  });

  it("rejects malformed keys", () => {
    expect(parseSessionKey("nope")).toBeNull();
    expect(parseSessionKey(`${WS}:`)).toBeNull();
    expect(parseSessionKey("not-an-id:user")).toBeNull();
  });
});

describe("recordBoxActivity", () => {
  it("records the activity timestamp for the workspace and actor", async () => {
    await recordBoxActivity(KEY, "edit", { now: 1_000_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledWith(
      WS,
      USER,
      new Date(1_000_000),
      undefined,
    );
  });

  it("records a hold for long work", async () => {
    await recordBoxActivity(KEY, "agent-exec", { now: 0, holdMs: 600_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledWith(
      WS,
      USER,
      new Date(0),
      new Date(600_000),
    );
  });

  it("throttles a burst to one write", async () => {
    await recordBoxActivity(KEY, "agent-exec", { now: 0 });
    await recordBoxActivity(KEY, "agent-exec", { now: 5_000 });
    await recordBoxActivity(KEY, "edit", { now: 20_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(1);
    await recordBoxActivity(KEY, "edit", { now: 31_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(2);
  });

  it("writes inside the throttle when a longer hold arrives", async () => {
    await recordBoxActivity(KEY, "edit", { now: 0 });
    await recordBoxActivity(KEY, "agent-exec", { now: 1_000, holdMs: 120_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(2);
  });

  it("never throws when the database does", async () => {
    appsMetadataRepo.bumpWorktreeActivity.mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(recordBoxActivity(KEY, "edit")).resolves.toBeUndefined();
  });
});

describe("shared throttle (Redis)", () => {
  function fakeRedis() {
    const keys = new Map<string, number>();
    let clock = 0;
    const client = {
      set: vi.fn(
        async (
          key: string,
          _v: string,
          _px: string,
          ms: number,
          _nx: string,
        ) => {
          const until = keys.get(key) ?? -1;
          if (until > clock) return null;
          keys.set(key, clock + ms);
          return "OK";
        },
      ),
      tick: (ms: number) => {
        clock += ms;
      },
    };
    return client;
  }

  it("another instance's write inside 30 s skips ours", async () => {
    const redis = fakeRedis();
    setBoxActivityRedisForTests(redis as never);
    await recordBoxActivity(KEY, "read", { now: 0 });
    // A second process: its own in-process throttle is empty.
    resetBoxActivityThrottleForTests();
    await recordBoxActivity(KEY, "read", { now: 1_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(1);
    redis.tick(30_000);
    resetBoxActivityThrottleForTests();
    await recordBoxActivity(KEY, "read", { now: 31_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(2);
  });

  it("a hold always goes through the shared throttle", async () => {
    setBoxActivityRedisForTests(fakeRedis() as never);
    await recordBoxActivity(KEY, "read", { now: 0 });
    resetBoxActivityThrottleForTests();
    await recordBoxActivity(KEY, "agent-exec", { now: 1_000, holdMs: 120_000 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(2);
  });

  it("Redis down: the write still happens", async () => {
    setBoxActivityRedisForTests({
      set: vi.fn(async () => {
        throw new Error("down");
      }),
    } as never);
    await recordBoxActivity(KEY, "read", { now: 0 });
    expect(appsMetadataRepo.bumpWorktreeActivity).toHaveBeenCalledTimes(1);
  });
});

describe("resume caller", () => {
  it("keeps the FIRST connect after a pause, not the latest exec", async () => {
    const key = `${WS}:resume-a`;
    clearBoxResume(key); // the sweep paused it
    noteBoxResume(key, () => "routes/workflows/workspace.ts listFiles");
    noteBoxResume(key, () => "agent exec");
    noteBoxResume(key, () => "dev-server status");
    expect(await lastBoxResume(key)).toMatch(/workspace\.ts listFiles$/);
  });

  it("a new pause clears it, so the next resume is recorded", async () => {
    const key = `${WS}:resume-b`;
    noteBoxResume(key, () => "first");
    clearBoxResume(key);
    noteBoxResume(key, () => "second");
    expect(await lastBoxResume(key)).toMatch(/second$/);
  });

  it("captures the stack lazily: never for connects after the first", () => {
    const key = `${WS}:resume-c`;
    clearBoxResume(key);
    const caller = vi.fn(() => "x");
    noteBoxResume(key, caller);
    noteBoxResume(key, caller);
    noteBoxResume(key, caller);
    expect(caller).toHaveBeenCalledTimes(1);
  });
});

describe("getBoxActivity", () => {
  it("marks keys without a row as unknown", async () => {
    appsMetadataRepo.listWorktreesActivity.mockResolvedValueOnce([
      {
        workspaceId: WS,
        userId: USER,
        lastActivityAt: new Date(5),
        activeUntil: null,
      },
    ]);
    const out = await getBoxActivity([KEY, `${WS}:someone-else`]);
    expect(appsMetadataRepo.listWorktreesActivity).toHaveBeenCalledWith([
      { workspaceId: WS, actorId: USER },
      { workspaceId: WS, actorId: "someone-else" },
    ]);
    expect(out.get(KEY)).toEqual({
      known: true,
      lastActivityAt: new Date(5),
      activeUntil: null,
    });
    expect(out.get(`${WS}:someone-else`)?.known).toBe(false);
  });
});

describe("polls never wake a paused box", () => {
  it("the boot-log tail answers empty without an exec", async () => {
    provider.isRunning.mockResolvedValueOnce(false);
    expect(await tailBoxLog({ sessionKey: KEY }, "/tmp/x.log", 0)).toEqual({
      size: 0,
      chunk: "",
    });
    expect(provider.exec).not.toHaveBeenCalled();
    expect(appsMetadataRepo.bumpWorktreeActivity).not.toHaveBeenCalled();
  });

  it("dev-server discovery answers empty without an exec", async () => {
    provider.isRunning.mockResolvedValueOnce(false);
    expect(await discoverDevServers({ sessionKey: KEY })).toEqual([]);
    expect(provider.exec).not.toHaveBeenCalled();
  });

  it("a running box is still read, and the read is not activity", async () => {
    provider.isRunning.mockResolvedValueOnce(true);
    const tail = await tailBoxLog({ sessionKey: KEY }, "/tmp/x.log", 0);
    expect(tail).toEqual({ size: 12, chunk: "hello" });
    expect(provider.exec).toHaveBeenCalledTimes(1);
    expect(appsMetadataRepo.bumpWorktreeActivity).not.toHaveBeenCalled();
  });
});
