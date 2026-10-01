/**
 * dbt agent FILE tools against the git-backed working tree (apps.md §20):
 * a real bare workspace repo under a temp APPS_GIT_ROOT, real Mongo for the
 * project row. A file edit is a COMMIT on the actor's session branch —
 * these specs pin exactly that: content lands under dbt/<path> in git,
 * branch-scoped, with ordinary git history.
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

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: { hasAccess: vi.fn(async () => true) },
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  loadDbtDeferState: vi.fn(async () => undefined),
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  triggerDbtRun: vi.fn(),
  triggerDbtJobRun: vi.fn(),
  requestDbtRunCancel: vi.fn(),
  reconcileStaleQueuedRun: vi.fn(async (run: unknown) => run),
  applyJobScheduleChange: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

import { createDbtServerTools } from "./dbt-tools";
import { AppWorktree, DbtProject } from "../../database/workspace-schema";
import { seedDbtGitTree } from "../../dbt/test-support/git-tree";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  DEFAULT_BRANCH,
  log as repoLog,
  readBlob,
  repoDirFor,
} from "../../apps/repository.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const USER = "u1";

const tools = createDbtServerTools(WS, USER, { chatId: "chat1" });

const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-file-tools-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([DbtProject.deleteMany({}), AppWorktree.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await bindTestWorkspaceRepo(WS);
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

async function fileAtMain(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), MAIN, `dbt/${rel}`);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

type Exec<I, O> = (i: I) => Promise<O>;
const run = <I, O>(tool: { execute?: unknown }, input: I): Promise<O> =>
  (tool.execute as Exec<I, O>)(input);

describe("git-backed dbt file tools", () => {
  it("create_dbt_file commits under dbt/ on main", async () => {
    const project = await seedProject();
    const result = await run<
      { projectId: string; path: string; contents: string },
      { success: boolean; error?: string }
    >(tools.create_dbt_file, {
      projectId: project._id.toString(),
      path: "models/new_model.sql",
      contents: "select 2\n",
    });
    expect(result.success).toBe(true);
    expect(await fileAtMain("models/new_model.sql")).toBe("select 2\n");
    const [head] = await repoLog(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toContain("models/new_model.sql");
  });

  it("edit_dbt_file replaces content and commits", async () => {
    const project = await seedProject();
    const result = await run<
      {
        projectId: string;
        path: string;
        oldString: string;
        newString: string;
      },
      { success: boolean; error?: string }
    >(tools.edit_dbt_file, {
      projectId: project._id.toString(),
      path: "models/stg_orders.sql",
      oldString: "select 1",
      newString: "select 42",
    });
    expect(result.success).toBe(true);
    expect(await fileAtMain("models/stg_orders.sql")).toBe("select 42\n");
  });

  it("delete_dbt_file removes the file; a second delete reports not found", async () => {
    const project = await seedProject();
    const del = () =>
      run<{ projectId: string; path: string }, { success: boolean }>(
        tools.delete_dbt_file,
        { projectId: project._id.toString(), path: "models/stg_orders.sql" },
      );
    expect((await del()).success).toBe(true);
    expect(await fileAtMain("models/stg_orders.sql")).toBeNull();
    expect((await del()).success).toBe(false);
  });

  it("edits land on the actor's SESSION branch, invisible to main", async () => {
    const project = await seedProject();
    await AppWorktree.create({
      workspaceId: new Types.ObjectId(WS),
      userId: USER,
      branch: "feature/models",
    });
    await run<
      { projectId: string; path: string; contents: string },
      { success: boolean }
    >(tools.create_dbt_file, {
      projectId: project._id.toString(),
      path: "models/branch_only.sql",
      contents: "select 3\n",
    });
    // Main does not have it; the session branch does.
    expect(await fileAtMain("models/branch_only.sql")).toBeNull();
    const branchBlob = await readBlob(
      repoDirFor(WS),
      "refs/heads/feature/models",
      "dbt/models/branch_only.sql",
    );
    expect(branchBlob.contents).toBe("select 3\n");
    // read_dbt_file sees the session branch's version.
    const read = await run<
      { projectId: string; path: string },
      { success: boolean; contents?: string }
    >(tools.read_dbt_file, {
      projectId: project._id.toString(),
      path: "models/branch_only.sql",
    });
    expect(read.contents).toBe("select 3\n");
  });

  it("read_dbt_project_tree lists the git tree", async () => {
    const project = await seedProject();
    const tree = await run<
      { projectId?: string },
      { success: boolean; files?: string[] }
    >(tools.read_dbt_project_tree, { projectId: project._id.toString() });
    expect(tree.success).toBe(true);
    const paths = tree.files ?? [];
    expect(paths).toContain("dbt_project.yml");
    expect(paths).toContain("models/stg_orders.sql");
  });
});
