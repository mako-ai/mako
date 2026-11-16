/**
 * The app-box idle policy, offline: no E2B box is created, paused or killed.
 * Every E2B and in-box call is a mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  boxStatus: vi.fn(),
  boxCommitAll: vi.fn(),
  boxExec: vi.fn(),
  configureBoxRemote: vi.fn(async () => undefined),
}));
vi.mock("./box", () => ({
  ...box,
  boxRoot: () => "/home/user/app",
  sh: (s: string) => `'${s}'`,
}));
vi.mock("./worktree/box-session", () => ({
  resolveActorIdentity: vi.fn(async () => ({ name: "ana", email: "ana@x.io" })),
  forgetBoxCaches: vi.fn(),
}));
vi.mock("./worktree/files", () => ({
  withBoxPushLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));
vi.mock("./box-state.service", () => ({ markBoxOffline: vi.fn() }));
vi.mock("./sandbox/e2b-provider", () => ({ noteSessionPaused: vi.fn() }));
vi.mock("./terminal/sessions", () => ({ forgetTerminalCaches: vi.fn() }));

import type { BoxActivity } from "./box-activity";
import {
  boxIdleConfig,
  idleDeadline,
  lastUseOf,
  reapPausedBoxes,
  settleBoxForDelete,
  sweepIdleBoxes,
  usageByWorkspace,
  type ReapDeps,
  type SweepDeps,
} from "./box-idle.service";
import type { AppBoxInfo } from "./sandbox/e2b-fleet";

const WS = "6846e6a01b05af0948070582";
const USER = "6846e6a01b05af0948070999";
const KEY = `${WS}:${USER}`;
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const config = boxIdleConfig({});

function appBox(
  overrides: Partial<AppBoxInfo> & { startedMinutesAgo?: number } = {},
): AppBoxInfo {
  const { startedMinutesAgo = 60, ...rest } = overrides;
  return {
    sandboxId: "sbx-1",
    sessionKey: KEY,
    state: "running",
    startedAt: new Date(NOW - startedMinutesAgo * MIN),
    cpuCount: 2,
    memoryMB: 2048,
    ...rest,
  };
}

function activity(
  lastMinutesAgo: number | null,
  extra: Partial<BoxActivity> = {},
): BoxActivity {
  return {
    known: true,
    lastActivityAt:
      lastMinutesAgo === null ? null : new Date(NOW - lastMinutesAgo * MIN),
    activeUntil: null,
    ...extra,
  };
}

function sweepDeps(
  boxes: AppBoxInfo[],
  acts: Record<string, BoxActivity>,
  overrides: Partial<SweepDeps> = {},
) {
  const calls: string[] = [];
  const deps: SweepDeps = {
    listBoxes: async () => boxes,
    getActivity: async keys =>
      new Map(
        keys.map(k => [
          k,
          acts[k] ?? { known: false, lastActivityAt: null, activeUntil: null },
        ]),
      ),
    hasRunningWork: vi.fn(async () => false),
    announceAsleep: vi.fn(async (key: string) => {
      calls.push(`asleep:${key}`);
    }),
    pause: vi.fn(async (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

describe("config", () => {
  it("defaults to 10 idle minutes, 14 paused days, 10 deletions per run", () => {
    expect(config).toEqual({
      enabled: true,
      idleMs: 10 * MIN,
      pausedRetentionMs: 14 * DAY,
      reapBatch: 10,
    });
  });

  it("reads the knobs and the off switch", () => {
    const c = boxIdleConfig({
      APPS_BOX_IDLE_MINUTES: "5",
      APPS_BOX_PAUSED_RETENTION_DAYS: "3",
      APPS_BOX_REAP_BATCH: "2",
      APPS_BOX_IDLE_SWEEP: "off",
    });
    expect(c).toEqual({
      enabled: false,
      idleMs: 5 * MIN,
      pausedRetentionMs: 3 * DAY,
      reapBatch: 2,
    });
  });

  it("ignores junk values", () => {
    expect(boxIdleConfig({ APPS_BOX_IDLE_MINUTES: "-1" }).idleMs).toBe(
      10 * MIN,
    );
  });
});

describe("idle detection", () => {
  it("counts from the last real activity", () => {
    const boxes = [appBox({ startedMinutesAgo: 50 })];
    expect(lastUseOf(boxes, activity(3))).toBe(NOW - 3 * MIN);
    expect(idleDeadline(boxes, activity(3), 10 * MIN)).toBe(NOW + 7 * MIN);
  });

  it("falls back to the box start when there is no record", () => {
    const boxes = [appBox({ startedMinutesAgo: 4 })];
    expect(lastUseOf(boxes, activity(null))).toBe(NOW - 4 * MIN);
    expect(lastUseOf(boxes, undefined)).toBe(NOW - 4 * MIN);
  });

  it("a box resumed after the last activity counts from its start", () => {
    const boxes = [appBox({ startedMinutesAgo: 2 })];
    expect(lastUseOf(boxes, activity(30))).toBe(NOW - 2 * MIN);
  });

  it("a hold for a long command outlasts the idle window", () => {
    const hold = activity(20, { activeUntil: new Date(NOW + 5 * MIN) });
    expect(idleDeadline([appBox()], hold, 10 * MIN)).toBe(NOW + 5 * MIN);
  });
});

describe("sweepIdleBoxes: pause after idle", () => {
  it("pauses a box idle past the window, telling tabs first", async () => {
    const { deps, calls } = sweepDeps([appBox()], { [KEY]: activity(11) });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toEqual([
      { sessionKey: KEY, sandboxId: "sbx-1", idleMinutes: 11 },
    ]);
    // Offline before pause, or the terminal reconnects and resumes the box.
    expect(calls).toEqual([`asleep:${KEY}`, "pause:sbx-1"]);
  });

  it("pauses an open-but-idle tab's box even though it is being polled", async () => {
    // Polls never write activity, so 45 minutes of polling is 45 idle minutes.
    const { deps } = sweepDeps([appBox({ startedMinutesAgo: 57 })], {
      [KEY]: activity(45),
    });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toHaveLength(1);
  });

  it("pauses every duplicate box of an idle session", async () => {
    const { deps } = sweepDeps([appBox(), appBox({ sandboxId: "sbx-2" })], {
      [KEY]: activity(30),
    });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow.map(p => p.sandboxId)).toEqual(["sbx-1", "sbx-2"]);
  });

  it("honours a shorter configured window", async () => {
    const { deps } = sweepDeps([appBox()], { [KEY]: activity(6) });
    const result = await sweepIdleBoxes(
      deps,
      boxIdleConfig({ APPS_BOX_IDLE_MINUTES: "5" }),
    );
    expect(result.pausedNow).toHaveLength(1);
  });
});

describe("sweepIdleBoxes: no pause while active", () => {
  it("keeps a box used 3 minutes ago", async () => {
    const { deps } = sweepDeps([appBox()], { [KEY]: activity(3) });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toEqual([]);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(deps.announceAsleep).not.toHaveBeenCalled();
  });

  it("keeps a box under a command hold", async () => {
    const { deps } = sweepDeps([appBox()], {
      [KEY]: activity(20, { activeUntil: new Date(NOW + MIN) }),
    });
    expect((await sweepIdleBoxes(deps, config)).pausedNow).toEqual([]);
  });

  it("keeps a box whose workflow run is still going", async () => {
    const { deps } = sweepDeps(
      [appBox()],
      { [KEY]: activity(30) },
      {
        hasRunningWork: vi.fn(async () => true),
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toEqual([]);
    expect(result.kept).toEqual([
      { sessionKey: KEY, reason: "workflow run in progress" },
    ]);
  });

  it("keeps a box when the work probe fails", async () => {
    const { deps } = sweepDeps(
      [appBox()],
      { [KEY]: activity(30) },
      {
        hasRunningWork: vi.fn(async () => {
          throw new Error("exec timed out");
        }),
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result.kept[0].reason).toMatch(/work probe failed/);
  });

  it("never touches a box another environment's database owns", async () => {
    const { deps } = sweepDeps([appBox()], {});
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result.kept[0].reason).toBe("not a session of this database");
  });

  it("leaves paused boxes alone", async () => {
    const { deps } = sweepDeps([appBox({ state: "paused" })], {
      [KEY]: activity(600),
    });
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result).toMatchObject({ running: 0, paused: 1 });
  });
});

describe("metrics", () => {
  it("counts running and paused boxes and box-seconds per workspace", () => {
    const other = "6846e6a01b05af0948070111";
    const usage = usageByWorkspace(
      [
        appBox({ startedMinutesAgo: 40 }),
        appBox({
          sandboxId: "sbx-2",
          sessionKey: `${WS}:u2`,
          startedMinutesAgo: 10,
        }),
        appBox({ sandboxId: "sbx-3", state: "paused" }),
        appBox({
          sandboxId: "sbx-4",
          sessionKey: `${other}:u3`,
          state: "paused",
        }),
      ],
      NOW,
      120,
    );
    expect(usage).toEqual([
      {
        workspaceId: WS,
        running: 2,
        paused: 1,
        boxSeconds: 240,
        vcpuSeconds: 480,
        uptimeSeconds: 50 * 60,
      },
      {
        workspaceId: other,
        running: 0,
        paused: 1,
        boxSeconds: 0,
        vcpuSeconds: 0,
        uptimeSeconds: 0,
      },
    ]);
  });

  it("the sweep returns the usage it measured", async () => {
    const { deps } = sweepDeps([appBox()], { [KEY]: activity(1) });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.usage).toEqual([
      expect.objectContaining({ workspaceId: WS, running: 1, boxSeconds: 120 }),
    ]);
  });
});

function reapDeps(
  boxes: AppBoxInfo[],
  acts: Record<string, BoxActivity>,
  overrides: Partial<ReapDeps> = {},
) {
  const calls: string[] = [];
  const deps: ReapDeps = {
    listBoxes: async () => boxes,
    getActivity: async keys =>
      new Map(
        keys.map(k => [
          k,
          acts[k] ?? { known: false, lastActivityAt: null, activeUntil: null },
        ]),
      ),
    settle: vi.fn(async (key: string) => {
      calls.push(`settle:${key}`);
      return { ok: true as const };
    }),
    pause: vi.fn(async (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    }),
    destroy: vi.fn(async (key: string) => {
      calls.push(`destroy:${key}`);
    }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

const pausedDaysAgo = (days: number, extra: Partial<AppBoxInfo> = {}) =>
  appBox({ state: "paused", startedMinutesAgo: days * 24 * 60, ...extra });

describe("reapPausedBoxes: delete after D days", () => {
  it("deletes a session paused and unused for 15 days, settling first", async () => {
    const { deps, calls } = reapDeps([pausedDaysAgo(15)], {
      [KEY]: activity(15 * 24 * 60),
    });
    const result = await reapPausedBoxes(deps, config);
    expect(calls).toEqual([`settle:${KEY}`, `destroy:${KEY}`]);
    expect(result.deleted).toEqual([
      { sessionKey: KEY, boxes: 1, committed: undefined, idleDays: 15 },
    ]);
  });

  it("keeps a session used 13 days ago", async () => {
    const { deps } = reapDeps([pausedDaysAgo(30)], {
      [KEY]: activity(13 * 24 * 60),
    });
    const result = await reapPausedBoxes(deps, config);
    expect(result.due).toBe(0);
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it("honours a shorter configured retention", async () => {
    const { deps } = reapDeps([pausedDaysAgo(4)], { [KEY]: activity(null) });
    const result = await reapPausedBoxes(
      deps,
      boxIdleConfig({ APPS_BOX_PAUSED_RETENTION_DAYS: "3" }),
    );
    expect(result.deleted).toHaveLength(1);
  });

  it("never deletes a session with a running box", async () => {
    const { deps } = reapDeps(
      [pausedDaysAgo(40), appBox({ sandboxId: "sbx-2", startedMinutesAgo: 5 })],
      { [KEY]: activity(null) },
    );
    await reapPausedBoxes(deps, config);
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it("never deletes another environment's box", async () => {
    const { deps } = reapDeps([pausedDaysAgo(40)], {});
    const result = await reapPausedBoxes(deps, config);
    expect(deps.settle).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { sessionKey: KEY, reason: "not a session of this database" },
    ]);
  });

  it("drains a backlog oldest first, a batch per run", async () => {
    const keys = [20, 40, 30].map((days, i) => ({
      key: `${WS}:user${i}`,
      days,
    }));
    const { deps } = reapDeps(
      keys.map(({ key, days }, i) =>
        pausedDaysAgo(days, { sandboxId: `sbx-${i}`, sessionKey: key }),
      ),
      Object.fromEntries(keys.map(({ key }) => [key, activity(null)])),
    );
    const result = await reapPausedBoxes(
      deps,
      boxIdleConfig({ APPS_BOX_REAP_BATCH: "2" }),
    );
    expect(result.due).toBe(3);
    expect(result.deleted.map(d => d.idleDays)).toEqual([40, 30]);
  });

  it("keeps a session someone used while it was being settled", async () => {
    let reads = 0;
    const { deps } = reapDeps(
      [pausedDaysAgo(20)],
      {},
      {
        getActivity: async keys => {
          reads += 1;
          return new Map(
            keys.map(k => [
              k,
              reads === 1 ? activity(20 * 24 * 60) : activity(0),
            ]),
          );
        },
      },
    );
    const result = await reapPausedBoxes(deps, config);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { sessionKey: KEY, reason: "used during the sweep" },
    ]);
  });
});

describe("reapPausedBoxes: skip on dirty failure", () => {
  it("keeps the box, re-pauses it and records why", async () => {
    const { deps, calls } = reapDeps(
      [pausedDaysAgo(20)],
      { [KEY]: activity(null) },
      {
        settle: vi.fn(async () => ({
          ok: false as const,
          reason: "uncommitted work on a detached HEAD",
        })),
      },
    );
    const result = await reapPausedBoxes(deps, config);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(calls).toEqual(["pause:sbx-1"]);
    expect(result.skipped).toEqual([
      { sessionKey: KEY, reason: "uncommitted work on a detached HEAD" },
    ]);
  });

  it("treats a settle that throws as a failure", async () => {
    const { deps } = reapDeps(
      [pausedDaysAgo(20)],
      { [KEY]: activity(null) },
      {
        settle: vi.fn(async () => {
          throw new Error("push rejected");
        }),
      },
    );
    const result = await reapPausedBoxes(deps, config);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(result.skipped[0].reason).toBe("settle failed: push rejected");
  });
});

const clean = {
  branch: "main",
  head: "abc",
  ahead: 0,
  changes: [] as Array<{ path: string; status: string }>,
};
const dirty = {
  ...clean,
  changes: [{ path: "apps/sales/App.tsx", status: "modified" }],
};

describe("settleBoxForDelete: commit before delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    box.boxExec.mockResolvedValue({
      stdout: "STASH=\nUNPUSHED=\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("does nothing to a clean box", async () => {
    box.boxStatus.mockResolvedValue(clean);
    expect(await settleBoxForDelete(KEY)).toEqual({
      ok: true,
      committed: undefined,
    });
    expect(box.boxCommitAll).not.toHaveBeenCalled();
  });

  it("commits uncommitted work to the session branch and pushes it first", async () => {
    box.boxStatus.mockResolvedValueOnce({ ...dirty, branch: "feature/q4" });
    box.boxStatus.mockResolvedValueOnce({ ...clean, branch: "feature/q4" });
    box.boxCommitAll.mockResolvedValue({ committed: true, commitOid: "f00d" });
    const outcome = await settleBoxForDelete(KEY);
    expect(outcome).toEqual({ ok: true, committed: "f00d" });
    // Fresh git token first, then the existing commit-and-push machinery.
    expect(box.configureBoxRemote).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, userId: USER }),
    );
    expect(box.boxCommitAll).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: { sessionKey: KEY },
        author: { name: "ana", email: "ana@x.io" },
        message: expect.stringMatching(/^Autosave/),
      }),
    );
  });

  it("pushes commits that only lived in the box", async () => {
    box.boxStatus.mockResolvedValueOnce({ ...clean, ahead: 2 });
    box.boxStatus.mockResolvedValueOnce(clean);
    box.boxCommitAll.mockResolvedValue({ committed: false });
    expect(await settleBoxForDelete(KEY)).toMatchObject({ ok: true });
    expect(box.boxCommitAll).toHaveBeenCalledTimes(1);
  });

  it("refuses when work is still dirty after the commit", async () => {
    box.boxStatus.mockResolvedValue(dirty);
    box.boxCommitAll.mockResolvedValue({ committed: true, commitOid: "f00d" });
    expect(await settleBoxForDelete(KEY)).toEqual({
      ok: false,
      reason: "work still not on the server after the autosave commit",
    });
  });

  it("refuses a detached HEAD with changes", async () => {
    box.boxStatus.mockResolvedValue({ ...dirty, branch: "HEAD" });
    expect(await settleBoxForDelete(KEY)).toEqual({
      ok: false,
      reason: "uncommitted work on a detached HEAD",
    });
    expect(box.boxCommitAll).not.toHaveBeenCalled();
  });

  it("lets a failed push propagate so the reaper keeps the box", async () => {
    box.boxStatus.mockResolvedValue(dirty);
    box.boxCommitAll.mockRejectedValue(
      new Error("Committed in the sandbox, but the push failed"),
    );
    await expect(settleBoxForDelete(KEY)).rejects.toThrow(/push failed/);
  });

  it("refuses when a stash would be lost", async () => {
    box.boxStatus.mockResolvedValue(clean);
    box.boxExec.mockResolvedValue({
      stdout: "STASH=stash@{0}: WIP on main\nUNPUSHED=\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await settleBoxForDelete(KEY)).toEqual({
      ok: false,
      reason: "stash entries would be lost",
    });
  });

  it("refuses when another local branch has unpushed commits", async () => {
    box.boxStatus.mockResolvedValue(clean);
    box.boxExec.mockResolvedValue({
      stdout: "STASH=\nUNPUSHED=0123456789abcdef\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await settleBoxForDelete(KEY)).toMatchObject({ ok: false });
  });

  it("never commits in the publish actor's box", async () => {
    box.boxStatus.mockResolvedValue(dirty);
    const outcome = await settleBoxForDelete(`${WS}:publish`);
    expect(outcome).toMatchObject({ ok: true });
    expect(box.boxCommitAll).not.toHaveBeenCalled();
  });
});
