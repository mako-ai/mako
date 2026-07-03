/**
 * Agent dbt file tools — draft/dirty-tracking integration tests.
 *
 * Boots `createDbtServerTools` against an ephemeral mongodb-memory-server and
 * exercises the file mutation tools through the REAL working-tree + git-status
 * services (only GitHub network calls and heavy collaborators are mocked).
 *
 * Regression coverage for "anchored edit_dbt_file edits were invisible to
 * dbt_git_status / the Version Control UI": edit_dbt_file used to write the
 * committed base tree (DbtFile) directly instead of the per-user draft
 * overlay (DbtFileDraft), so after a dbt_sync_from_repo stamped base blob
 * SHAs the working tree reported clean and dbt_commit_and_push refused with
 * "No changes to commit" — while modify_dbt_file (full rewrite) worked.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Heavy collaborators pulled in transitively by the tools module — stubbed so
// imports resolve and side-effects are inert. dbt-github-git.service and
// dbt-working-tree.service stay REAL (they are the code under test).
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: { isAdmin: vi.fn(async () => true) },
}));
vi.mock("../../services/entity-version.service", () => ({
  createVersion: vi.fn(async () => ({})),
  getLatestVersionNumber: vi.fn(async () => 0),
  getUserDisplayName: vi.fn(async () => "Tester"),
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  applyJobScheduleChange: vi.fn(async () => undefined),
  reconcileStaleQueuedRun: vi.fn(async (r: unknown) => r),
  requestDbtRunCancel: vi.fn(),
  triggerDbtJobRun: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  triggerDbtRun: vi.fn(async () => ({ _id: new Types.ObjectId() })),
}));
vi.mock("../../dbt/dbt-commit-message.service", () => ({
  generateDbtCommitMessage: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));
// GitHub network surface only — the local git services run for real.
vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));
vi.mock("../../integrations/github/github-api", () => ({
  commitChanges: vi.fn(),
  createBranch: vi.fn(),
  createPullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  getBlobContent: vi.fn(),
  getBranchHeadSha: vi.fn(),
  getPullRequest: vi.fn(),
  getRefCommit: vi.fn(),
  getRepoInfo: vi.fn(),
  getRepoTree: vi.fn(),
  listBranches: vi.fn(),
  listPullRequests: vi.fn(),
  mergePullRequest: vi.fn(),
  tryDeleteBranch: vi.fn(),
  updatePullRequest: vi.fn(),
}));

// Imported after the mocks are registered.
import { createDbtServerTools } from "./dbt-tools";
import {
  DbtFile,
  DbtFileDraft,
  DbtProject,
} from "../../database/workspace-schema";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { gitBlobSha } from "../../integrations/github/git-blob";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const USER = "u1";

const tools = createDbtServerTools(WS, USER, { chatId: "chat1" });

type EditInput = {
  projectId: string;
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};
type EditResult = {
  success: boolean;
  error?: string;
  path?: string;
  replacements?: number;
};
type StatusResult = {
  success: boolean;
  branch?: string;
  hasChanges?: boolean;
  added?: number;
  modified?: number;
  deleted?: number;
  changes?: Array<{ path: string; status: string }>;
};
type ReadResult = { success: boolean; contents?: string };

function editFile(input: EditInput): Promise<EditResult> {
  return (tools.edit_dbt_file.execute as (i: EditInput) => Promise<EditResult>)(
    input,
  );
}

function gitStatus(projectId: string): Promise<StatusResult> {
  return (
    tools.dbt_git_status.execute as (i: {
      projectId: string;
    }) => Promise<StatusResult>
  )({ projectId });
}

function readFile(projectId: string, path: string): Promise<ReadResult> {
  return (
    tools.read_dbt_file.execute as (i: {
      projectId: string;
      path: string;
    }) => Promise<ReadResult>
  )({ projectId, path });
}

async function seedRepoProject(): Promise<string> {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: CONN,
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
    repo: {
      provider: "github",
      owner: "acme",
      repo: "analytics",
      branch: "main",
      installationId: 123,
    },
  });
  // Committed base tree of `main`, as a dbt_sync_from_repo leaves it: content
  // mirrors the branch head and repoBlobSha is stamped for diffing.
  await DbtFile.insertMany(
    [
      { path: "dbt_project.yml", content: "name: analytics" },
      { path: "models/a.sql", content: "select 1" },
    ].map(file => ({
      workspaceId: project.workspaceId,
      projectId: project._id,
      branch: "main",
      path: file.path,
      content: file.content,
      updatedBy: "sync",
      repoBlobSha: gitBlobSha(file.content),
    })),
  );
  return project._id.toString();
}

async function seedBlankProject(): Promise<string> {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Blank",
    environments: [
      {
        name: "dev",
        connectionId: CONN,
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  await DbtFile.create({
    workspaceId: project.workspaceId,
    projectId: project._id,
    path: "models/a.sql",
    content: "select 1",
    updatedBy: "tester",
  });
  return project._id.toString();
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    mongoose.connection.collection("dbt_projects").deleteMany({}),
    mongoose.connection.collection("dbt_files").deleteMany({}),
    mongoose.connection.collection("dbt_file_drafts").deleteMany({}),
    mongoose.connection.collection("dbt_checkouts").deleteMany({}),
  ]);
});

describe("edit_dbt_file on a repo-bound project", () => {
  it("writes a draft overlay, never the committed base tree", async () => {
    const projectId = await seedRepoProject();

    const result = await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);

    // The edit lives in the acting user's draft overlay...
    const draft = await DbtFileDraft.findOne({ userId: USER }).lean();
    expect(draft?.path).toBe("models/a.sql");
    expect(draft?.content).toBe("select 2");
    // ...and the committed base tree is untouched (other users see HEAD).
    const base = await DbtFile.findOne({
      branch: "main",
      path: "models/a.sql",
    }).lean();
    expect(base?.content).toBe("select 1");
    expect(base?.repoBlobSha).toBe(gitBlobSha("select 1"));
  });

  it("shows the anchored edit as a pending change in dbt_git_status", async () => {
    // The reported bug: after a sync stamped base blob SHAs, an anchored
    // edit succeeded (readable/compilable) but git status reported a clean
    // tree, so commit tools refused with "No changes to commit".
    const projectId = await seedRepoProject();

    await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });

    const status = await gitStatus(projectId);
    expect(status.success).toBe(true);
    expect(status.hasChanges).toBe(true);
    expect(status.modified).toBe(1);
    expect(status.changes).toEqual([
      { path: "models/a.sql", status: "modified" },
    ]);
  });

  it("edits are visible to the working-tree read path and stack across calls", async () => {
    const projectId = await seedRepoProject();

    await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });
    // Second anchored edit must read the DRAFT content, not the base.
    const second = await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 2",
      newString: "select 3",
    });
    expect(second.success).toBe(true);

    const read = await readFile(projectId, "models/a.sql");
    expect(read.contents).toBe("select 3");
    expect((await gitStatus(projectId)).modified).toBe(1);
  });

  it("reverting back to the committed content clears the pending change", async () => {
    const projectId = await seedRepoProject();

    await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });
    await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 2",
      newString: "select 1",
    });

    expect(await DbtFileDraft.countDocuments({})).toBe(0);
    expect((await gitStatus(projectId)).hasChanges).toBe(false);
  });

  it("publishes a user-scoped draft poke so only the author's windows react", async () => {
    const projectId = await seedRepoProject();

    await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });

    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        type: "dbt.file.updated",
        path: "models/a.sql",
        forUserId: USER,
      }),
    );
  });

  it("returns an error for a missing file without creating a draft", async () => {
    const projectId = await seedRepoProject();
    const result = await editFile({
      projectId,
      path: "models/missing.sql",
      oldString: "x",
      newString: "y",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(await DbtFileDraft.countDocuments({})).toBe(0);
  });
});

describe("edit_dbt_file on a blank (non-repo) project", () => {
  it("updates the shared working tree directly (no draft overlay)", async () => {
    const projectId = await seedBlankProject();

    const result = await editFile({
      projectId,
      path: "models/a.sql",
      oldString: "select 1",
      newString: "select 2",
    });
    expect(result.success).toBe(true);

    const file = await DbtFile.findOne({ path: "models/a.sql" }).lean();
    expect(file?.content).toBe("select 2");
    expect(await DbtFileDraft.countDocuments({})).toBe(0);
  });
});
