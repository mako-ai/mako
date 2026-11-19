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
  const makeBox = (sandboxId: string) => ({
    sandboxId,
    commands: { run: vi.fn() },
    pty: { create: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    setTimeout: vi.fn(async () => undefined),
    getHost: (port: number) => `${port}-${sandboxId}.e2b.app`,
  });
  return {
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

// The SDK's REAL error classes; only `Sandbox` is replaced.
vi.mock("e2b", async importOriginal => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: e2b.Sandbox,
}));

import {
  FileNotFoundError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
} from "e2b";

import {
  e2bSandboxProvider as provider,
  heldSandboxCountForTests,
  isBoxConnectionError,
  isSandboxGone,
  EXEC_ID_ENV,
  killByExecIdScript,
  neverReachedBox,
  noteSessionPaused,
  resetHeldSandboxesForTests,
} from "./e2b-provider";

/** The 4 shapes e2b 2.55 gives a dead, paused or unreachable box. */
const proxyNotFound = () =>
  new SandboxNotRunningError(
    "Sandbox sbx-1 was not found: The sandbox was killed or reached its timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
  );
const killedInFlight = () =>
  new SandboxNotRunningError(
    "fetch failed: The sandbox was killed or reached its end of life while the request was in flight.",
    { cause: new Error("fetch failed") },
  );
const unreachable = () =>
  new SandboxUnreachableError(
    "stream ended: The sandbox could not be reached and its state is unknown — it may have been killed or reached its timeout, or the connection to it was lost. Check the sandbox state with 'Sandbox.getInfo()'.",
  );
const apiNotFound = () => new SandboxNotFoundError("Sandbox sbx-1 not found");

const ok = { exitCode: 0, stdout: "ok", stderr: "" };
/** commands.run with background: true resolves to a handle once started. */
const started = (wait: () => Promise<unknown> = async () => ok) => ({
  pid: 1,
  wait,
});

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
/** E2B's idle backstop in e2b-provider.ts (IDLE_TIMEOUT_MS, 15 min since PR 1283). */
const IDLE = 15 * MINUTE;

/** The one box the session lists, connects to and runs on. */
function oneBox(id = "sbx-1") {
  const box = e2b.makeBox(id);
  e2b.boxes.set(id, box);
  box.commands.run.mockImplementation(async () => started());
  box.pty.create.mockResolvedValue({
    pid: 7,
    wait: () => new Promise(() => undefined),
    kill: async () => true,
  });
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
    if (!box) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
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
    expect(box.setTimeout).toHaveBeenCalledWith(IDLE);
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
    // least: 15 minutes are left, so no call is needed.
    await provider.exec(ctx, "long", { timeoutMs: 10 * MINUTE });
    expect(box.setTimeout).toHaveBeenCalledTimes(2);
    // Minutes later the cached deadline is stale, so the lifetime is set
    // again before the command runs.
    vi.setSystemTime(Date.now() + 5.5 * MINUTE);
    await provider.exec(ctx, "long", { timeoutMs: 10 * MINUTE });
    expect(box.setTimeout).toHaveBeenCalledTimes(3);
    expect(box.setTimeout).toHaveBeenLastCalledWith(IDLE);
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
    expect(box.setTimeout).toHaveBeenLastCalledWith(IDLE);
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
    vi.setSystemTime(Date.now() + IDLE + MINUTE);
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

  it("recognises every real e2b shape of a dead or unreachable box", () => {
    for (const error of [proxyNotFound(), killedInFlight(), apiNotFound()]) {
      expect(isSandboxGone(error), error.message).toBe(true);
    }
    // Unreachable: state unknown, so not "gone", but still a box error.
    expect(isSandboxGone(unreachable())).toBe(false);
    for (const error of [
      proxyNotFound(),
      killedInFlight(),
      unreachable(),
      apiNotFound(),
    ]) {
      expect(isBoxConnectionError(error), error.message).toBe(true);
    }
    // Only a box that never received the request is safe to resend to.
    expect(neverReachedBox(proxyNotFound())).toBe(true);
    expect(neverReachedBox(apiNotFound())).toBe(true);
    expect(neverReachedBox(killedInFlight())).toBe(false);
    expect(neverReachedBox(unreachable())).toBe(false);
  });

  it("retries a command the box never accepted, once, on a fresh connect", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.commands.run.mockRejectedValueOnce(proxyNotFound());
    const result = await provider.exec(ctx, "echo hi", { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
    expect(box.commands.run).toHaveBeenCalledTimes(3);
  });

  it("never sends git commit twice when the box dies mid-command", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    for (const failure of [killedInFlight, unreachable, proxyNotFound]) {
      box.commands.run.mockClear();
      e2b.Sandbox.connect.mockClear();
      // Warm the handle again, then accept the commit and lose the box.
      await provider.exec(ctx, "true", { timeoutMs: 30_000 });
      box.commands.run.mockImplementationOnce(async () =>
        started(async () => {
          throw failure();
        }),
      );
      await expect(
        provider.exec(ctx, "git commit -m x", { timeoutMs: 30_000 }),
      ).rejects.toThrow();
      const commits = box.commands.run.mock.calls.filter(([c]) =>
        String(c).startsWith("git commit"),
      );
      expect(commits, failure.name).toHaveLength(1);
      // And the dead handle is not reused: the next call connects.
      e2b.Sandbox.connect.mockClear();
      await provider.exec(ctx, "true", { timeoutMs: 30_000 });
      expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(1);
    }
  });

  it("does not resend a command whose start failed with the box state unknown", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.commands.run.mockRejectedValueOnce(unreachable());
    await expect(
      provider.exec(ctx, "git commit -m x", { timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(SandboxUnreachableError);
    expect(box.commands.run).toHaveBeenCalledTimes(2);
    expect(heldSandboxCountForTests()).toBe(0);
  });

  it("retries a file read on any box error, and drops the stale handle", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    for (const failure of [proxyNotFound, killedInFlight, unreachable]) {
      box.files.read.mockRejectedValueOnce(failure());
      const bytes = await provider.readFile(ctx, "/tmp/x");
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(4);
  });

  it("drops a held handle on any other error too, without retrying", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.files.read.mockRejectedValueOnce(new Error("something odd"));
    await expect(provider.readFile(ctx, "/tmp/x")).rejects.toThrow(/odd/);
    expect(box.files.read).toHaveBeenCalledTimes(1);
    await provider.readFile(ctx, "/tmp/x");
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps the handle when a file is simply missing", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.files.read.mockRejectedValueOnce(
      new FileNotFoundError("/tmp/x was not found"),
    );
    await expect(provider.readFile(ctx, "/tmp/x")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
    expect(box.files.read).toHaveBeenCalledTimes(1);
    expect(heldSandboxCountForTests()).toBe(1);
    await provider.readFile(ctx, "/tmp/x");
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(1);
  });

  it("does not retry a gone box it has only just connected to", async () => {
    const box = oneBox();
    box.commands.run.mockRejectedValue(proxyNotFound());
    await expect(
      provider.exec(ctx, "true", { timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(SandboxNotRunningError);
    expect(box.commands.run).toHaveBeenCalledTimes(1);
    // The session is forgotten, so hasSession asks E2B again.
    expect(heldSandboxCountForTests()).toBe(0);
  });

  it("returns a failed command's exit code without retrying it", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.commands.run.mockImplementationOnce(async () =>
      started(async () => {
        throw Object.assign(new Error("exit 3"), {
          exitCode: 3,
          stderr: "bad",
        });
      }),
    );
    const result = await provider.exec(ctx, "false", { timeoutMs: 30_000 });
    expect(result).toMatchObject({ exitCode: 3, stderr: "bad" });
    expect(box.commands.run).toHaveBeenCalledTimes(2);
    expect(heldSandboxCountForTests()).toBe(1);
  });

  it("kills every process a timed-out command started, by its exec tag", async () => {
    // 18 Nov 2026: builds that outlived their timeout held the publish box at
    // 2,018 of 2,079 MB for 34 min. A deadline must end the processes too.
    const box = oneBox();
    const kill = vi.fn(async () => true);
    box.commands.run.mockImplementationOnce(async () => ({
      pid: 4242,
      kill,
      wait: async () => {
        throw new TimeoutError("[deadline_exceeded] the operation timed out");
      },
    }));
    const result = await provider.exec(ctx, "npm run build", {
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    // The command carried a unique tag; the sweep, as root, aims at it.
    expect(box.commands.run).toHaveBeenCalledTimes(2);
    const execId = box.commands.run.mock.calls[0][1].envs[EXEC_ID_ENV];
    expect(execId).toMatch(/^[0-9a-f-]{36}$/);
    const [script, options] = box.commands.run.mock.calls[1];
    expect(script).toBe(killByExecIdScript(execId));
    expect(options).toMatchObject({ user: "root" });
    // envd's own kill of the top pid backs the walk up.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("still kills the top pid when the sweep cannot start", async () => {
    const box = oneBox();
    const kill = vi.fn(async () => true);
    box.commands.run
      .mockImplementationOnce(async () => ({
        pid: 7,
        kill,
        wait: async () => {
          throw new TimeoutError("[deadline_exceeded] the operation timed out");
        },
      }))
      .mockImplementationOnce(async () => {
        throw new TimeoutError("[deadline_exceeded] could not start");
      });
    const result = await provider.exec(ctx, "sleep 999", { timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("tags each exec uniquely, so a sweep never touches another command", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    const [a, b] = box.commands.run.mock.calls.map(c => c[1].envs[EXEC_ID_ENV]);
    expect(a).not.toBe(b);
  });

  it("sweeps by environment, stopping before killing, and refuses odd ids", () => {
    // envd kills only the top bash on a deadline; its children are reparented
    // to init and share envd's process group, so neither a tree walk nor a
    // group kill reaches them. Their inherited environment does.
    const script = killByExecIdScript("9b2c4d1e-aaaa");
    expect(script).toContain(`grep -qzx '${EXEC_ID_ENV}=9b2c4d1e-aaaa'`);
    expect(script).toContain("for s in STOP KILL");
    expect(() => killByExecIdScript("x'; rm -rf /")).toThrow();
  });

  it("opens a terminal through the same path: a stale handle is replaced", async () => {
    const box = oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    box.pty.create.mockRejectedValueOnce(proxyNotFound());
    const terminal = await provider.openTerminal(ctx, {
      cwd: "",
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    expect(terminal.pid).toBe(7);
    expect(box.pty.create).toHaveBeenCalledTimes(2);
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);

    // A shell that may have started is not created twice.
    box.pty.create.mockRejectedValueOnce(unreachable());
    await expect(
      provider.openTerminal(ctx, {
        cwd: "",
        cols: 80,
        rows: 24,
        onData: () => undefined,
      }),
    ).rejects.toBeInstanceOf(SandboxUnreachableError);
    expect(box.pty.create).toHaveBeenCalledTimes(3);
  });

  it("forgets the handle when an idle sweep pauses the box", async () => {
    oneBox();
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    noteSessionPaused(ctx.sessionKey);
    expect(heldSandboxCountForTests()).toBe(0);
    await provider.exec(ctx, "true", { timeoutMs: 30_000 });
    expect(e2b.Sandbox.connect).toHaveBeenCalledTimes(2);
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
