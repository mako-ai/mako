/**
 * The pre-save pass's decisions, against mocked box operations (no E2B, no
 * git; rescueBox runs for real in box-presave.git.test.ts):
 * - dry run (the default) writes nothing, lists paths and sizes, and pauses
 *   what it woke, even when opening fails;
 * - a box whose origin is not this workspace's production endpoint is never
 *   rescued;
 * - a manual worktree, a blocked or failed ref, or a left-out file outside
 *   build output makes the row `manual`;
 * - `changed` is false on a re-run that finds everything already saved;
 * - --apply refuses any origin but https://app.mako.ai and any dev tunnel.
 */
import { describe, expect, it, vi } from "vitest";
import {
  expectedOrigin,
  parseSessionKey,
  presaveSessions,
  scrub,
  type BoxInspection,
  type BoxRescue,
  type ListedBox,
  type PresaveOps,
} from "./box-presave";
import { checkApplyOrigin, parseArgs } from "../scripts/e2b-presave-sessions";

const WS = "6846e6a01b05af0948070582";
const ORIGIN_BASE = "https://app.mako.ai";
const ORIGIN = `${ORIGIN_BASE}/api/apps-git/${WS}.git`;
const NOW = new Date("2026-11-16T10:00:00Z");

const clean: BoxInspection = {
  hasRepo: true,
  origin: ORIGIN,
  branch: "main",
  inProgress: [],
  paths: [],
  pathsTotal: 0,
  stashes: 0,
  unpushed: [],
  headUnpushed: 0,
};

const saved = (over: Partial<BoxRescue> = {}): BoxRescue => ({
  worktree: {
    status: "saved",
    branch: "mako-presave/u1/2026-11-16",
    commitOid: "abc1234",
    files: 1,
    excluded: [],
    ignored: [],
  },
  refs: [],
  ...over,
});

function mockOps(
  boxes: ListedBox[],
  inspections: Record<string, Partial<BoxInspection>>,
) {
  return {
    listBoxes: vi.fn(async () => boxes),
    open: vi.fn(async () => undefined),
    inspect: vi.fn(async (box: ListedBox) => ({
      ...clean,
      ...inspections[box.sandboxId],
    })),
    rescue: vi.fn(async (): Promise<BoxRescue> => saved()),
    pause: vi.fn(async () => undefined),
  } satisfies PresaveOps;
}

const box = (
  sandboxId: string,
  userId: string,
  state: "paused" | "running" = "paused",
): ListedBox => ({ sandboxId, sessionKey: `${WS}:${userId}`, state });

const dirty = (path = "apps/a/x.ts"): Partial<BoxInspection> => ({
  paths: [{ path, size: 10, excluded: null }],
  pathsTotal: 1,
});

const run = (
  ops: PresaveOps,
  extra: Partial<Parameters<typeof presaveSessions>[1]> = {},
) =>
  presaveSessions(ops, {
    apply: false,
    originBase: ORIGIN_BASE,
    now: () => NOW,
    ...extra,
  });

describe("parseSessionKey", () => {
  it("accepts a person's session and rejects system boxes", () => {
    expect(parseSessionKey(`${WS}:user-1`)).toEqual({
      workspaceId: WS,
      userId: "user-1",
    });
    expect(parseSessionKey(`${WS}:publish`)).toBeNull();
    expect(parseSessionKey(`connector-sync:${WS}`)).toBeNull();
    expect(parseSessionKey(`connector-build:${WS}`)).toBeNull();
    expect(parseSessionKey("garbage")).toBeNull();
  });

  it("expectedOrigin is the workspace's own endpoint", () => {
    expect(expectedOrigin("https://app.mako.ai/", WS)).toBe(ORIGIN);
  });
});

describe("presaveSessions", () => {
  it("dry run writes nothing, lists paths, and pauses every box it woke", async () => {
    const ops = mockOps(
      [
        box("b-dirty", "u1"),
        box("b-clean", "u2"),
        box("b-stash", "u3"),
        box("b-detached", "u4"),
        box("b-publish", "publish"),
        box("b-running", "u5", "running"),
      ],
      {
        "b-dirty": dirty(),
        "b-stash": { stashes: 1 },
        "b-detached": { branch: null, headUnpushed: 2 },
      },
    );
    const { rows, totals } = await run(ops);

    expect(ops.rescue).not.toHaveBeenCalled();
    expect(totals["would-save"]).toBe(3);
    expect(totals.clean).toBe(1);
    expect(totals.skipped).toBe(2);
    expect(rows.find(r => r.sandboxId === "b-dirty")?.paths).toEqual([
      { path: "apps/a/x.ts", size: 10, excluded: null },
    ]);
    expect(ops.open).toHaveBeenCalledTimes(4);
    expect(ops.pause).toHaveBeenCalledTimes(4);
  });

  it("a preview or laptop box is never rescued", async () => {
    const ops = mockOps([box("b-preview", "u1")], {
      "b-preview": {
        ...dirty(),
        origin: "https://pr-1281.mako.ai/api/apps-git/x.git",
      },
    });
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]?.action).toBe("foreign-origin");
    expect(ops.rescue).not.toHaveBeenCalled();
  });

  it("another workspace's origin is foreign too", async () => {
    const ops = mockOps([box("b", "u1")], {
      b: { ...dirty(), origin: expectedOrigin(ORIGIN_BASE, "f".repeat(24)) },
    });
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]?.action).toBe("foreign-origin");
  });

  it("apply rescues with the workspace's own origin and reports the branch", async () => {
    const ops = mockOps([box("b-dirty", "u1")], { "b-dirty": dirty() });
    const { rows } = await run(ops, { apply: true });
    expect(ops.rescue).toHaveBeenCalledWith(box("b-dirty", "u1"), {
      workspaceId: WS,
      userId: "u1",
      now: NOW,
      expectedOrigin: ORIGIN,
    });
    expect(rows[0]).toMatchObject({
      action: "saved",
      changed: true,
      worktree: "pushed",
      rescueBranch: "mako-presave/u1/2026-11-16",
      commitOid: "abc1234",
    });
  });

  it("apply runs even when the dry-run estimate saw nothing", async () => {
    const ops = mockOps([box("b", "u1")], {});
    ops.rescue.mockResolvedValueOnce({
      worktree: { status: "clean", excluded: [], ignored: [] },
      refs: [],
    });
    const { rows } = await run(ops, { apply: true });
    expect(ops.rescue).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ action: "clean", changed: false });
  });

  it("a left-out file outside build output makes the row manual", async () => {
    const ops = mockOps([box("b", "u1")], { b: dirty() });
    ops.rescue.mockResolvedValueOnce(
      saved({
        worktree: {
          status: "saved",
          branch: "x",
          commitOid: "abc",
          files: 1,
          excluded: ["apps/a/ghost.ts (index-only)"],
          ignored: [],
        },
      }),
    );
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]?.action).toBe("manual");
    expect(rows[0]?.note).toContain("apps/a/ghost.ts (index-only)");
  });

  it("only build output left out still counts as saved", async () => {
    const ops = mockOps([box("b", "u1")], { b: dirty() });
    ops.rescue.mockResolvedValueOnce(
      saved({
        worktree: {
          status: "saved",
          branch: "x",
          commitOid: "abc",
          files: 1,
          excluded: ["apps/a/dist/out.js (excluded directory)"],
          ignored: [],
        },
      }),
    );
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]?.action).toBe("saved");
  });

  it("a re-run that finds everything rescued reports changed: false", async () => {
    const ops = mockOps([box("b", "u1")], { b: { ...dirty(), stashes: 1 } });
    ops.rescue.mockResolvedValueOnce({
      worktree: {
        status: "saved",
        branch: "x",
        commitOid: "abc",
        files: 1,
        excluded: [],
        ignored: [],
        unchanged: true,
      },
      refs: [{ ref: "x-stash-abc1234", status: "unchanged", commitOid: "abc" }],
    });
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]).toMatchObject({
      action: "saved",
      changed: false,
      worktree: "unchanged",
    });
  });

  it("a manual worktree, a blocked ref or a failed ref is manual, and scrubbed", async () => {
    const ops = mockOps([box("b", "u1")], { b: dirty() });
    ops.rescue.mockResolvedValueOnce({
      worktree: {
        status: "manual",
        reason: "local branches with commits the server lacks: leaky",
        excluded: [],
        ignored: [],
      },
      refs: [
        {
          ref: "x-branch/leaky",
          status: "blocked",
          detail: ".env (secret-shaped name)",
        },
        {
          ref: "x-stash-abc1234",
          status: "failed",
          detail: "refusing commit by mgt_abc.def token",
        },
      ],
    });
    const { rows } = await run(ops, { apply: true });
    expect(rows[0]?.action).toBe("manual");
    expect(rows[0]?.note).toContain("leaky");
    expect(rows[0]?.note).not.toContain("abc.def");
    expect(rows[0]?.changed).toBe(false);
  });

  it("a box that fails to open is still paused, and the pass goes on", async () => {
    const ops = mockOps([box("b-bad", "u1"), box("b-ok", "u2")], {
      "b-ok": dirty(),
    });
    ops.open.mockRejectedValueOnce(new Error("probe failed after resume"));
    const { rows } = await run(ops);
    expect(rows[0]?.action).toBe("error");
    expect(rows[1]?.action).toBe("would-save");
    expect(ops.pause).toHaveBeenCalledTimes(2);
  });

  it("running boxes join only with includeRunning, and are never paused", async () => {
    const ops = mockOps([box("b-running", "u5", "running")], {
      "b-running": dirty(),
    });
    await run(ops, { apply: true, includeRunning: true });
    expect(ops.rescue).toHaveBeenCalledTimes(1);
    expect(ops.pause).not.toHaveBeenCalled();
  });

  it("limit caps the boxes visited", async () => {
    const ops = mockOps([box("a", "u1"), box("b", "u2"), box("c", "u3")], {});
    await run(ops, { limit: 2 });
    expect(ops.open).toHaveBeenCalledTimes(2);
  });
});

describe("scrub", () => {
  it("redacts git tokens, E2B keys and URL credentials", () => {
    expect(scrub("x mgt_aaa.bbb y e2b_0123abcd https://u:p@h/r")).toBe(
      "x mgt_[redacted] y e2b_[redacted] https://[redacted]@h/r",
    );
  });
});

describe("e2b-presave-sessions arguments", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      includeRunning: false,
      only: [],
    });
  });
  it("needs --apply to write", () => {
    expect(
      parseArgs(["--apply", "--only", `${WS}:u1`, "--limit", "3"]),
    ).toEqual({
      apply: true,
      includeRunning: false,
      only: [`${WS}:u1`],
      limit: 3,
    });
  });
  it("refuses unknown flags", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unknown argument/);
  });
});

describe("checkApplyOrigin", () => {
  const ok = {
    env: { APPS_GIT_ORIGIN_URL: "https://app.mako.ai" },
    resolvedBase: () => "https://app.mako.ai",
    tunnelFiles: ["/repo/.env.tunnel"],
    exists: () => false,
  };
  it("accepts the production origin with no tunnel", () => {
    expect(checkApplyOrigin(ok)).toBe("https://app.mako.ai");
  });
  it("requires the origin explicitly", () => {
    expect(() => checkApplyOrigin({ ...ok, env: {} })).toThrow(
      /APPS_GIT_ORIGIN_URL/,
    );
    expect(() =>
      checkApplyOrigin({
        ...ok,
        env: { APPS_GIT_ORIGIN_URL: "https://pr-1.mako.ai" },
      }),
    ).toThrow(/APPS_GIT_ORIGIN_URL/);
  });
  it("refuses while a dev tunnel file exists", () => {
    expect(() => checkApplyOrigin({ ...ok, exists: () => true })).toThrow(
      /tunnel/,
    );
  });
  it("refuses when the resolver disagrees", () => {
    expect(() =>
      checkApplyOrigin({
        ...ok,
        resolvedBase: () => "https://x.trycloudflare.com",
      }),
    ).toThrow(/resolves to/);
  });
});
