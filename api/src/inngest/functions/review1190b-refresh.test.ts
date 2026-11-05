/**
 * Second review of PR #1190: bindingRefreshErrors writes and clears, dedupe ids.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publishedSha: "c".repeat(40),
  sent: [] as Array<Record<string, unknown>>,
  updates: [] as Array<
    [Record<string, unknown>, Record<string, Record<string, unknown>>]
  >,
  bindingState: null as null | { history: Array<{ at: Date; status: string }> },
  buildError: null as Error | null,
  artifactReady: false,
}));

vi.mock("../client", () => ({
  inngest: {
    createFunction: vi.fn(() => ({})),
    send: vi.fn(
      async (
        events: Record<string, unknown> | Array<Record<string, unknown>>,
      ) => {
        state.sent.push(...(Array.isArray(events) ? events : [events]));
      },
    ),
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
    updateOne: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: Record<string, Record<string, unknown>>,
      ) => {
        state.updates.push([filter, update]);
      },
    ),
  },
}));
vi.mock("../../apps/app-index.service", () => ({ loadAppsIndex: vi.fn() }));
vi.mock("../../apps/app-lifecycle.service", () => ({
  pausedScheduleAppIds: vi.fn(),
}));
vi.mock("../../apps/worktree.service", () => ({ PUBLISH_ACTOR: "publish" }));
vi.mock("../../apps/deployment.service", () => ({
  isBindingArtifactReady: vi.fn(async () => state.artifactReady),
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

import {
  requestBindingRefreshes,
  runBindingMaterializeEvent,
} from "./apps-binding-refresh";

const LIVE = "c".repeat(40);
const scheduled = {
  workspaceId: "ws",
  projectId: "app",
  binding: "sales",
  key: "app:sales",
};
const after = (attempt = 1) => ({
  ...scheduled,
  at: LIVE,
  afterPublish: true,
  attempt,
});
const unsets = () =>
  state.updates
    .filter(([, update]) => update.$unset)
    .map(([, update]) => update.$unset);
const sets = () =>
  state.updates
    .filter(([, update]) => update.$set)
    .map(([, update]) => update.$set);

beforeEach(() => {
  vi.clearAllMocks();
  state.publishedSha = LIVE;
  state.sent = [];
  state.updates = [];
  state.bindingState = null;
  state.buildError = null;
  state.artifactReady = false;
});

describe("bindingRefreshErrors writes", () => {
  it("HELD: a failed refresh records the entry and queues one delayed retry", async () => {
    state.buildError = new Error("Unrecognized name: x");
    await runBindingMaterializeEvent(after(1));
    expect(sets()[0]).toHaveProperty("bindingRefreshErrors.sales");
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].ts as number).toBeGreaterThan(Date.now() + 5 * 60_000);
    expect((state.sent[0].data as { attempt: number }).attempt).toBe(2);
  });

  it("HELD: attempt 3 records and stops", async () => {
    state.buildError = new Error("Unrecognized name: x");
    await runBindingMaterializeEvent(after(3));
    expect(sets()).toHaveLength(1);
    expect(state.sent).toHaveLength(0);
  });
});

describe("bindingRefreshErrors clears", () => {
  // Listed in the PR body, not fixed yet.
  it.fails(
    "OPEN: a scheduled build of MAIN's text must not clear a failure of the rolled-back live commit",
    async () => {
      // Live is a rollback. The scheduler builds main's text, another artifact.
      state.publishedSha = "a".repeat(40);
      const result = await runBindingMaterializeEvent(scheduled);
      expect(result).toMatchObject({ ok: true });
      expect(unsets()).toHaveLength(0);
    },
  );

  // Listed in the PR body, not fixed yet.
  it.fails(
    "OPEN: a retry that finds the artifact current must clear the failure it answers",
    async () => {
      state.artifactReady = true;
      const result = await runBindingMaterializeEvent(after(2));
      expect(result).toEqual({ skipped: "not-due" });
      expect(unsets()).toHaveLength(1);
    },
  );
});

describe("dedupe ids", () => {
  it("DEFECT: a release of the same commit next hour needs a different id than the last one", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-03T04:00:00Z"));
      await requestBindingRefreshes({ _id: "app", workspaceId: "ws" }, LIVE, [
        "sales",
      ]);
      vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
      await requestBindingRefreshes({ _id: "app", workspaceId: "ws" }, LIVE, [
        "sales",
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(state.sent[0].id).not.toBe(state.sent[1].id);
  });
});
