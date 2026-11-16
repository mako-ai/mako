/**
 * Real use is recorded; polls are not; a paused box is not woken by a poll.
 * No E2B and no database: both are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  updateOne: vi.fn(async () => ({ acknowledged: true })),
  find: vi.fn(),
}));
vi.mock("../database/workspace-schema", () => ({ AppWorktree: db }));

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
  resetBoxActivityThrottleForTests,
} from "./box-activity";
import { tailBoxLog } from "./sandbox-ops.service";
import { discoverDevServers } from "./dev-server/status";

const WS = "6846e6a01b05af0948070582";
const KEY = `${WS}:6846e6a01b05af0948070999`;

beforeEach(() => {
  vi.clearAllMocks();
  resetBoxActivityThrottleForTests();
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
  it("moves lastActivityAt forward without touching updatedAt", async () => {
    await recordBoxActivity(KEY, "edit", { now: 1_000_000 });
    expect(db.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "6846e6a01b05af0948070999" }),
      { $max: { lastActivityAt: new Date(1_000_000) } },
      { timestamps: false },
    );
  });

  it("records a hold for long work", async () => {
    await recordBoxActivity(KEY, "agent-exec", { now: 0, holdMs: 600_000 });
    expect(db.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      {
        $max: {
          lastActivityAt: new Date(0),
          activeUntil: new Date(600_000),
        },
      },
      { timestamps: false },
    );
  });

  it("throttles a burst to one write", async () => {
    await recordBoxActivity(KEY, "agent-exec", { now: 0 });
    await recordBoxActivity(KEY, "agent-exec", { now: 5_000 });
    await recordBoxActivity(KEY, "edit", { now: 20_000 });
    expect(db.updateOne).toHaveBeenCalledTimes(1);
    await recordBoxActivity(KEY, "edit", { now: 31_000 });
    expect(db.updateOne).toHaveBeenCalledTimes(2);
  });

  it("writes inside the throttle when a longer hold arrives", async () => {
    await recordBoxActivity(KEY, "edit", { now: 0 });
    await recordBoxActivity(KEY, "agent-exec", { now: 1_000, holdMs: 120_000 });
    expect(db.updateOne).toHaveBeenCalledTimes(2);
  });

  it("never throws when the database does", async () => {
    db.updateOne.mockRejectedValueOnce(new Error("down"));
    await expect(recordBoxActivity(KEY, "edit")).resolves.toBeUndefined();
  });
});

describe("getBoxActivity", () => {
  it("marks keys without a row as unknown", async () => {
    db.find.mockReturnValue({
      lean: async () => [
        {
          workspaceId: { toString: () => WS },
          userId: "6846e6a01b05af0948070999",
          lastActivityAt: new Date(5),
        },
      ],
    });
    const out = await getBoxActivity([KEY, `${WS}:someone-else`]);
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
    expect(db.updateOne).not.toHaveBeenCalled();
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
    expect(db.updateOne).not.toHaveBeenCalled();
  });
});
