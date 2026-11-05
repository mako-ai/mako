/**
 * Review of PR #1190: after-publish refresh and the reconcile's in-flight test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publishedSha: "c".repeat(40),
  rows: [] as Array<Record<string, unknown>>,
  sent: [] as unknown[],
  updates: [] as unknown[],
  bindingState: null as null | { history: Array<{ at: Date; status: string }> },
  buildError: null as Error | null,
}));

vi.mock("../client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_options: unknown, handler: (ctx: unknown) => unknown) => ({ handler }),
    ),
    send: vi.fn(async (events: unknown) => {
      state.sent.push(events);
    }),
  },
}));
vi.mock("../../database/workspace-schema", () => ({
  AppIndexEntry: {},
  AppProject: {
    findById: vi.fn(async () => ({
      _id: "app",
      workspaceId: "ws",
      publishedSha: state.publishedSha,
    })),
    find: vi.fn(() => ({ select: () => ({ lean: async () => state.rows }) })),
    updateOne: vi.fn(async (...args: unknown[]) => {
      state.updates.push(args);
    }),
  },
}));
vi.mock("../../apps/app-index.service", () => ({ loadAppsIndex: vi.fn() }));
vi.mock("../../apps/app-lifecycle.service", () => ({
  pausedScheduleAppIds: vi.fn(),
}));
vi.mock("../../apps/worktree.service", () => ({
  PUBLISH_ACTOR: "publish",
  repoForWorkspace: vi.fn(async () => "/repo"),
  resolveProjectRef: vi.fn(),
}));
vi.mock("../../apps/deployment.service", () => ({
  isBindingArtifactReady: vi.fn(async () => false),
  recordDeployFailure: vi.fn(),
}));
vi.mock("../../apps/bindings.service", () => ({
  getBindingState: vi.fn(async () => state.bindingState),
  materializeAppBinding: vi.fn(async () => {
    if (state.buildError) throw state.buildError;
    return { rowCount: 7 };
  }),
  readCommittedBinding: vi.fn(async () => ({
    name: "sales",
    connectionId: "warehouse",
    schedule: "55 * * * *",
    timezone: "UTC",
  })),
}));
const OLD = "1".repeat(40);
const WALKING = "8".repeat(40);
vi.mock("../../apps/deploy-on-push", () => ({
  DeployBindingsError: class extends Error {},
  deployOneApp: vi.fn(),
  // The app's tree is unchanged from the walking commit to head (another
  // app's push moved main). It differs only from the published commit.
  appFolderChanged: vi.fn(
    async (_w: string, _d: string, _a: string, from: string) =>
      from === "1".repeat(40),
  ),
}));
vi.mock("../../apps/deploy-commit-status", () => ({
  describeDeployFailure: vi.fn(),
  describeDeployOutcome: vi.fn(),
  reportAppDeployStatus: vi.fn(),
}));
vi.mock("../../apps/repository.service", () => ({
  resolveCommit: vi.fn(async () => "9".repeat(40)),
}));

import { materializeAppBinding } from "../../apps/bindings.service";
import { recordDeployFailure } from "../../apps/deployment.service";
import {
  requestBindingRefreshes,
  runBindingMaterializeEvent,
} from "./apps-binding-refresh";
import { appsDeployReconcileFunction } from "./apps-deploy";

const scheduled = {
  workspaceId: "ws",
  projectId: "app",
  binding: "sales",
  key: "app:sales",
};
const after = (at: string) => ({ ...scheduled, at, afterPublish: true });
const LIVE = "c".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
  state.publishedSha = LIVE;
  state.rows = [];
  state.sent = [];
  state.updates = [];
  state.bindingState = null;
  state.buildError = null;
});

describe("stale-served binding whose rebuild fails", () => {
  it("DEFECT: the failure must reach something a reader of the app can see", async () => {
    state.buildError = new Error("Unrecognized name: dropped_column");

    const result = await runBindingMaterializeEvent(after(LIVE));

    expect(result).toEqual({ ok: false }); // this much holds
    // No deploy failure, no row write, no retry (retries: 0).
    const surfaced =
      vi.mocked(recordDeployFailure).mock.calls.length > 0 ||
      state.updates.length > 0;
    expect(surfaced).toBe(true);
  });
});

describe("refresh of a commit that is no longer live", () => {
  it("DEFECT: a refresh pinned to a superseded sha must not query the warehouse", async () => {
    const result = await runBindingMaterializeEvent(after("b".repeat(40)));
    expect(materializeAppBinding).not.toHaveBeenCalled();
    expect(result).toHaveProperty("skipped");
  });

  it("DEFECT: its run must not stop the due scheduled build of the live text", async () => {
    // :55 passed. The priority-600 refresh of the OLD text ran first and
    // recorded a run under the shared binding NAME (recordBindingRun).
    const justAfterDue = new Date();
    state.bindingState = {
      history: [{ at: justAfterDue, status: "success" }],
    };

    const result = await runBindingMaterializeEvent(scheduled);

    // The scheduled event for the live text is skipped as not due.
    expect(result).not.toEqual({ skipped: "not-due" });
  });
});

describe("repeated releases", () => {
  it("DEFECT: two publishes must not queue 2N priority-600 events without a dedupe id", async () => {
    const names = ["a", "b", "c"];
    await requestBindingRefreshes(
      { _id: "app", workspaceId: "ws" },
      LIVE,
      names,
    );
    await requestBindingRefreshes(
      { _id: "app", workspaceId: "ws" },
      LIVE,
      names,
    );

    const events = state.sent.flat() as Array<{ id?: string }>;
    expect(events).toHaveLength(6);
    expect(new Set(events.map(e => e.id)).size).toBe(3);
  });
});

describe("reconcile while main moved under a walk", () => {
  it("DEFECT: head moved by another app's push must not restart a progressing walk", async () => {
    const now = new Date();
    state.rows = [
      {
        _id: "app",
        workspaceId: "ws",
        path: "apps/web-performance",
        publishedSha: OLD,
        deployProgress: {
          sha: WALKING,
          stage: "bindings",
          startedAt: now,
          stageStartedAt: now,
          updatedAt: now,
        },
      },
    ];
    const sendEvent = vi.fn(async () => undefined);
    await (
      appsDeployReconcileFunction as unknown as {
        handler: (ctx: unknown) => Promise<unknown>;
      }
    ).handler({
      step: { run: (_n: string, fn: () => unknown) => fn(), sendEvent },
    });
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
