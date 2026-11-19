/**
 * dbt tools for a guarded MCP/API-key caller (apps/default-branch-guard.ts).
 *
 * On 19 Nov 2026 22:19 UTC an agent committed 4 dbt Stripe files to the
 * workspace repo's main, and between 22:48 and 22:58 UTC another made 11
 * commits on a dbt model, a yml, a test and a dbt_project var. Nothing was
 * reviewed or checked. What must hold, with a real bare repo and real Mongo:
 *
 *   BRANCH   — create/modify/edit/delete write to `mcp/<person>/dbt`; main
 *              keeps its head through 11 edits.
 *   READS    — the same caller reads its own edits back.
 *   BUILDS   — dbt_parse builds that branch, for a member too.
 *   NO LEAK  — outside the guard scope (the in-app agent) and with the
 *              setting off, writes still land on the session branch (main).
 *   REFUSAL  — project and job tools, which have no branch, say so.
 *   MERGE    — dbt_merge_to_main opens the merge request for that branch.
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

const mocks = vi.hoisted(() => ({
  openMergeRequest: vi.fn(),
  triggerDbtRun: vi.fn(),
}));

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "member" })),
    getMembers: vi.fn(async () => []),
  },
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  loadDbtDeferState: vi.fn(async () => undefined),
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  triggerDbtRun: mocks.triggerDbtRun,
  triggerDbtJobRun: vi.fn(),
  requestDbtRunCancel: vi.fn(),
  reconcileStaleQueuedRun: vi.fn(async (run: unknown) => run),
  applyJobScheduleChange: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));
vi.mock("../../apps/merge-request.service", () => ({
  openMergeRequest: mocks.openMergeRequest,
}));

import { createDbtServerTools } from "./dbt-tools";
import {
  AppWorktree,
  DbtProject,
  Workspace,
} from "../../database/workspace-schema";
import { seedDbtGitTree } from "../../dbt/test-support/git-tree";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { runUnderDefaultBranchGuard } from "../../apps/default-branch-guard";
import { guardBranchFor } from "../../apps/branch-policy";
import {
  DEFAULT_BRANCH,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const USER = "u1";
const tools = createDbtServerTools(WS, USER, { chatId: "chat1" });
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-merge-guard-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([DbtProject.deleteMany({}), AppWorktree.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await bindTestWorkspaceRepo(WS);
  await Workspace.updateOne(
    { _id: new Types.ObjectId(WS) },
    { $unset: { "settings.protectDefaultBranch": 1 } },
  );
});

async function seedProject() {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "dbt_dev", threads: 4 },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  await seedDbtGitTree(WS, {
    "dbt_project.yml": "name: analytics\n",
    "models/stg_orders.sql": "select 1\n",
  });
  return project;
}

type Result = Record<string, unknown> & { success: boolean; error?: string };
const run = (name: string, input: object): Promise<Result> =>
  (tools as unknown as Record<string, { execute: (i: object) => unknown }>)[
    name
  ].execute(input) as Promise<Result>;
const guarded = <T>(fn: () => Promise<T>) =>
  runUnderDefaultBranchGuard({ workspaceId: WS, userId: USER }, fn);

async function blobOn(ref: string, rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), ref, `dbt/${rel}`);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}
const mainHead = () => resolveCommit(repoDirFor(WS), MAIN);

describe("dbt writes for a guarded caller", () => {
  it("create_dbt_file commits to mcp/<person>/dbt and leaves main alone", async () => {
    const project = await seedProject();
    const before = await mainHead();
    const branch = await guardBranchFor(WS, USER, "dbt");
    const result = await guarded(() =>
      run("create_dbt_file", {
        projectId: project._id.toString(),
        path: "models/stg_stripe.sql",
        contents: "select 2\n",
      }),
    );
    expect(result.success, result.error).toBe(true);
    expect(result.branch).toBe(branch);
    expect(result.next).toBe(
      `Written to branch ${branch}, not the default branch. Verify with dbt_parse, then open a merge with dbt_merge_to_main.`,
    );
    expect(await blobOn(`refs/heads/${branch}`, "models/stg_stripe.sql")).toBe(
      "select 2\n",
    );
    expect(await blobOn(MAIN, "models/stg_stripe.sql")).toBeNull();
    expect(await mainHead()).toBe(before);
  });

  it("keeps main's head through 11 edits, modifies and deletes", async () => {
    const project = await seedProject();
    const before = await mainHead();
    const projectId = project._id.toString();
    await guarded(async () => {
      for (let i = 0; i < 8; i++) {
        const edit = await run("edit_dbt_file", {
          projectId,
          path: "models/stg_orders.sql",
          oldString: `select ${i + 1}`,
          newString: `select ${i + 2}`,
        });
        expect(edit.success, edit.error).toBe(true);
      }
      expect(
        (
          await run("modify_dbt_file", {
            projectId,
            path: "models/stg_orders.sql",
            contents: "select 99\n",
          })
        ).success,
      ).toBe(true);
      expect(
        (
          await run("create_dbt_file", {
            projectId,
            path: "tests/t.sql",
            contents: "select 1\n",
          })
        ).success,
      ).toBe(true);
      expect(
        (await run("delete_dbt_file", { projectId, path: "tests/t.sql" }))
          .success,
      ).toBe(true);
    });
    expect(await mainHead()).toBe(before);
    expect(await blobOn(MAIN, "models/stg_orders.sql")).toBe("select 1\n");
    const branch = await guardBranchFor(WS, USER, "dbt");
    expect(await blobOn(`refs/heads/${branch}`, "models/stg_orders.sql")).toBe(
      "select 99\n",
    );
    expect(await blobOn(`refs/heads/${branch}`, "tests/t.sql")).toBeNull();
  });

  it("reads its own edits back, while an unguarded read sees main", async () => {
    const project = await seedProject();
    const projectId = project._id.toString();
    await guarded(() =>
      run("create_dbt_file", {
        projectId,
        path: "models/a.sql",
        contents: "a\n",
      }),
    );
    const guardedRead = await guarded(() =>
      run("read_dbt_file", { projectId, path: "models/a.sql" }),
    );
    expect(guardedRead.contents).toBe("a\n");
    const unguardedRead = await run("read_dbt_file", {
      projectId,
      path: "models/a.sql",
    });
    expect(unguardedRead.success).toBe(false);
  });

  it("dbt_parse builds the guard branch, for a member with no working tree", async () => {
    const project = await seedProject();
    const projectId = project._id.toString();
    mocks.triggerDbtRun.mockResolvedValue({
      _id: new Types.ObjectId(),
      status: "queued",
      environment: "dev",
      commands: ["parse"],
    });
    await guarded(async () => {
      await run("create_dbt_file", {
        projectId,
        path: "models/a.sql",
        contents: "a\n",
      });
      const parse = await run("dbt_parse", { projectId });
      expect(parse.success, parse.error).toBe(true);
    });
    const branch = await guardBranchFor(WS, USER, "dbt");
    const args = mocks.triggerDbtRun.mock.calls[0][0];
    expect(args.gitBranch).toBe(branch);
    expect(args.workingTreeUserId).toBeUndefined();
  });
});

describe("callers that keep direct writes", () => {
  it("writes to the session branch outside the guard scope (the in-app agent)", async () => {
    const project = await seedProject();
    const result = await run("create_dbt_file", {
      projectId: project._id.toString(),
      path: "models/direct.sql",
      contents: "select 3\n",
    });
    expect(result.success, result.error).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(await blobOn(MAIN, "models/direct.sql")).toBe("select 3\n");
  });

  it("writes to main inside the scope when an admin turned protection off", async () => {
    const project = await seedProject();
    await Workspace.updateOne(
      { _id: new Types.ObjectId(WS) },
      { $set: { "settings.protectDefaultBranch": false } },
    );
    const result = await guarded(() =>
      run("create_dbt_file", {
        projectId: project._id.toString(),
        path: "models/direct.sql",
        contents: "select 3\n",
      }),
    );
    expect(result.success, result.error).toBe(true);
    expect(await blobOn(MAIN, "models/direct.sql")).toBe("select 3\n");
  });
});

describe("tools with no branch to wait on", () => {
  it.each([
    ["dbt_create_project", { name: "x", connectionId: String(CONN) }],
    ["dbt_create_job", { projectId: "p", name: "j", commands: ["build"] }],
    ["dbt_update_job", { projectId: "p", jobId: "j" }],
    ["dbt_delete_job", { projectId: "p", jobId: "j" }],
  ])("%s refuses for a guarded caller", async (name, input) => {
    const result = await guarded(() => run(name, input));
    expect(result.success).toBe(false);
    expect(result.error).toContain(`${name} writes to the default branch`);
    expect(result.error).toContain("turn off default-branch protection");
  });
});

describe("dbt_merge_to_main", () => {
  it("opens the merge request for the caller's dbt branch", async () => {
    await seedProject();
    mocks.openMergeRequest.mockResolvedValue({
      status: "pull_request",
      pullRequest: { number: 5, url: "https://github.com/o/r/pull/5" },
    });
    const branch = await guardBranchFor(WS, USER, "dbt");
    const result = await guarded(() => run("dbt_merge_to_main", {}));
    expect(result.success).toBe(true);
    expect(mocks.openMergeRequest).toHaveBeenCalledWith({
      workspaceId: WS,
      branch,
      userId: USER,
    });
  });

  it("reports a failed check as not merged", async () => {
    await seedProject();
    mocks.openMergeRequest.mockResolvedValue({ status: "checks_failed" });
    const result = await guarded(() => run("dbt_merge_to_main", {}));
    expect(result.success).toBe(false);
    expect(result.status).toBe("checks_failed");
  });

  it("has nothing to merge for a caller already on the default branch", async () => {
    await seedProject();
    const result = await run("dbt_merge_to_main", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing to merge");
    expect(mocks.openMergeRequest).not.toHaveBeenCalled();
  });
});
