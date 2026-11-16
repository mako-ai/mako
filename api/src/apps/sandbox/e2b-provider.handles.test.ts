/**
 * The E2B provider holds one connected handle per session.
 *
 * Bench G1 measured the old pattern: `Sandbox.connect` before every call and
 * `setTimeout` before every exec, so one connector chunk made 8 provider calls
 * and 20 round trips. These specs pin the new one with a mocked SDK (no real
 * box is created): connect once per session, `setTimeout` only when the
 * remaining lifetime drifts from what a call needs, one request for several
 * files, and the old behaviour back whenever a held handle turns out stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SandboxNotFoundError";
    }
  }
  const makeBox = (sandboxId: string) => ({
    sandboxId,
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    setTimeout: vi.fn(async () => undefined),
    getHost: (port: number) => `${port}-${sandboxId}.e2b.app`,
  });
  return {
    SandboxNotFoundError,
    makeBox,
    boxes: new Map<string, ReturnType<typeof makeBox>>(),
    Sandbox: {
      connect: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      kill: vi.fn(async () => true),
    },
  };
});

vi.mock("e2b", () => ({
  Sandbox: e2b.Sandbox,
  SandboxNotFoundError: e2b.SandboxNotFoundError,
}));

import {
  e2bSandboxProvider as provider,
  heldSandboxCountForTests,
  resetHeldSandboxesForTests,
} from "./e2b-provider";

const ctx = { sessionKey: "connector-sync:ws1" };

function writeFiles(
  ...args: Parameters<NonNullable<typeof provider.writeFiles>>
): Promise<void> {
  if (!provider.writeFiles) throw new Error("E2B must implement writeFiles");
  return provider.writeFiles(...args);
}

function destroySession(sessionKey: string): Promise<void> {
  if (!provider.destroySession) throw new Error("no destroySession");
  return provider.destroySession(sessionKey);
}
const MINUTE = 60_000;

/** The one box the session lists, connects to and runs on. */
function oneBox(id = "sbx-1") {
  const box = e2b.makeBox(id);
  e2b.boxes.set(id, box);
  box.commands.run.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
  box.files.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
  box.files.write.mockResolvedValue([]);
  return box;
}

beforeEach(() => {
  process.env.E2B_API_KEY = "test-key";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  resetHeldSandboxesForTests();
  e2b.boxes.clear();
  e2b.Sandbox.connect.mockReset();
  e2b.Sandbox.list.mockReset();
  e2b.Sandbox.create.mockReset();
  e2b.Sandbox.connect.mockImplementation(async (id: string) => {
    const box = e2b.boxes.get(id);
    if (!box) throw new e2b.SandboxNotFoundError(`Sandbox ${id} not found`);
    return box;
  });
  e2b.Sandbox.list.mockImplementation(() => ({
    hasNext: true,
    nextItems: async () =>
      [...e2b.boxes.keys()].map(sandboxId => ({
        sandboxId,
        startedAt: "2026-11-16T11:00:00Z",
      })),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("held E2B handles", () => {
  it("connects once and sets the lifetime once across many calls", async () => {
    const box = oneBox();

    for (let i = 0; i < 5; i++) {
      await writeFiles(ctx, [
        { path: "/tmp/run/config.json", bytes: new Uint8Array([1]) },
      ]);
      const result = await provider.exec(ctx, "true", { timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      await provider.readFile(ctx, "/tmp/run/out.jsonl");
    }

    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(1);
    expect(box.setTimeout).toHaveBeenCalledTimes(1);
    expect(box.setTimeout).toHaveBeenCalledWith(10 * MINUTE);
    // 15 calls, 15 requests: one write, one command, one read per "chunk".
    expect(box.files.write).toHaveBeenCalledTimes(5);
    expect(box.commands.run).toHaveBeenCalledTimes(5);
    expect(box.files.read).toHaveBeenCalledTimes(5);
    expect(heldSandboxCountForTests()).toBe(1);
  });

  it("writes several files in one request", async () => {
    const box = oneBox();
    await writeFiles(ctx, [
      { path: "/tmp/a.json", bytes: new TextEncoder().encode("a") },
      { path: "/tmp/b.json", bytes: new TextEncoder().encode("bb") },
    ]);
    expect(box.files.write).toHaveBeenCalledTimes(1);
    const [entries, options] = box.files.write.mock.calls[0];
    expect(entries.map((e: { path: string }) => e.path)).toEqual([
      "/tmp/a.json",
      "/tmp/b.json",
    ]);
    expect(
      entries.map((e: { data: ArrayBuffer }) => e.data.byteLength),
    ).toEqual([1, 2]);
    expect(options).toEqual({ user: "user" });
  });

  it("refreshes the lifetime only once it has drifted by more than a minute", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    vi.setSystemTime(Date.now() + 59_000);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(box.setTimeout).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2_000);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(box.setTimeout).toHaveBeenCalledTimes(2);

    // A command that may run 10 minutes needs the box for 10 minutes at
    // least, whatever the slack says: it is granted at once.
    await provider.exec(ctx, "long", { timeoutMs: 10 * MINUTE });
    expect(box.setTimeout).toHaveBeenCalledTimes(3);
    expect(box.setTimeout).toHaveBeenLastCalledWith(11 * MINUTE);
    // A chunk loop of such commands refreshes about once a minute.
    for (let s = 0; s < 120; s++) {
      vi.setSystemTime(Date.now() + 1_000);
      await provider.exec(ctx, "chunk", { timeoutMs: 10 * MINUTE });
    }
    expect(box.setTimeout.mock.calls.length - 3).toBeLessThanOrEqual(3);
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(1);
  });

  it("never lets a routine exec clobber a keepAlive hold", async () => {
    const box = oneBox();
    await provider.keepAlive(ctx, 30 * MINUTE);
    expect(box.setTimeout).toHaveBeenLastCalledWith(30 * MINUTE);
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    // While the hold lasts, every exec re-applies it, as before: another API
    // instance may have shortened the box's timeout behind our cache.
    expect(box.setTimeout).toHaveBeenCalledTimes(2);
    expect(box.setTimeout).toHaveBeenLastCalledWith(25 * MINUTE);
    vi.setSystemTime(Date.now() + 25 * MINUTE);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(box.setTimeout).toHaveBeenLastCalledWith(10 * MINUTE);
  });

  it("trusts its own cached deadline for one minute at most", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    // Another instance may have changed the timeout since: after a minute
    // the lifetime is set again even though the cache still looks right.
    vi.setSystemTime(Date.now() + 61_000);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(box.setTimeout).toHaveBeenCalledTimes(2);
  });

  it("reconnects once the box may have paused, as the old per-call connect did", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    // Past the known pause time: the handle is not trusted.
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    await provider.readFile(ctx, "/tmp/x");
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
    expect(box.files.read).toHaveBeenCalledTimes(1);
  });

  it("trusts a handle with no known deadline for 30 seconds only", async () => {
    oneBox();
    await provider.readFile(ctx, "/tmp/x");
    await provider.readFile(ctx, "/tmp/x");
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31_000);
    await provider.readFile(ctx, "/tmp/x");
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
  });

  it("retries once on a fresh connect when a held handle's box is gone", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.commands.run.mockRejectedValueOnce(
      new e2b.SandboxNotFoundError("Sandbox is probably not running anymore"),
    );
    const result = await provider.exec(ctx, "echo hi", { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
    expect(box.commands.run).toHaveBeenCalledTimes(3);
  });

  it("does not retry a gone box it has only just connected to", async () => {
    const box = oneBox();
    box.commands.run.mockRejectedValue(
      new e2b.SandboxNotFoundError("Sandbox is probably not running anymore"),
    );
    await expect(
      provider.exec(ctx, "true", { timeoutMs: 30_000 }),
    ).rejects.toThrow(/not running/);
    expect(box.commands.run).toHaveBeenCalledTimes(1);
    // The session is forgotten, so hasSession asks E2B again.
    expect(heldSandboxCountForTests()).toBe(0);
  });

  it("returns a failed command's exit code without retrying it", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.commands.run.mockRejectedValueOnce(
      Object.assign(new Error("exit 3"), { exitCode: 3, stderr: "bad" }),
    );
    const result = await provider.exec(ctx, "false", { timeoutMs: 30_000 });
    expect(result).toMatchObject({ exitCode: 3, stderr: "bad" });
    expect(box.commands.run).toHaveBeenCalledTimes(2);
  });

  it("drops the handle when the session is destroyed", async () => {
    oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(heldSandboxCountForTests()).toBe(1);
    await destroySession(ctx.sessionKey);
    expect(heldSandboxCountForTests()).toBe(0);
  });

  it("keeps one handle per session key", async () => {
    oneBox("sbx-a");
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    e2b.boxes.clear();
    oneBox("sbx-b");
    await provider.exec({ sessionKey: "worktree-123" }, "true", {
      timeoutMs: 30_000,
    });
    expect(heldSandboxCountForTests()).toBe(2);
    expect(await provider.publicUrlForPort(ctx, 5173)).toBe(
      "https://5173-sbx-a.e2b.app",
    );
  });
});
