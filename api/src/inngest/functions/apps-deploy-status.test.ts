import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: null as null | {
    lastDeployError?: { sha: string; stage: string; message: string };
  },
  reports: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../apps/worktree.service", () => ({
  repoForWorkspace: vi.fn(async () => "/repo"),
  resolveProjectRef: vi.fn(async () => state.project),
}));

vi.mock("../../apps/deploy-commit-status", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/deploy-commit-status")>();
  return {
    ...actual,
    reportAppDeployStatus: vi.fn(async (input: Record<string, unknown>) => {
      state.reports.push(input);
      return { posted: true };
    }),
  };
});

import { reportDeployFailure } from "./apps-deploy";

const target = {
  workspaceId: "6a9411eb4c8b33609a65e666",
  appRef: "6a9411eb4c8b33609a65e665",
  sha: "c".repeat(40),
};

beforeEach(() => {
  state.project = null;
  state.reports = [];
});

describe("reportDeployFailure (apps-deploy onFailure)", () => {
  it("uses the stage recorded for THIS commit — the silent bindings failure", async () => {
    state.project = {
      lastDeployError: {
        sha: target.sha,
        stage: "bindings",
        message: "Name call_source not found inside calls at [12:3] (HTTP 400)",
      },
    };
    await reportDeployFailure(target, new Error("wrapped by inngest"));
    expect(state.reports).toEqual([
      {
        ...target,
        state: "failure",
        description:
          "bindings failed: Name call_source not found inside calls at [12:3] (HTTP 400)",
      },
    ]);
  });

  it("falls back to the error Inngest reports when the recorded failure is another commit's", async () => {
    state.project = {
      lastDeployError: { sha: "d".repeat(40), stage: "build", message: "old" },
    };
    await reportDeployFailure(target, new Error("fatal: Not a valid object"));
    expect(state.reports[0]).toMatchObject({
      state: "failure",
      description: "deploy failed: fatal: Not a valid object",
    });
  });
});
