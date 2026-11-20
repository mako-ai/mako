/**
 * App and workflow tools for a guarded MCP/API-key caller
 * (apps/default-branch-guard.ts), against a real sandbox and repository.
 *
 *   COMMIT   — app_commit from main goes to `mcp/<person>/app/<slug>` (as a
 *              workflow's goes to its preview branch); main keeps its head.
 *   MERGE    — app_merge_to_main and workflow_merge_to_main open a merge
 *              request instead of merging; main keeps its head.
 *   REFUSAL  — naming main as the branch says where writes go and which tool
 *              opens the merge; app_move_app has no branch and says so.
 *   NO LEAK  — outside the guard scope the tools behave as before.
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

const mocks = vi.hoisted(() => ({ openMergeRequest: vi.fn() }));
vi.mock("../../apps/merge-request.service", () => ({
  openMergeRequest: mocks.openMergeRequest,
}));

import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { runGit } from "../../apps/git";
import {
  DEFAULT_BRANCH,
  initRepo,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import {
  startTestGitServer,
  type TestGitServer,
} from "../../apps/test-git-server";
import { seededTemplateFiles } from "../../apps/workspace-template";
import { runUnderDefaultBranchGuard } from "../../apps/default-branch-guard";
import { guardBranchFor } from "../../apps/branch-policy";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;
const WS = new Types.ObjectId().toString();
const ADMIN = "admin-user";
const WORKFLOW = `import { hatchet } from "../hatchet";
export default hatchet.workflow({ name: "guarded" });
`;

type Result = Record<string, unknown> & { success: boolean; error?: string };
type Tools = Record<
  string,
  { execute: (input: object, options: object) => Promise<Result> }
>;

async function toolsFor(userId: string): Promise<Tools> {
  const { createAppsTools } = await import("./apps-tools");
  return createAppsTools({ workspaceId: WS, userId }) as unknown as Tools;
}
const call = (tools: Tools, name: string, input: object) =>
  tools[name].execute(input, { toolCallId: "t", messages: [] });
const guarded = <T>(fn: () => Promise<T>) =>
  runUnderDefaultBranchGuard({ workspaceId: WS, userId: ADMIN }, fn);
const mainHead = () =>
  resolveCommit(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-apps-guard-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
  const { WorkspaceMember } = await import("../../database/workspace-schema");
  await WorkspaceMember.collection.insertMany([
    { workspaceId: new Types.ObjectId(WS), userId: ADMIN, role: "admin" },
  ]);
}, 120_000);

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  mocks.openMergeRequest.mockReset();
});

describe("app tools for a guarded caller", () => {
  it("commits an app to mcp/<person>/app/<slug> and opens a merge request instead of merging", async () => {
    const tools = await toolsFor(ADMIN);
    const created = await guarded(() =>
      call(tools, "app_create_app", {
        title: "Guarded Report",
        description: "built over MCP",
        folder: "apps",
      }),
    );
    expect(created.success, created.error).toBe(true);
    const appId = String(created.app);
    const slug = String(created.path).split("/").pop()!;

    const afterCreate = await mainHead();
    const write = await guarded(() =>
      call(tools, "app_write_file", {
        appId,
        path: "src/Guarded.tsx",
        contents: "export const Guarded = 1;\n",
      }),
    );
    expect(write.success, write.error).toBe(true);

    const branch = await guardBranchFor(WS, ADMIN, "app", slug);
    const commit = await guarded(() =>
      call(tools, "app_commit", { appId, message: "Add Guarded" }),
    );
    expect(commit.success, commit.error).toBe(true);
    expect(commit.branch).toBe(branch);
    expect(commit.next).toBe(
      `Writes go to branch ${branch}, not main. Open a merge with app_merge_to_main.`,
    );
    // The commit sits on the guard branch; main did not move.
    expect(await mainHead()).toBe(afterCreate);
    const onBranch = await runGit([
      "-C",
      repoDirFor(WS),
      "show",
      `${branch}:${String(created.path)}/src/Guarded.tsx`,
    ]);
    expect(onBranch.stdout).toContain("Guarded = 1");

    // With no branch named, the merge takes the guard branch and opens a request.
    mocks.openMergeRequest.mockResolvedValue({
      status: "pull_request",
      pullRequest: { number: 3, url: "https://github.com/o/r/pull/3" },
    });
    const merge = await guarded(() =>
      call(tools, "app_merge_to_main", { appId }),
    );
    expect(merge.success, merge.error).toBe(true);
    expect(mocks.openMergeRequest).toHaveBeenCalledWith({
      workspaceId: WS,
      branch,
      userId: ADMIN,
    });
    expect(await mainHead()).toBe(afterCreate);

    // A failed check is not a merge.
    mocks.openMergeRequest.mockResolvedValue({ status: "checks_failed" });
    const failed = await guarded(() =>
      call(tools, "app_merge_to_main", { appId, branch }),
    );
    expect(failed.success).toBe(false);

    // Naming main says where writes go.
    const refused = await guarded(() =>
      call(tools, "app_merge_to_main", { appId, branch: "main" }),
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(
      `Writes go to branch ${branch}. Open a merge with app_merge_to_main.`,
    );

    // A move is one commit on main with no branch to wait on.
    const move = await guarded(() =>
      call(tools, "app_move_app", { appId, folder: "apps" }),
    );
    expect(move.success).toBe(false);
    expect(move.error).toContain("app_move_app writes to the default branch");
  }, 180_000);

  it("commits straight to main outside the guard scope, as before", async () => {
    const tools = await toolsFor(ADMIN);
    const created = await call(tools, "app_create_app", {
      title: "Direct App",
      description: "in-app agent",
      folder: "apps",
    });
    expect(created.success, created.error).toBe(true);
    const appId = String(created.app);
    await call(tools, "app_write_file", {
      appId,
      path: "src/Direct.tsx",
      contents: "export const Direct = 1;\n",
    });
    const before = await mainHead();
    const commit = await call(tools, "app_commit", {
      appId,
      message: "Direct",
    });
    expect(commit.success, commit.error).toBe(true);
    expect(commit.branch).toBeUndefined();
    expect(await mainHead()).not.toBe(before);
    expect(mocks.openMergeRequest).not.toHaveBeenCalled();
  }, 180_000);
});

describe("workflow tools for a guarded caller", () => {
  it("opens a merge request for the preview branch instead of deploying", async () => {
    const tools = await toolsFor(ADMIN);
    const target = { workflowId: "guarded-wf" };
    await guarded(() =>
      call(tools, "workflow_write_file", {
        ...target,
        path: "workflow.ts",
        contents: WORKFLOW,
      }),
    );
    const commit = await guarded(() =>
      call(tools, "workflow_commit", { ...target, message: "Add guarded-wf" }),
    );
    expect(commit.success, commit.error).toBe(true);
    const preview = String(commit.branch);
    expect(preview).toMatch(/^workflow\/(.+\/)?guarded-wf$/);

    const before = await mainHead();
    mocks.openMergeRequest.mockResolvedValue({
      status: "pull_request",
      pullRequest: { number: 4, url: "https://github.com/o/r/pull/4" },
    });
    const merge = await guarded(() =>
      call(tools, "workflow_merge_to_main", target),
    );
    expect(merge.success, merge.error).toBe(true);
    expect(mocks.openMergeRequest).toHaveBeenCalledWith({
      workspaceId: WS,
      branch: preview,
      userId: ADMIN,
    });
    expect(await mainHead()).toBe(before);

    const refused = await guarded(() =>
      call(tools, "workflow_merge_to_main", { ...target, branch: "main" }),
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Open a merge with workflow_merge_to_main");
  }, 180_000);
});
