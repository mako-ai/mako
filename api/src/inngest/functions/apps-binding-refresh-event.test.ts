/**
 * One materialize event, one decision. A scheduled event follows the binding's
 * scheduler state. An after-publish event follows the artifact's write time,
 * because that state can say "ran today" for another text of the query (#992).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: { _id: "app" } as { _id: string } | null,
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
  AppProject: { findById: vi.fn(async () => state.project) },
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
import {
  materializeAppBinding,
  readCommittedBinding,
} from "../../apps/bindings.service";
import {
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
  state.project = { _id: "app" };
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

  it("skips a scheduled binding whose state says it already ran", async () => {
    state.bindingState = {
      history: [{ at: new Date(), status: "ready" }],
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

  it("reports a failed build without throwing, so nothing retries the query", async () => {
    vi.mocked(materializeAppBinding).mockRejectedValueOnce(new Error("boom"));

    await expect(runBindingMaterializeEvent(afterPublish)).resolves.toEqual({
      ok: false,
    });
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
        name: APPS_BINDING_MATERIALIZE_EVENT,
        data: {
          workspaceId: "ws",
          projectId: "app",
          binding: "a",
          key: "app:a",
          at: sha,
          afterPublish: true,
        },
      },
      {
        name: APPS_BINDING_MATERIALIZE_EVENT,
        data: {
          workspaceId: "ws",
          projectId: "app",
          binding: "b",
          key: "app:b",
          at: sha,
          afterPublish: true,
        },
      },
    ]);
  });

  it("sends nothing for an empty list", async () => {
    await requestBindingRefreshes({ _id: "app", workspaceId: "ws" }, sha, []);
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
