/**
 * The resume loop, end to end through the real E2B provider: a paused
 * session, an open workbench polling for 10 minutes, and 0 resumes.
 *
 * Only the e2b SDK is a mock. It answers list queries honestly (a paused box
 * is not "running") and counts every call that would resume a box:
 * Sandbox.connect, and any command or file call on a connected handle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "6846e6a01b05af0948070582";
const USER = "2ej8m72pihz87dy";
const KEY = `${WS}:${USER}`;
const APP_ID = "6846e6a01b05af0948070aaa";

const sdk = vi.hoisted(() => ({
  state: "paused" as "paused" | "running",
  failRunningList: false,
  list: vi.fn(),
  connect: vi.fn(),
  commands: vi.fn(),
  create: vi.fn(),
}));

vi.mock("e2b", () => {
  class ConnectionConfig {
    getHost(id: string, port: number, domain?: string) {
      return `${port}-${id}.${domain ?? "e2b.app"}`;
    }
  }
  class SandboxNotFoundError extends Error {}
  const Sandbox = {
    list: (opts: { query?: { state?: string[] } }) => {
      sdk.list(opts);
      const wanted = opts.query?.state;
      if (sdk.failRunningList && wanted?.includes("running")) {
        throw new Error("E2B 429");
      }
      const items =
        !wanted || wanted.includes(sdk.state)
          ? [
              {
                sandboxId: "sbx-paused",
                metadata: { makoAppsSessionKey: KEY },
                state: sdk.state,
                startedAt: new Date(0),
                cpuCount: 2,
                memoryMB: 2048,
              },
            ]
          : [];
      let done = false;
      return {
        get hasNext() {
          return !done;
        },
        nextItems: async () => {
          done = true;
          return items;
        },
      };
    },
    connect: async (id: string) => {
      sdk.connect(id);
      sdk.state = "running"; // what E2B does: connect resumes
      return {
        sandboxId: id,
        getHost: (port: number) => `${port}-${id}.e2b.app`,
        setTimeout: async () => undefined,
        commands: {
          run: async () => {
            sdk.commands();
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        files: { read: async () => new Uint8Array() },
      };
    },
    create: sdk.create,
    kill: vi.fn(),
    pause: vi.fn(),
  };
  return { Sandbox, ConnectionConfig, SandboxNotFoundError };
});

// The box last reported a dev server for this app without a resolved url:
// the exact snapshot that made the 15 s status poll call the old peek.
vi.mock("./box-state.service", () => ({
  getBoxState: vi.fn(async () => ({
    branch: "main",
    head: null,
    ahead: 0,
    changes: [],
    devServers: [{ slug: APP_ID, port: 5173 }],
    sandboxId: "sbx-paused",
    status: "online",
    terminals: [],
    updatedAt: 0,
  })),
  probeReachable: vi.fn(async () => true),
  forgetBoxState: vi.fn(),
  markBoxOffline: vi.fn(),
  patchBoxState: vi.fn(),
  hasGitState: () => false,
}));
vi.mock("./worktree.service", async importOriginal => ({
  ...(await importOriginal<typeof import("./worktree.service")>()),
  ensureWorkspaceWorktree: vi.fn(async () => ({
    doc: { workspaceId: WS, userId: USER, branch: "main" },
    appRoot: "",
  })),
}));
vi.mock("../workflows/on-push", () => ({
  removeKey: vi.fn(async () => undefined),
  setKey: vi.fn(async () => undefined),
}));
vi.mock("./box-agent", () => ({
  ensureBoxAgent: vi.fn(async () => undefined),
  forgetBoxAgent: vi.fn(),
}));

import { getBoxState } from "./box-state.service";
import { devServerStatus, discoverDevServers } from "./dev-server/status";
import { tailBoxLog } from "./sandbox-ops.service";
import { e2bSandboxProvider } from "./sandbox/e2b-provider";
import type { WorktreeHandle } from "./worktree.service";
import { readSandboxRun } from "../workflows/sandbox";

const handle = {
  doc: { workspaceId: WS, userId: USER, branch: "main" },
  project: { _id: { toString: () => APP_ID }, workspaceId: WS },
  appRoot: "apps/sales",
} as unknown as WorktreeHandle;

beforeEach(() => {
  vi.clearAllMocks();
  sdk.state = "paused";
  process.env.E2B_API_KEY = "test-key";
  delete process.env.APPS_SANDBOX_PROVIDER;
});

describe("a paused box and an open workbench", () => {
  it("10 minutes of workbench polls resume 0 boxes", async () => {
    let clock = Date.parse("2026-11-16T18:00:00Z");
    vi.useFakeTimers({ now: clock });
    try {
      // 1.5 s ticks for 10 minutes; each poll fires on its own period.
      for (let t = 0; t <= 10 * 60_000; t += 1_500) {
        if (t % 15_000 === 0) await devServerStatus(handle); // status poll
        if (t % 30_000 === 0) await discoverDevServers({ sessionKey: KEY }); // dots
        await tailBoxLog({ sessionKey: KEY }, "/tmp/mako-dev.log", 0); // boot log
        if (t % 15_000 === 0) {
          await e2bSandboxProvider.peekPublicUrlForPort(
            { sessionKey: KEY },
            5173,
          );
        }
        clock += 1_500;
        vi.setSystemTime(clock);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.commands).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.state).toBe("paused");
    // It did ask: the snapshot path ran, and E2B was consulted.
    expect(vi.mocked(getBoxState)).toHaveBeenCalled();
    expect(sdk.list).toHaveBeenCalled();
  });

  it("the run view's 3 s poll of a run in a paused box answers PAUSED and resumes nothing", async () => {
    for (let i = 0; i < 20; i += 1) {
      const run = await readSandboxRun(
        WS,
        USER,
        "sandbox-00000000-0000-4000-8000-000000000000",
      );
      // Not RUNNING or QUEUED, so WorkflowView stops polling.
      expect(run).toMatchObject({ status: "PAUSED" });
    }
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.commands).not.toHaveBeenCalled();
  });

  it("a failed E2B lookup never turns a live run into PAUSED", async () => {
    sdk.state = "running";
    sdk.failRunningList = true;
    try {
      const run = await readSandboxRun(
        WS,
        USER,
        "sandbox-00000000-0000-4000-8000-000000000001",
      );
      // Still active, so the run view keeps polling.
      expect(run).toMatchObject({ status: "RUNNING" });
    } finally {
      sdk.failRunningList = false;
    }
  });

  it("runState is fresh on request and says unknown on a failed lookup", async () => {
    sdk.state = "paused";
    expect(await e2bSandboxProvider.runState?.({ sessionKey: KEY })).toBe(
      "not-running",
    );
    sdk.state = "running";
    // The cached "not running" would still answer for 10 s; fresh asks E2B.
    expect(
      await e2bSandboxProvider.runState?.({ sessionKey: KEY }, { fresh: true }),
    ).toBe("running");
    sdk.failRunningList = true;
    try {
      expect(
        await e2bSandboxProvider.runState?.(
          { sessionKey: KEY },
          { fresh: true },
        ),
      ).toBe("unknown");
    } finally {
      sdk.failRunningList = false;
    }
  });

  it("a paused box's status reads as not serving", async () => {
    expect(await devServerStatus(handle)).toEqual({ serving: false });
  });

  it("a running box still gets its preview url, without a connect", async () => {
    sdk.state = "running";
    expect(
      await e2bSandboxProvider.peekPublicUrlForPort({ sessionKey: KEY }, 5173),
    ).toBe("https://5173-sbx-paused.e2b.app");
    expect(sdk.connect).not.toHaveBeenCalled();
  });
});
