import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  target: {
    kind: "connected",
    owner: "realadvisor",
    repo: "mako-workspace",
    installationId: 42,
  } as null | {
    kind: "connected";
    owner: string;
    repo: string;
    installationId?: number;
  },
  token: "ghs_token" as string | undefined,
  postError: null as Error | null,
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    path: "apps/sales/calls",
    deployStatusPendingSha: undefined as string | undefined,
  } as null | {
    _id: { toString(): string };
    workspaceId: { toString(): string };
    path: string;
    deployStatusPendingSha?: string;
  },
  posts: [] as Array<{
    owner: string;
    repo: string;
    sha: string;
    params: {
      state: string;
      description: string;
      context?: string;
      targetUrl?: string;
    };
    token?: string;
  }>,
  updates: [] as Array<{ filter: unknown; update: unknown }>,
  events: [] as Array<{ workspaceId: string; event: unknown }>,
}));

vi.mock("../integrations/github/github-api", () => ({
  postCommitStatus: vi.fn(
    async (
      owner: string,
      repo: string,
      sha: string,
      params: (typeof state.posts)[number]["params"],
      token?: string,
    ) => {
      if (state.postError) throw state.postError;
      state.posts.push({ owner, repo, sha, params, token });
    },
  ),
}));

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => state.token),
}));

vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn((workspaceId: string, event: unknown) =>
    state.events.push({ workspaceId, event }),
  ),
}));

vi.mock("./cloud-repo.service", () => ({
  resolveMirrorTarget: vi.fn(async () => state.target),
}));

vi.mock("./worktree.service", () => ({
  appRootFor: vi.fn((p: { path: string }) => p.path),
  resolveProjectRef: vi.fn(async () => state.project),
}));

vi.mock("../database/workspace-schema", () => ({
  AppProject: {
    updateOne: vi.fn(async (filter: unknown, update: unknown) => {
      state.updates.push({ filter, update });
      return { matchedCount: 1 };
    }),
  },
}));

import {
  appDeployStatusContext,
  describeDeployFailure,
  describeDeployOutcome,
  reportAppDeployStatus,
  resetDeployStatusWarningsForTest,
} from "./deploy-commit-status";

const WS = "6a9411eb4c8b33609a65e666";
const APP = "6a9411eb4c8b33609a65e665";
const SHA = "a".repeat(40);
const OLDER = "b".repeat(40);

beforeEach(() => {
  state.target = {
    kind: "connected",
    owner: "realadvisor",
    repo: "mako-workspace",
    installationId: 42,
  };
  state.token = "ghs_token";
  state.postError = null;
  state.project = {
    _id: { toString: () => APP },
    workspaceId: { toString: () => WS },
    path: "apps/sales/calls",
  };
  state.posts = [];
  state.updates = [];
  state.events = [];
  process.env.CLIENT_URL = "https://app.mako.ai/";
  resetDeployStatusWarningsForTest();
});

describe("describeDeployFailure", () => {
  it("leads with the stage and the error line — the bindings failure that went unnoticed", () => {
    expect(
      describeDeployFailure(
        "bindings",
        'Binding "calls" failed: Name call_source not found inside calls at [3:5] (HTTP 400)\n    at BigQuery.query',
      ),
    ).toBe(
      'bindings failed: Binding "calls" failed: Name call_source not found inside calls at [3:5] (HTTP 400)',
    );
  });

  it("finds the error in a build log tail instead of quoting its first line", () => {
    const tail = [
      "…ules/.bin/vite build --base=./",
      "transforming...",
      "✓ 41 modules transformed.",
      "error during build:",
      '[vite]: Rollup failed to resolve import "d3" from "src/App.tsx".',
    ].join("\n");
    expect(describeDeployFailure("build", tail)).toBe(
      'build failed: error during build: [vite]: Rollup failed to resolve import "d3" from "src/App.tsx".',
    );
  });

  it("fits GitHub's 140-character description limit", () => {
    const text = describeDeployFailure(
      "bindings",
      `failed: ${"x".repeat(500)}`,
    );
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("describeDeployOutcome", () => {
  it("reports built and already-built commits as live", () => {
    expect(describeDeployOutcome("built").state).toBe("success");
    expect(describeDeployOutcome("already-built").state).toBe("success");
  });

  it("resolves a superseded or gone deploy rather than leaving it pending", () => {
    expect(describeDeployOutcome("superseded").state).toBe("success");
    expect(describeDeployOutcome("gone").state).toBe("success");
  });
});

describe("reportAppDeployStatus", () => {
  it("posts one status per app on the pushed sha, linking to the app", async () => {
    const result = await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "failure",
      description: "bindings failed: Name call_source not found",
    });
    expect(result).toEqual({ posted: true });
    expect(state.posts).toEqual([
      {
        owner: "realadvisor",
        repo: "mako-workspace",
        sha: SHA,
        params: {
          state: "failure",
          description: "bindings failed: Name call_source not found",
          context: appDeployStatusContext("apps/sales/calls"),
          targetUrl: `https://app.mako.ai/apps/${APP}`,
        },
        token: "ghs_token",
      },
    ]);
    expect(state.posts[0].params.context).toBe(
      "mako/app-deploy: apps/sales/calls",
    );
  });

  it("pokes open windows on a final outcome so the published chip shows the error", async () => {
    await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "failure",
      description: "build failed",
    });
    expect(state.events).toEqual([
      {
        workspaceId: WS,
        event: { type: "app.updated", appId: APP, origin: "deploy" },
      },
    ]);
  });

  it("does not poke windows for pending (nothing they show changed yet)", async () => {
    await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "pending",
      description: "Deploying this commit",
    });
    expect(state.events).toEqual([]);
  });

  it("remembers the pending commit and clears it once resolved", async () => {
    await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "pending",
      description: "Deploying this commit",
    });
    expect(state.updates.at(-1)?.update).toEqual({
      $set: { deployStatusPendingSha: SHA },
    });
    await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "success",
      description: "Live",
    });
    expect(state.updates.at(-1)).toEqual({
      filter: expect.objectContaining({ deployStatusPendingSha: SHA }),
      update: { $unset: { deployStatusPendingSha: 1 } },
    });
  });

  it("resolves the commit a cancelled run left pending when a newer deploy starts", async () => {
    if (state.project) state.project.deployStatusPendingSha = OLDER;
    await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "pending",
      description: "Deploying this commit",
    });
    expect(state.posts.map(p => [p.sha, p.params.state])).toEqual([
      [OLDER, "success"],
      [SHA, "pending"],
    ]);
    expect(state.posts[0].params.description).toBe(
      `Skipped: superseded by ${SHA.slice(0, 7)}`,
    );
  });

  it("never writes to a repo when connected-repo writes are off (previews, laptops)", async () => {
    state.target = null;
    const result = await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "failure",
      description: "build failed",
    });
    expect(result).toEqual({ posted: false, reason: "no-connected-repo" });
    expect(state.posts).toEqual([]);
  });

  it("skips quietly without a token", async () => {
    state.token = undefined;
    const result = await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "pending",
      description: "Deploying this commit",
    });
    expect(result).toEqual({ posted: false, reason: "no-token" });
  });

  it("never throws when the GitHub App lacks Commit statuses permission", async () => {
    state.postError = new Error(
      'GitHub 403 on /repos/realadvisor/mako-workspace/statuses/aaa (no write access — the token/installation lacks permission): {"message":"Resource not accessible by integration"}',
    );
    const result = await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "failure",
      description: "build failed",
    });
    expect(result).toEqual({ posted: false, reason: "permission" });
  });

  it("never throws on any other failure either", async () => {
    state.postError = new Error("fetch failed");
    await expect(
      reportAppDeployStatus({
        workspaceId: WS,
        appRef: APP,
        sha: SHA,
        state: "success",
        description: "Live",
      }),
    ).resolves.toEqual({ posted: false, reason: "error" });
  });

  it("reports nothing for an app it cannot resolve", async () => {
    state.project = null;
    const result = await reportAppDeployStatus({
      workspaceId: WS,
      appRef: APP,
      sha: SHA,
      state: "success",
      description: "Live",
    });
    expect(result).toEqual({ posted: false, reason: "app-not-found" });
    expect(state.posts).toEqual([]);
  });
});
