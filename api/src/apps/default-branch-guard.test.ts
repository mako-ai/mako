/**
 * The default-branch guard and the merge request behind it.
 *
 * On 19 Nov 2026 two agents used MCP write tools and committed unreviewed
 * changes straight to a workspace's main (4 dbt files at 22:19 UTC, 11 commits
 * at 22:48 to 22:58 UTC). What must hold:
 *
 *   SCOPE     — the guard binds only inside runUnderDefaultBranchGuard (MCP),
 *               follows the workspace setting (default on), and never reaches
 *               the in-app agent's calls.
 *   BRANCH    — a guarded dbt caller's branch is `mcp/<person>/dbt`, one per
 *               person and family.
 *   REFUSAL   — the message names the branch and the merge tool.
 *   MERGE     — a merge request runs the check each kind of change calls for,
 *               stops on a failure, opens a pull request on a mirrored repo
 *               (main never moves), and merges directly only without one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { Workspace } from "../database/workspace-schema";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  resolveCommit,
  updateRefCas,
} from "./repository.service";
import { ZERO_OID } from "./git";
import { seededTemplateFiles } from "./workspace-template";
import {
  DefaultBranchWriteRefusedError,
  MCP_BRANCH_PREFIX,
  MERGE_TOOL_FOR_KIND,
  activeDefaultBranchGuard,
  assertNotDefaultBranchWrite,
  defaultBranchWriteRefusal,
  guardBranchName,
  isDefaultBranchProtected,
  runUnderDefaultBranchGuard,
} from "./default-branch-guard";
import { commitBranchFor, guardBranchFor } from "./branch-policy";
import {
  openMergeRequest,
  type MergeCheckResult,
  type MergeRequestDeps,
} from "./merge-request.service";
import type { MirrorTarget } from "./cloud-repo.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const USER = "user-1";

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-guard-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await Workspace.deleteMany({});
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
});

const guarded = <T>(fn: () => Promise<T>) =>
  runUnderDefaultBranchGuard({ workspaceId: WS, userId: USER }, fn);

describe("guard scope and setting", () => {
  it("is on for a guarded call and off outside the scope", async () => {
    expect(await activeDefaultBranchGuard(WS)).toBeNull();
    expect(await guarded(() => activeDefaultBranchGuard(WS))).toEqual({
      userId: USER,
    });
  });

  it("ignores a scope opened for another workspace", async () => {
    const other = new Types.ObjectId().toString();
    const seen = await runUnderDefaultBranchGuard(
      { workspaceId: other, userId: USER },
      () => activeDefaultBranchGuard(WS),
    );
    expect(seen).toBeNull();
  });

  it("is on by default and off when an admin sets protectDefaultBranch false", async () => {
    expect(await isDefaultBranchProtected(WS)).toBe(true);
    await Workspace.updateOne(
      { _id: new Types.ObjectId(WS) },
      { $set: { "settings.protectDefaultBranch": false } },
    );
    expect(await isDefaultBranchProtected(WS)).toBe(false);
    expect(await guarded(() => activeDefaultBranchGuard(WS))).toBeNull();
  });
});

describe("guard branch", () => {
  it("names one branch per person and family", () => {
    expect(guardBranchName("joan", "dbt")).toBe("mcp/joan/dbt");
    expect(guardBranchName("joan", "flows")).toBe("mcp/joan/flows");
    expect(guardBranchName("Joan R.", "app", "sales-report")).toBe(
      "mcp/joan-r/app/sales-report",
    );
    expect(guardBranchName("joan", "dbt").startsWith(MCP_BRANCH_PREFIX)).toBe(
      true,
    );
  });

  it("sends a guarded dbt write to the guard branch, an unguarded one to main", async () => {
    // Today's behaviour, for the in-app agent and people in the editor.
    expect(await commitBranchFor("dbt", WS, USER)).toBe(DEFAULT_BRANCH);
    const branch = await guarded(() => commitBranchFor("dbt", WS, USER));
    expect(branch).toBe(await guardBranchFor(WS, USER, "dbt"));
    expect(branch).not.toBe(DEFAULT_BRANCH);
    expect(branch.startsWith("mcp/")).toBe(true);
  });

  it("keeps consoles and skills on main: their rows derive from it", async () => {
    expect(await guarded(() => commitBranchFor("console", WS, USER))).toBe(
      DEFAULT_BRANCH,
    );
  });
});

describe("refusal", () => {
  it("names the branch and the merge tool", () => {
    expect(defaultBranchWriteRefusal("mcp/joan/dbt", "dbt_merge_to_main")).toBe(
      "Writes go to branch mcp/joan/dbt. Open a merge with dbt_merge_to_main.",
    );
  });

  it("refuses a guarded write that still resolves to main", async () => {
    await guarded(async () => {
      await expect(
        assertNotDefaultBranchWrite({
          workspaceId: WS,
          branch: DEFAULT_BRANCH,
          guardBranch: "mcp/user-1/dbt",
          mergeTool: MERGE_TOOL_FOR_KIND.dbt,
        }),
      ).rejects.toThrow(
        "Writes go to branch mcp/user-1/dbt. Open a merge with dbt_merge_to_main.",
      );
      await expect(
        assertNotDefaultBranchWrite({
          workspaceId: WS,
          branch: "mcp/user-1/dbt",
          guardBranch: "mcp/user-1/dbt",
          mergeTool: MERGE_TOOL_FOR_KIND.dbt,
        }),
      ).resolves.toBeUndefined();
    });
    // Unguarded callers are not refused.
    await expect(
      assertNotDefaultBranchWrite({
        workspaceId: WS,
        branch: DEFAULT_BRANCH,
        guardBranch: "x",
        mergeTool: "t",
      }),
    ).resolves.toBeUndefined();
    expect(new DefaultBranchWriteRefusedError("b", "t").branch).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// Merge request
// ---------------------------------------------------------------------------

async function branchWith(branch: string, writes: Record<string, string>) {
  const repoDir = repoDirFor(WS);
  const main = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!(await resolveCommit(repoDir, `refs/heads/${branch}`))) {
    await updateRefCas(repoDir, `refs/heads/${branch}`, main!, ZERO_OID);
  }
  await commitBlobsOnBranch(repoDir, branch, { writes }, { message: "test" });
}

const mainHead = () =>
  resolveCommit(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`);

type Runners = MergeRequestDeps["checks"];
function fakeDeps(over: Partial<MergeRequestDeps> = {}) {
  const passed = (name: string): MergeCheckResult => ({
    name,
    status: "passed",
  });
  const base = {
    checks: {
      dbtParse: vi.fn(async (_ctx: Parameters<Runners["dbtParse"]>[0]) =>
        passed("dbt parse"),
      ),
      flowFiles: vi.fn(async (_ctx: Parameters<Runners["flowFiles"]>[0]) =>
        passed("check_flow_files"),
      ),
      appBuild: vi.fn(async (_ctx: Parameters<Runners["appBuild"]>[0]) =>
        passed("app build"),
      ),
    },
    mirror: vi.fn(async (_workspaceId: string) => null as MirrorTarget | null),
    openPullRequest: vi.fn(
      async (_input: Parameters<MergeRequestDeps["openPullRequest"]>[0]) => ({
        number: 7,
        url: "https://github.com/test-owner/test-repo/pull/7",
        existing: false,
      }),
    ),
    merge: vi.fn(async (_input: Parameters<MergeRequestDeps["merge"]>[0]) => ({
      merged: true,
      commitOid: "abc",
    })),
  };
  return Object.assign(base, over) as typeof base;
}

const MIRROR = {
  kind: "connected",
  owner: "test-owner",
  repo: "test-repo",
} as const;

describe("openMergeRequest", () => {
  it("reports nothing to merge for a branch with no changes or no ref", async () => {
    const deps = fakeDeps();
    expect(
      await openMergeRequest(
        { workspaceId: WS, branch: "mcp/user-1/dbt" },
        deps,
      ),
    ).toEqual({ status: "nothing_to_merge", branch: "mcp/user-1/dbt" });
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("runs dbt parse for dbt files and opens a pull request on a mirrored repo, leaving main alone", async () => {
    await branchWith("mcp/user-1/dbt", {
      "dbt/models/stg_stripe.sql": "select 1\n",
    });
    const before = await mainHead();
    const deps = fakeDeps({ mirror: vi.fn(async () => MIRROR) });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/dbt", userId: USER },
      deps,
    );
    expect(outcome.status).toBe("pull_request");
    expect(deps.checks.dbtParse).toHaveBeenCalledTimes(1);
    expect(deps.checks.flowFiles).not.toHaveBeenCalled();
    expect(deps.checks.appBuild).not.toHaveBeenCalled();
    expect(deps.openPullRequest).toHaveBeenCalledTimes(1);
    expect(deps.merge).not.toHaveBeenCalled();
    expect(await mainHead()).toBe(before);
    const call = deps.openPullRequest.mock.calls[0][0];
    expect(call.body).toContain("dbt/models/stg_stripe.sql");
  });

  it("stops on a failed dbt parse: no pull request, no merge", async () => {
    await branchWith("mcp/user-1/dbt", { "dbt/models/bad.sql": "select {{\n" });
    const deps = fakeDeps({
      mirror: vi.fn(async () => MIRROR),
      checks: {
        ...fakeDeps().checks,
        dbtParse: vi.fn(async () => ({
          name: "dbt parse",
          status: "failed" as const,
          detail: "Jinja error",
        })),
      },
    });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/dbt" },
      deps,
    );
    expect(outcome.status).toBe("checks_failed");
    expect(deps.openPullRequest).not.toHaveBeenCalled();
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it("reports pending while dbt parse still runs and merges nothing", async () => {
    await branchWith("mcp/user-1/dbt", { "dbt/models/x.sql": "select 1\n" });
    const deps = fakeDeps({
      checks: {
        ...fakeDeps().checks,
        dbtParse: vi.fn(async () => ({
          name: "dbt parse",
          status: "pending" as const,
          runId: "run-1",
        })),
      },
    });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/dbt" },
      deps,
    );
    expect(outcome.status).toBe("checks_pending");
    expect(deps.merge).not.toHaveBeenCalled();
    expect(deps.openPullRequest).not.toHaveBeenCalled();
  });

  it("merges directly when no GitHub repo is mirrored", async () => {
    await branchWith("mcp/user-1/dbt", { "dbt/models/x.sql": "select 1\n" });
    const deps = fakeDeps();
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/dbt", userId: USER },
      deps,
    );
    expect(outcome.status).toBe("merged");
    expect(deps.merge).toHaveBeenCalledWith({
      workspaceId: WS,
      branch: "mcp/user-1/dbt",
      userId: USER,
    });
  });

  it("passes the changed flow files and deletions to check_flow_files", async () => {
    await branchWith("mcp/user-1/flows", {
      "flows/stripe.yml": "name: Stripe\n",
    });
    const deps = fakeDeps({ mirror: vi.fn(async () => MIRROR) });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/flows" },
      deps,
    );
    expect(outcome.status).toBe("pull_request");
    expect(deps.checks.dbtParse).not.toHaveBeenCalled();
    expect(deps.checks.flowFiles).toHaveBeenCalledTimes(1);
    const ctx = deps.checks.flowFiles.mock.calls[0][0];
    expect(ctx.files).toEqual([
      { path: "flows/stripe.yml", contents: "name: Stripe\n" },
    ]);
    expect(ctx.deletedPaths).toEqual([]);
  });

  it("builds each changed app", async () => {
    await branchWith("mcp/user-1/app/sales", {
      "apps/sales/src/App.tsx": "export {}\n",
      "apps/other/src/App.tsx": "export {}\n",
    });
    const deps = fakeDeps({ mirror: vi.fn(async () => MIRROR) });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/app/sales" },
      deps,
    );
    expect(outcome.status).toBe("pull_request");
    expect(
      deps.checks.appBuild.mock.calls.map(c => c[0].appRoot).sort(),
    ).toEqual(["apps/other", "apps/sales"]);
  });

  it("stops on a failed app build", async () => {
    await branchWith("mcp/user-1/app/sales", {
      "apps/sales/src/App.tsx": "export {\n",
    });
    const deps = fakeDeps({
      mirror: vi.fn(async () => MIRROR),
      checks: {
        ...fakeDeps().checks,
        appBuild: vi.fn(async () => ({
          name: "app build",
          status: "failed" as const,
          detail: "vite build failed",
        })),
      },
    });
    const outcome = await openMergeRequest(
      { workspaceId: WS, branch: "mcp/user-1/app/sales" },
      deps,
    );
    expect(outcome.status).toBe("checks_failed");
    expect(deps.openPullRequest).not.toHaveBeenCalled();
  });
});
