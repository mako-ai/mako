/**
 * The app-box idle policy, offline: no E2B box is created, paused or killed.
 * Every E2B call is a mock; the terminal probe runs against a fake `ps`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sandbox/e2b-fleet", () => ({
  listAppBoxes: vi.fn(),
  openAppBoxById: vi.fn(),
  pauseAppBox: vi.fn(),
  killAppBox: vi.fn(),
}));
vi.mock("./sandbox/e2b-provider", () => ({ noteSessionPaused: vi.fn() }));
vi.mock("./box-state.service", () => ({ markBoxOffline: vi.fn() }));
vi.mock("./terminal/sessions", () => ({ forgetTerminalCaches: vi.fn() }));
vi.mock("./worktree/box-session", () => ({
  resolveActorIdentity: vi.fn(),
  forgetBoxCaches: vi.fn(),
}));
vi.mock("./worktree/worktrees", () => ({
  isUserActor: (id: string) => /^[0-9a-f]{24}$/i.test(id),
}));

import type { BoxActivity } from "./box-activity";
import {
  RUNNING_WORK_PROBE,
  boxIdleConfig,
  idleDeadline,
  lastUseOf,
  parseRunningWork,
  planReap,
  reapPausedBoxes,
  reapSession,
  sweepIdleBoxes,
  usageByWorkspace,
  type ReapDeps,
  type SweepDeps,
} from "./box-idle.service";
import type { RescueResult } from "./box/rescue-commit";
import type { AppBoxInfo } from "./sandbox/e2b-fleet";

const WS = "6846e6a01b05af0948070582";
const USER = "6846e6a01b05af0948070999";
const KEY = `${WS}:${USER}`;
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const config = boxIdleConfig({});
const reaperOn = boxIdleConfig({ APPS_BOX_REAPER: "on" });

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

const unknown: BoxActivity = {
  known: false,
  lastActivityAt: null,
  activeUntil: null,
};

function mapOf(acts: Record<string, BoxActivity>) {
  return async (keys: string[]) =>
    new Map(keys.map(k => [k, acts[k] ?? unknown]));
}

function sweepDeps(
  boxes: AppBoxInfo[],
  acts: Record<string, BoxActivity>,
  overrides: Partial<SweepDeps> = {},
) {
  const calls: string[] = [];
  const deps: SweepDeps = {
    listBoxes: async () => boxes,
    getActivity: mapOf(acts),
    trackingSince: async () => new Date(NOW - 30 * DAY),
    runningWork: vi.fn(async () => null),
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
  it("defaults: 10 idle minutes, 14 days, 10 per run, 2 h hold cap, pause on, reaper OFF", () => {
    expect(config).toEqual({
      enabled: true,
      reaperMode: "off",
      idleMs: 10 * MIN,
      pausedRetentionMs: 14 * DAY,
      reapBatch: 10,
      maxHoldMs: 120 * MIN,
    });
  });

  it("reads the knobs and both switches", () => {
    expect(
      boxIdleConfig({
        APPS_BOX_IDLE_MINUTES: "5",
        APPS_BOX_PAUSED_RETENTION_DAYS: "3",
        APPS_BOX_REAP_BATCH: "2",
        APPS_BOX_IDLE_SWEEP: "off",
        APPS_BOX_REAPER: "on",
        APPS_BOX_MAX_HOLD_MINUTES: "30",
      }),
    ).toEqual({
      enabled: false,
      reaperMode: "on",
      idleMs: 5 * MIN,
      pausedRetentionMs: 3 * DAY,
      reapBatch: 2,
      maxHoldMs: 30 * MIN,
    });
    expect(boxIdleConfig({ APPS_BOX_REAPER: "dryrun" }).reaperMode).toBe(
      "dryrun",
    );
    expect(boxIdleConfig({ APPS_BOX_REAPER: "yes" }).reaperMode).toBe("off");
  });

  it("ignores junk values", () => {
    expect(boxIdleConfig({ APPS_BOX_IDLE_MINUTES: "-1" }).idleMs).toBe(
      10 * MIN,
    );
  });
});

describe("idle detection", () => {
  const since = new Date(NOW - 30 * MIN);

  it("counts from the last real activity", () => {
    expect(lastUseOf(activity(3), since)).toBe(NOW - 3 * MIN);
    expect(idleDeadline(activity(3), since, 10 * MIN)).toBe(NOW + 7 * MIN);
  });

  it("with no record, counts from the start of tracking, never from a box start", () => {
    expect(lastUseOf(activity(null), since)).toBe(since.getTime());
    expect(lastUseOf(undefined, since)).toBe(since.getTime());
  });

  it("a hold for a long command outlasts the idle window", () => {
    const hold = activity(20, { activeUntil: new Date(NOW + 5 * MIN) });
    expect(idleDeadline(hold, since, 10 * MIN)).toBe(NOW + 5 * MIN);
  });
});

describe("sweepIdleBoxes: pause after idle", () => {
  it("pauses a box idle past the window, telling tabs first", async () => {
    const { deps, calls } = sweepDeps([appBox()], { [KEY]: activity(11) });
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toEqual([
      { sessionKey: KEY, sandboxId: "sbx-1", idleMinutes: 11 },
    ]);
    expect(calls).toEqual([`asleep:${KEY}`, "pause:sbx-1"]);
  });

  it("pauses an open-but-idle tab's box even though it is being polled", async () => {
    const { deps } = sweepDeps([appBox({ startedMinutesAgo: 57 })], {
      [KEY]: activity(45),
    });
    expect((await sweepIdleBoxes(deps, config)).pausedNow).toHaveLength(1);
  });

  it("a recent resume is not use: no record + box started 1 minute ago still pauses", async () => {
    const { deps } = sweepDeps([appBox({ startedMinutesAgo: 1 })], {
      [KEY]: activity(null),
    });
    expect((await sweepIdleBoxes(deps, config)).pausedNow).toHaveLength(1);
  });

  it("a resume minutes after the last use does not restart the clock", async () => {
    const { deps } = sweepDeps([appBox({ startedMinutesAgo: 2 })], {
      [KEY]: activity(30),
    });
    expect((await sweepIdleBoxes(deps, config)).pausedNow).toHaveLength(1);
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

  it("keeps a box with a workflow run or a terminal command going", async () => {
    for (const work of ["workflow run", "terminal command npm"]) {
      const { deps } = sweepDeps(
        [appBox()],
        { [KEY]: activity(30) },
        {
          runningWork: vi.fn(async () => work),
        },
      );
      const result = await sweepIdleBoxes(deps, config);
      expect(result.pausedNow).toEqual([]);
      expect(result.kept).toEqual([{ sessionKey: KEY, reason: work }]);
    }
  });

  it("2 h cap: a terminal left in vim stops holding the box", async () => {
    const { deps } = sweepDeps(
      [appBox()],
      { [KEY]: activity(121) },
      {
        runningWork: vi.fn(async () => "terminal command vim"),
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(result.kept).toEqual([]);
    expect(result.pausedNow).toEqual([
      {
        sessionKey: KEY,
        sandboxId: "sbx-1",
        idleMinutes: 121,
        note: "terminal command vim ignored: no real use for 120 min",
      },
    ]);
  });

  it("2 h cap: inside the cap, the same command still holds the box", async () => {
    const { deps } = sweepDeps(
      [appBox()],
      { [KEY]: activity(119) },
      {
        runningWork: vi.fn(async () => "terminal command tail"),
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(result.pausedNow).toEqual([]);
    expect(result.kept).toEqual([
      { sessionKey: KEY, reason: "terminal command tail" },
    ]);
  });

  it("keeps a box when the work probe fails", async () => {
    const { deps } = sweepDeps(
      [appBox()],
      { [KEY]: activity(30) },
      {
        runningWork: vi.fn(async () => {
          throw new Error("exec timed out");
        }),
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result.kept[0].reason).toMatch(/work probe failed/);
  });

  it("re-checks that one session right before pausing", async () => {
    let reads = 0;
    const { deps } = sweepDeps(
      [appBox()],
      {},
      {
        getActivity: async keys => {
          reads += 1;
          // Idle at the first read; someone typed while the probe ran.
          return new Map(
            keys.map(k => [k, reads === 1 ? activity(30) : activity(0)]),
          );
        },
      },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(reads).toBe(2);
    expect(deps.announceAsleep).not.toHaveBeenCalled();
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result.kept).toEqual([
      { sessionKey: KEY, reason: "used during the sweep" },
    ]);
  });

  it("never touches a box another environment's database owns", async () => {
    const { deps } = sweepDeps([appBox()], {});
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(result.kept[0].reason).toBe("not a session of this database");
  });

  it("never pauses the publish box or an api-key actor's box", async () => {
    const publish = `${WS}:publish`;
    const apiKey = `${WS}:api-key`;
    const { deps } = sweepDeps(
      [
        appBox({ sessionKey: publish, sandboxId: "pub" }),
        appBox({ sessionKey: apiKey, sandboxId: "key" }),
      ],
      { [publish]: activity(600), [apiKey]: activity(600) },
    );
    const result = await sweepIdleBoxes(deps, config);
    expect(deps.pause).not.toHaveBeenCalled();
    expect(deps.runningWork).not.toHaveBeenCalled();
    // Still counted in the usage metrics.
    expect(result.running).toBe(2);
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

describe("terminal work probe", () => {
  async function probeWith(psOutput: string): Promise<string | null> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-"));
    try {
      const ps = path.join(dir, "ps");
      await fs.writeFile(ps, `#!/bin/sh\ncat <<'EOF'\n${psOutput}\nEOF\n`);
      await fs.chmod(ps, 0o755);
      const { stdout } = await promisify(execFile)(
        "bash",
        ["-c", RUNNING_WORK_PROBE],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        },
      );
      return parseRunningWork(stdout);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("an idle shell is not work", async () => {
    expect(
      await probeWith(
        ["Ss+ pts/1 bash -bash", "S ? node node /tmp/box-agent.js"].join("\n"),
      ),
    ).toBeNull();
  });

  it("a foreground command in a terminal is work", async () => {
    expect(
      await probeWith(
        ["Ss pts/1 bash -bash", "Sl+ pts/1 npm npm run build"].join("\n"),
      ),
    ).toBe("terminal command npm");
  });

  it("Mako's own dev server pty is not a terminal in use", async () => {
    expect(
      await probeWith(
        [
          "Ss pts/2 bash bash -c node /tmp/mako-dev-abc.mjs",
          "Sl+ pts/2 node node /tmp/mako-dev-abc.mjs",
          "Ss+ pts/3 dtach dtach -a /tmp/mako-term-1.sock",
          "Ss+ pts/4 tmux: client tmux attach",
        ].join("\n"),
      ),
    ).toBeNull();
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
});

const saved = (id: string): RescueResult => ({
  status: "saved",
  branch: `mako-presave/${USER}/2026-11-16`,
  commitOid: id.padEnd(40, "0"),
  files: 1,
  excluded: [],
  ignored: [],
});
const clean: RescueResult = { status: "clean", excluded: [], ignored: [] };

function reapDeps(
  boxes: AppBoxInfo[],
  acts: Record<string, BoxActivity>,
  overrides: Partial<ReapDeps> = {},
) {
  const calls: string[] = [];
  const deps: ReapDeps = {
    listBoxes: async () => boxes,
    getActivity: mapOf(acts),
    trackingSince: async () => new Date(NOW - 30 * DAY),
    settle: vi.fn(async (_key: string, id: string) => {
      calls.push(`settle:${id}`);
      return clean;
    }),
    pause: vi.fn(async (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    }),
    kill: vi.fn(async (id: string) => {
      calls.push(`kill:${id}`);
    }),
    forget: vi.fn(async (key: string) => {
      calls.push(`forget:${key}`);
    }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

const paused = (
  extra: Partial<AppBoxInfo> & { startedMinutesAgo?: number } = {},
) => appBox({ state: "paused", startedMinutesAgo: 60 * 24 * 40, ...extra });

describe("planReap: grace rule", () => {
  it("is due when the recorded last use is 15 days old", async () => {
    const { deps } = reapDeps([paused()], { [KEY]: activity(15 * 24 * 60) });
    expect((await planReap(deps, reaperOn)).due).toEqual([
      { sessionKey: KEY, sandboxIds: ["sbx-1"], lastUse: NOW - 15 * DAY },
    ]);
  });

  it("is not due at 13 days", async () => {
    const { deps } = reapDeps([paused()], { [KEY]: activity(13 * 24 * 60) });
    expect((await planReap(deps, reaperOn)).due).toEqual([]);
  });

  it("no record: never due before tracking has run D days, whatever the box's age", async () => {
    const { deps } = reapDeps(
      [paused()],
      { [KEY]: activity(null) },
      {
        trackingSince: async () => new Date(NOW - 2 * DAY),
      },
    );
    expect((await planReap(deps, reaperOn)).due).toEqual([]);
  });

  it("no record and no tracking start: never due", async () => {
    const { deps } = reapDeps(
      [paused()],
      { [KEY]: activity(null) },
      {
        trackingSince: async () => null,
      },
    );
    expect((await planReap(deps, reaperOn)).due).toEqual([]);
  });

  it("no record: due once tracking has run D days", async () => {
    const { deps } = reapDeps(
      [paused()],
      { [KEY]: activity(null) },
      {
        trackingSince: async () => new Date(NOW - 15 * DAY),
      },
    );
    expect((await planReap(deps, reaperOn)).due).toHaveLength(1);
  });

  it("no record + a recent resume: still never counts the box start", async () => {
    const { deps } = reapDeps(
      [paused({ startedMinutesAgo: 5 })],
      { [KEY]: activity(null) },
      { trackingSince: async () => new Date(NOW - 15 * DAY) },
    );
    // Due by tracking age; the 5-minute-old start neither helps nor blocks.
    expect((await planReap(deps, reaperOn)).due[0].lastUse).toBe(
      NOW - 15 * DAY,
    );
  });

  it("never plans a session with a running box", async () => {
    const { deps } = reapDeps([paused(), appBox({ sandboxId: "sbx-2" })], {
      [KEY]: activity(40 * 24 * 60),
    });
    expect((await planReap(deps, reaperOn)).due).toEqual([]);
  });

  it("never plans the publish box or a non-person actor", async () => {
    const pub = `${WS}:publish`;
    const { deps } = reapDeps(
      [
        paused({ sessionKey: pub }),
        paused({ sessionKey: `${WS}:api-key`, sandboxId: "k" }),
      ],
      { [pub]: activity(40 * 24 * 60) },
    );
    const plan = await planReap(deps, reaperOn);
    expect(plan).toEqual({ due: [], skipped: [] });
  });

  it("skips another environment's session", async () => {
    const { deps } = reapDeps([paused()], {});
    expect((await planReap(deps, reaperOn)).skipped).toEqual([
      { sessionKey: KEY, reason: "not a session of this database" },
    ]);
  });

  it("drains a backlog oldest first, a batch per run", async () => {
    const keys = [20, 40, 30].map((days, i) => ({
      key: `${WS}:${USER.slice(0, 23)}${i}`,
      days,
    }));
    const { deps } = reapDeps(
      keys.map(({ key }, i) =>
        paused({ sandboxId: `sbx-${i}`, sessionKey: key }),
      ),
      Object.fromEntries(
        keys.map(({ key, days }) => [key, activity(days * 24 * 60)]),
      ),
    );
    const plan = await planReap(
      deps,
      boxIdleConfig({ APPS_BOX_REAP_BATCH: "2" }),
    );
    expect(plan.due.map(d => (NOW - d.lastUse) / DAY)).toEqual([40, 30]);
  });
});

const candidate = (ids = ["sbx-1"]) => ({
  sessionKey: KEY,
  sandboxIds: ids,
  lastUse: NOW - 20 * DAY,
});

describe("reapSession", () => {
  it("settles every box by id before killing any, then forgets the session", async () => {
    const { deps, calls } = reapDeps(
      [],
      { [KEY]: activity(20 * 24 * 60) },
      {
        settle: vi.fn(async (_k: string, id: string) => {
          calls.push(`settle:${id}`);
          return saved(id);
        }),
      },
    );
    const outcome = await reapSession(deps, candidate(["sbx-1", "sbx-2"]));
    expect(calls).toEqual([
      "settle:sbx-1",
      "settle:sbx-2",
      "kill:sbx-1",
      "kill:sbx-2",
      `forget:${KEY}`,
    ]);
    expect(outcome.action).toBe("deleted");
    expect(deps.settle).toHaveBeenCalledWith(KEY, "sbx-1");
  });

  it("skip on dirty failure: keeps every box, re-pauses what it woke, kills nothing", async () => {
    const { deps, calls } = reapDeps(
      [],
      { [KEY]: activity(20 * 24 * 60) },
      {
        settle: vi.fn(async (_k: string, id: string) => {
          calls.push(`settle:${id}`);
          return id === "sbx-2"
            ? {
                status: "manual" as const,
                reason: "merge_head in progress",
                excluded: [],
                ignored: [],
              }
            : saved(id);
        }),
      },
    );
    const outcome = await reapSession(
      deps,
      candidate(["sbx-1", "sbx-2", "sbx-3"]),
    );
    expect(calls).toEqual([
      "settle:sbx-1",
      "settle:sbx-2",
      "pause:sbx-1",
      "pause:sbx-2",
    ]);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      action: "kept",
      reason: "sbx-2: merge_head in progress",
    });
  });

  it("a settle that throws keeps the box", async () => {
    const { deps } = reapDeps(
      [],
      { [KEY]: activity(20 * 24 * 60) },
      {
        settle: vi.fn(async () => {
          throw new Error("Paused sandbox sbx-1 not found");
        }),
      },
    );
    const outcome = await reapSession(deps, candidate());
    expect(deps.kill).not.toHaveBeenCalled();
    expect(outcome.reason).toMatch(/settle failed: Paused sandbox/);
  });

  it("a kill that throws does not stop the others or the step", async () => {
    const { deps, calls } = reapDeps(
      [],
      { [KEY]: activity(20 * 24 * 60) },
      {
        kill: vi.fn(async (id: string) => {
          calls.push(`kill:${id}`);
          if (id === "sbx-1") throw new Error("lease held");
        }),
        forget: vi.fn(async () => {
          throw new Error("redis down");
        }),
      },
    );
    const outcome = await reapSession(deps, candidate(["sbx-1", "sbx-2"]));
    expect(calls).toContain("kill:sbx-2");
    expect(outcome.action).toBe("deleted");
    expect(outcome.killFailures).toEqual([
      "sbx-1: lease held",
      "forget: redis down",
    ]);
  });

  it("keeps a session used since planning, without settling it", async () => {
    const { deps } = reapDeps([], { [KEY]: activity(1) });
    const outcome = await reapSession(deps, candidate());
    expect(deps.settle).not.toHaveBeenCalled();
    expect(outcome.reason).toBe("used since planning");
  });

  it("keeps a session used during the settle, killing nothing", async () => {
    let reads = 0;
    const { deps } = reapDeps(
      [],
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
    const outcome = await reapSession(deps, candidate());
    expect(deps.kill).not.toHaveBeenCalled();
    expect(outcome.reason).toBe("used during the settle");
  });

  it("APPS_BOX_REAPER=dryrun plans every due session and touches none", async () => {
    const keys = Array.from(
      { length: 12 },
      (_, i) => `${WS}:${USER.slice(0, 22)}${String(i).padStart(2, "0")}`,
    );
    const { deps } = reapDeps(
      keys.map((key, i) => paused({ sandboxId: `sbx-${i}`, sessionKey: key })),
      Object.fromEntries(keys.map(key => [key, activity(20 * 24 * 60)])),
    );
    const { plan, outcomes } = await reapPausedBoxes(
      deps,
      boxIdleConfig({ APPS_BOX_REAPER: "dryrun" }),
    );
    // All 12, past the batch of 10: the logs show the whole backlog.
    expect(plan.due).toHaveLength(12);
    expect(outcomes).toEqual([]);
    // No resume, no rescue push, no pause, no kill.
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.pause).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.forget).not.toHaveBeenCalled();
  });

  it("plan + reap end to end", async () => {
    const { deps } = reapDeps([paused()], { [KEY]: activity(20 * 24 * 60) });
    const { plan, outcomes } = await reapPausedBoxes(deps, reaperOn);
    expect(plan.due).toHaveLength(1);
    expect(outcomes[0].action).toBe("deleted");
  });
});
