/**
 * Deploy outcomes as GitHub commit statuses. Real Mongo (the per-commit
 * ledger's compare-and-set is the point) and a real git repo (ancestry
 * decides what "superseded" means); GitHub, auth and realtime are stubbed.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const state = vi.hoisted(() => ({
  repoDir: "",
  target: null as null | {
    kind: "connected";
    owner: string;
    repo: string;
    installationId?: number;
  },
  token: "ghs_token" as string | undefined,
  postError: null as Error | null,
  project: null as null | {
    _id: { toString(): string };
    workspaceId: { toString(): string };
    path: string;
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
  repoForWorkspace: vi.fn(async () => state.repoDir),
  resolveProjectRef: vi.fn(async () => state.project),
}));

import {
  AppDeployCommitStatus,
  AppProject,
} from "../database/workspace-schema";
import {
  appDeployStatusContext,
  describeDeployFailure,
  describeDeployOutcome,
  reportAppDeployStatus,
  resetDeployStatusWarningsForTest,
} from "./deploy-commit-status";

const WS = new Types.ObjectId().toString();
const APP = new Types.ObjectId().toString();

let mongo: MongoMemoryServer;
let tmp: string;
/** main: C1 → C2 → C3; SIDE forks from C1 (neither ancestor nor descendant of C3). */
const commits = { C1: "", C2: "", C3: "", SIDE: "" };

function git(...args: string[]): string {
  return execFileSync("git", ["-C", state.repoDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function commit(message: string): string {
  git("commit", "-q", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-status-"));
  state.repoDir = tmp;
  git("init", "-q", "-b", "main");
  commits.C1 = commit("c1");
  commits.C2 = commit("c2");
  commits.C3 = commit("c3");
  git("checkout", "-q", "-b", "side", commits.C1);
  commits.SIDE = commit("side");
  git("checkout", "-q", "main");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
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
  state.events = [];
  process.env.CLIENT_URL = "https://app.mako.ai/";
  resetDeployStatusWarningsForTest();
  await Promise.all([
    AppDeployCommitStatus.deleteMany({}),
    AppProject.deleteMany({}),
  ]);
});

function report(
  sha: string,
  status: "pending" | "success" | "failure",
  description = status,
) {
  return reportAppDeployStatus({
    workspaceId: WS,
    appRef: APP,
    sha,
    state: status,
    description,
  });
}

async function ledger(sha: string) {
  return (
    await AppDeployCommitStatus.findOne({ workspaceId: WS, appId: APP, sha })
      .select("state")
      .lean()
  )?.state;
}

const posted = () =>
  state.posts.map(p => [p.sha, p.params.state, p.params.description]);

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
    const result = await report(
      commits.C1,
      "failure",
      "bindings failed: Name call_source not found",
    );
    expect(result).toEqual({ posted: true });
    expect(state.posts).toEqual([
      {
        owner: "realadvisor",
        repo: "mako-workspace",
        sha: commits.C1,
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

  it("pokes open windows on a final outcome, not on pending", async () => {
    await report(commits.C1, "pending");
    expect(state.events).toEqual([]);
    await report(commits.C1, "failure");
    expect(state.events).toEqual([
      {
        workspaceId: WS,
        event: { type: "app.updated", appId: APP, origin: "deploy" },
      },
    ]);
  });

  it("records pending, then the outcome, per commit", async () => {
    await report(commits.C1, "pending");
    expect(await ledger(commits.C1)).toBe("pending");
    await report(commits.C1, "success");
    expect(await ledger(commits.C1)).toBe("success");
  });

  it("resolves a commit a cancelled run left pending once a DESCENDANT deploys", async () => {
    await report(commits.C1, "pending");
    state.posts = [];
    await report(commits.C3, "pending");
    expect(posted()).toEqual([
      [
        commits.C1,
        "success",
        `Skipped: superseded by ${commits.C3.slice(0, 7)}`,
      ],
      [commits.C3, "pending", "pending"],
    ]);
    expect(await ledger(commits.C1)).toBe("superseded");
  });

  // Review finding 1: a folder-only app has no row when its first deploy
  // starts; the ledger does not need one.
  it("resolves the first commit of an app that has no row yet", async () => {
    expect(await AppProject.countDocuments({})).toBe(0);
    await report(commits.C1, "pending");
    state.posts = [];
    await report(commits.C2, "pending");
    expect(posted()[0]).toEqual([
      commits.C1,
      "success",
      `Skipped: superseded by ${commits.C2.slice(0, 7)}`,
    ]);
  });

  // Review finding 2: onFailure runs separately; the next run must never
  // turn a failed commit green.
  it("never marks a commit superseded after its own failure was recorded", async () => {
    await report(commits.C1, "pending");
    await report(commits.C1, "failure", "bindings failed: x");
    state.posts = [];
    await report(commits.C2, "pending");
    expect(posted()).toEqual([[commits.C2, "pending", "pending"]]);
    expect(await ledger(commits.C1)).toBe("failure");
  });

  it("loses the race to a failure recorded while it was resolving (compare-and-set)", async () => {
    await report(commits.C1, "pending");
    state.posts = [];
    // The failure lands between the resolver reading "pending" and its CAS.
    const find = AppDeployCommitStatus.findOneAndUpdate.bind(
      AppDeployCommitStatus,
    );
    const spy = vi
      .spyOn(AppDeployCommitStatus, "findOneAndUpdate")
      .mockImplementationOnce(((...args: Parameters<typeof find>) =>
        AppDeployCommitStatus.updateOne(
          { workspaceId: WS, appId: APP, sha: commits.C1 },
          { $set: { state: "failure" } },
        ).then(() => find(...args))) as unknown as typeof find);
    await report(commits.C2, "pending");
    spy.mockRestore();
    expect(posted()).toEqual([[commits.C2, "pending", "pending"]]);
    expect(await ledger(commits.C1)).toBe("failure");
  });

  it("lets a run's own failure win over a superseded mark that got there first", async () => {
    await report(commits.C1, "pending");
    await report(commits.C2, "pending");
    expect(await ledger(commits.C1)).toBe("superseded");
    state.posts = [];
    await report(commits.C1, "failure", "build failed: x");
    expect(posted()).toEqual([[commits.C1, "failure", "build failed: x"]]);
    expect(await ledger(commits.C1)).toBe("failure");
  });

  // Review finding 3: a stale or redelivered event for an OLDER commit must
  // not mark the newer pending commit superseded.
  it("leaves a NEWER pending commit alone when an older commit's deploy starts", async () => {
    await report(commits.C3, "pending");
    state.posts = [];
    await report(commits.C1, "pending");
    expect(posted()).toEqual([[commits.C1, "pending", "pending"]]);
    expect(await ledger(commits.C3)).toBe("pending");
  });

  it("leaves an unrelated pending commit alone (not an ancestor)", async () => {
    await report(commits.SIDE, "pending");
    state.posts = [];
    await report(commits.C3, "pending");
    expect(posted()).toEqual([[commits.C3, "pending", "pending"]]);
    expect(await ledger(commits.SIDE)).toBe("pending");
  });

  // Review finding 4: cancelled after going live, before its final report.
  it("calls a pending commit that is LIVE 'Live', not 'Skipped'", async () => {
    await AppProject.collection.insertOne({
      _id: new Types.ObjectId(APP),
      workspaceId: new Types.ObjectId(WS),
      publishedSha: commits.C1,
    });
    await report(commits.C1, "pending");
    state.posts = [];
    await report(commits.C2, "pending");
    expect(posted()[0]).toEqual([
      commits.C1,
      "success",
      "Live: this commit is deployed",
    ]);
    expect(await ledger(commits.C1)).toBe("success");
  });

  it("never writes to a repo when connected-repo writes are off (previews, laptops)", async () => {
    state.target = null;
    expect(await report(commits.C1, "failure")).toEqual({
      posted: false,
      reason: "no-connected-repo",
    });
    expect(state.posts).toEqual([]);
  });

  it("skips quietly without a token", async () => {
    state.token = undefined;
    expect(await report(commits.C1, "pending")).toEqual({
      posted: false,
      reason: "no-token",
    });
  });

  it("never throws when the GitHub App lacks Commit statuses permission", async () => {
    state.postError = new Error(
      'GitHub 403 on /repos/realadvisor/mako-workspace/statuses/aaa (no write access — the token/installation lacks permission): {"message":"Resource not accessible by integration"}',
    );
    expect(await report(commits.C1, "failure")).toEqual({
      posted: false,
      reason: "permission",
    });
  });

  it("never throws on any other failure either", async () => {
    state.postError = new Error("fetch failed");
    await expect(report(commits.C1, "success")).resolves.toEqual({
      posted: false,
      reason: "error",
    });
  });

  it("reports nothing for an app it cannot resolve", async () => {
    state.project = null;
    expect(await report(commits.C1, "success")).toEqual({
      posted: false,
      reason: "app-not-found",
    });
    expect(state.posts).toEqual([]);
  });
});
