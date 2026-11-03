/**
 * One materialize event, one decision. A scheduled event follows the binding's
 * scheduler state. An after-publish event follows the artifact's write time,
 * because that state can say "ran today" for another text of the query (#992).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: { _id: "app", workspaceId: "ws", publishedSha: "" } as {
    _id: string;
    workspaceId: string;
    publishedSha: string;
  } | null,
  binding: {
    name: "sales",
    connectionId: "warehouse",
    schedule: "55 * * * *",
    timezone: "UTC",
  } as Record<string, unknown> | null,
  artifactReady: false,
  bindingState: null as null | { history: Array<{ at: Date; status: string }> },
}));

vi.mock("../client", () => ({
  inngest: { createFunction: vi.fn(() => ({})), send: vi.fn(async () => ({})) },
}));
vi.mock("../../database/workspace-schema", () => ({
  AppIndexEntry: {},
  AppProject: {
    findById: vi.fn(async () => state.project),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
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
  materializeAppBinding: vi.fn(async () => ({ rowCount: 7 })),
  readCommittedBinding: vi.fn(async () => state.binding),
}));

import { inngest } from "../client";
import { AppProject } from "../../database/workspace-schema";
import {
  materializeAppBinding,
  readCommittedBinding,
} from "../../apps/bindings.service";
import {
  AFTER_PUBLISH_MAX_ATTEMPTS,
  APPS_BINDING_MATERIALIZE_EVENT,
  requestBindingRefreshes,
  runBindingMaterializeEvent,
} from "./apps-binding-refresh";

const sha = "9c375532a6e2cddf972c9356c43d3f3c36e31da7";
const scheduled = {
  workspaceId: "ws",
  projectId: "app",
  binding: "sales",
  key: "app:sales",
};
const afterPublish = { ...scheduled, at: sha, afterPublish: true };

beforeEach(() => {
  state.project = { _id: "app", workspaceId: "ws", publishedSha: sha };
  state.binding = {
    name: "sales",
    connectionId: "warehouse",
    schedule: "55 * * * *",
    timezone: "UTC",
  };
  state.artifactReady = false;
  state.bindingState = null;
  vi.clearAllMocks();
});

describe("runBindingMaterializeEvent", () => {
  it("builds a due scheduled binding from its one file, without re-reading the app", async () => {
    await expect(runBindingMaterializeEvent(scheduled)).resolves.toEqual({
      ok: true,
      rowCount: 7,
    });

    expect(readCommittedBinding).toHaveBeenCalledTimes(1);
    expect(materializeAppBinding).toHaveBeenCalledWith(
      state.project,
      "sales",
      "scheduler",
      { at: undefined, binding: state.binding },
    );
  });

  it("skips a scheduled binding that ran and whose artifact is current", async () => {
    state.artifactReady = true;
    state.bindingState = {
      history: [{ at: new Date(), status: "ready" }],
    };

    await expect(runBindingMaterializeEvent(scheduled)).resolves.toEqual({
      skipped: "not-due",
    });
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("still backs off a broken query: a failed attempt is not retried every tick", async () => {
    state.bindingState = {
      history: [{ at: new Date(), status: "error" }],
    };

    await expect(runBindingMaterializeEvent(scheduled)).resolves.toEqual({
      skipped: "not-due",
    });
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("#992: an after-publish refresh ignores that state and builds at the release's commit", async () => {
    state.bindingState = {
      history: [{ at: new Date(), status: "ready" }],
    };

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      ok: true,
      rowCount: 7,
    });

    expect(readCommittedBinding).toHaveBeenCalledWith(
      state.project,
      "sales",
      undefined,
      sha,
    );
    expect(materializeAppBinding).toHaveBeenCalledWith(
      state.project,
      "sales",
      "publish",
      { at: sha, binding: state.binding },
    );
  });

  it("skips an after-publish refresh when another build already refreshed the artifact", async () => {
    state.artifactReady = true;

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      skipped: "not-due",
    });
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("skips a binding that is gone at that commit", async () => {
    state.binding = null;

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      skipped: "binding-gone",
    });
  });

  it("a failed refresh goes on the app row and retries in 10 minutes", async () => {
    vi.mocked(materializeAppBinding).mockRejectedValueOnce(new Error("boom"));

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      ok: false,
    });

    const update = vi.mocked(AppProject.updateOne).mock.calls[0][1] as {
      $set: Record<string, { sha: string; message: string; attempts: number }>;
    };
    expect(update.$set["bindingRefreshErrors.sales"]).toMatchObject({
      sha,
      message: "boom",
      attempts: 1,
    });
    const retry = vi.mocked(inngest.send).mock.calls[0][0] as {
      ts: number;
      data: { attempt: number };
    };
    expect(retry.data.attempt).toBe(2);
    expect(retry.ts).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("stops retrying at the last attempt and keeps the failure on the row", async () => {
    vi.mocked(materializeAppBinding).mockRejectedValueOnce(new Error("boom"));

    await runBindingMaterializeEvent({
      ...afterPublish,
      attempt: AFTER_PUBLISH_MAX_ATTEMPTS,
    });

    expect(inngest.send).not.toHaveBeenCalled();
    expect(AppProject.updateOne).toHaveBeenCalledTimes(1);
  });

  it("a read error is a failure to retry, not a binding that is gone", async () => {
    vi.mocked(readCommittedBinding).mockRejectedValueOnce(
      new Error("fatal: not a tree object"),
    );

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      ok: false,
    });
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it("a success clears the binding's recorded failure", async () => {
    await runBindingMaterializeEvent(afterPublish);

    expect(vi.mocked(AppProject.updateOne).mock.calls[0][1]).toEqual({
      $unset: { "bindingRefreshErrors.sales": 1 },
    });
  });

  it("stands down when its commit is no longer live", async () => {
    state.project = {
      _id: "app",
      workspaceId: "ws",
      publishedSha: "e".repeat(40),
    };

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      skipped: "superseded",
    });
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });
});

describe("requestBindingRefreshes", () => {
  it("sends one after-publish event per binding, with the per-binding concurrency key", async () => {
    await requestBindingRefreshes({ _id: "app", workspaceId: "ws" }, sha, [
      "a",
      "b",
    ]);

    expect(inngest.send).toHaveBeenCalledWith([
      {
        id: expect.stringMatching(/^binding-refresh-app-.+-a-\d+-1$/),
        name: APPS_BINDING_MATERIALIZE_EVENT,
        data: {
          workspaceId: "ws",
          projectId: "app",
          binding: "a",
          key: "app:a",
          at: sha,
          afterPublish: true,
          attempt: 1,
          release: expect.any(Number),
        },
      },
      {
        id: expect.stringMatching(/^binding-refresh-app-.+-b-\d+-1$/),
        name: APPS_BINDING_MATERIALIZE_EVENT,
        data: {
          workspaceId: "ws",
          projectId: "app",
          binding: "b",
          key: "app:b",
          at: sha,
          afterPublish: true,
          attempt: 1,
          release: expect.any(Number),
        },
      },
    ]);
  });

  it("sends nothing for an empty list", async () => {
    await requestBindingRefreshes({ _id: "app", workspaceId: "ws" }, sha, []);
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
