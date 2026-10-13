/**
 * The shell, file and git tools working on a workflow folder
 * (the `workflow_*` tools, `workflowId`) instead of an app, against a real sandbox and a real
 * repository. A workflow is a folder with no row behind it, so this is what
 * shows the tools need nothing but the folder.
 */
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { runGit } from "../../apps/git";
import { initRepo, repoDirFor } from "../../apps/repository.service";
import {
  startTestGitServer,
  type TestGitServer,
} from "../../apps/test-git-server";
import { seededTemplateFiles } from "../../apps/workspace-template";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;
const WS = new Types.ObjectId().toString();
const ADMIN = "admin-user";
const MEMBER = "member-user";
const VIEWER = "viewer-user";
const WORKFLOW = `import { hatchet } from "../hatchet";
export default hatchet.workflow({ name: "score-leads" });
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

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-wf-target-"));
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
    { workspaceId: new Types.ObjectId(WS), userId: MEMBER, role: "member" },
    { workspaceId: new Types.ObjectId(WS), userId: VIEWER, role: "viewer" },
  ]);
}, 120_000);

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("workflowId as the tools' target", () => {
  it("gives each kind its own tools, each requiring its own id", async () => {
    const tools = (await toolsFor(MEMBER)) as unknown as Record<
      string,
      { inputSchema: z.ZodObject }
    >;
    const names = ["bash", "read_file", "write_file", "edit_file", "glob"];
    for (const name of [
      ...names,
      "grep",
      "status",
      "commit",
      "merge_to_main",
    ]) {
      const app = tools[`app_${name}`].inputSchema.shape;
      const workflow = tools[`workflow_${name}`].inputSchema.shape;
      // An app tool is what it was before workflows: no workflow parameter.
      expect(Object.keys(app), name).not.toContain("workflowId");
      expect(app.appId.safeParse(undefined).success, name).toBe(false);
      expect(Object.keys(workflow), name).not.toContain("appId");
      expect(workflow.workflowId.safeParse(undefined).success, name).toBe(
        false,
      );
    }
  });

  it("refuses a workflow that is not a folder name", async () => {
    const tools = await toolsFor(MEMBER);
    for (const input of [{ workflowId: "../apps" }, { workflowId: "a/b" }]) {
      const result = await call(tools, "workflow_read_file", {
        ...input,
        path: "workflow.ts",
      });
      expect(result.success, JSON.stringify(input)).toBe(false);
    }
  });

  it("lets a viewer read but not write", async () => {
    const tools = await toolsFor(VIEWER);
    const write = await call(tools, "workflow_write_file", {
      workflowId: "score-leads",
      path: "workflow.ts",
      contents: WORKFLOW,
    });
    expect(write.success).toBe(false);
    expect(write.error).toMatch(/Viewers cannot change workflows/);
  });

  it("writes, reads, edits, commits and merges a workflow folder", async () => {
    const tools = await toolsFor(ADMIN);
    const target = { workflowId: "score-leads" };

    const branch = await call(tools, "workflow_bash", {
      ...target,
      command: "git checkout -b workflow/score-leads",
    });
    expect(branch.success, String(branch.stderr)).toBe(true);

    const write = await call(tools, "workflow_write_file", {
      ...target,
      path: "workflow.ts",
      contents: WORKFLOW,
    });
    expect(write.success, write.error).toBe(true);

    // The shell starts in the workflow's own folder.
    const pwd = await call(tools, "workflow_bash", {
      ...target,
      command: "pwd && ls",
    });
    expect(String(pwd.stdout)).toMatch(/workflows\/score-leads\n/);
    expect(String(pwd.stdout)).toContain("workflow.ts");

    const edit = await call(tools, "workflow_edit_file", {
      ...target,
      path: "workflow.ts",
      oldString: '"score-leads" }',
      newString: '"score-leads", description: "Scores leads" }',
    });
    expect(edit.success, edit.error).toBe(true);

    const read = await call(tools, "workflow_read_file", {
      ...target,
      path: "workflow.ts",
      withLineNumbers: false,
    });
    expect(String(read.contents)).toContain("Scores leads");

    const grep = await call(tools, "workflow_grep", {
      ...target,
      pattern: "Scores",
    });
    expect(grep.count).toBe(1);

    const status = await call(tools, "workflow_status", target);
    expect(JSON.stringify(status.status)).toContain("workflow.ts");

    const commit = await call(tools, "workflow_commit", {
      ...target,
      message: "Add score-leads",
    });
    expect(commit.success, commit.error).toBe(true);

    // On the branch, not on main: nothing is live yet.
    const repoDir = repoDirFor(WS);
    const file = "workflows/score-leads/workflow.ts";
    const onBranch = await runGit([
      "-C",
      repoDir,
      "show",
      `workflow/score-leads:${file}`,
    ]);
    expect(onBranch.stdout).toContain("Scores leads");
    await expect(
      runGit(["-C", repoDir, "show", `main:${file}`]),
    ).rejects.toThrow();

    // The merge is the deploy: a member cannot do it, even from the
    // Source Control panel, which merges without the tools.
    const { mergeBranchToMain, workspaceScope } =
      await import("../../apps/worktree.service");
    await expect(
      mergeBranchToMain(
        workspaceScope(WS),
        "workflow/score-leads",
        undefined,
        MEMBER,
      ),
    ).rejects.toThrow(/Only workspace admins put workflows on main/);

    const merge = await call(tools, "workflow_merge_to_main", target);
    expect(merge.success, merge.error).toBe(true);
    const onMain = await runGit(["-C", repoDir, "show", `main:${file}`]);
    expect(onMain.stdout).toContain("Scores leads");
  }, 120_000);
});
