/**
 * commitAndPush / commitToNewBranch — selected-path git commit behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IDbtProject } from "../database/workspace-schema";
import { gitBlobSha } from "../integrations/github/git-blob";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));

vi.mock("../integrations/github/github-api", () => ({
  commitChanges: vi.fn(async () => "new-sha"),
  createBranch: vi.fn(async () => undefined),
  createPullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  getBlobContent: vi.fn(),
  getPullRequest: vi.fn(),
  getRefCommit: vi.fn(async () => ({
    commitSha: "parent-sha",
    treeSha: "tree-sha",
  })),
  getRepoInfo: vi.fn(),
  getRepoTree: vi.fn(async () => ({
    sha: "tree-sha",
    truncated: false,
    entries: [
      { path: "models/selected.sql", type: "blob", sha: "selected-old" },
      { path: "models/unselected.sql", type: "blob", sha: "unselected-old" },
    ],
  })),
  listBranches: vi.fn(),
  mergePullRequest: vi.fn(),
  tryDeleteBranch: vi.fn(),
}));

vi.mock("./dbt-github-sync.service", () => ({
  syncProjectFromRepo: vi.fn(async () => undefined),
}));

const mockFindById = vi.fn();
const mockFindFiles = vi.fn();
const mockUpdateOne = vi.fn(() => ({ exec: vi.fn(async () => undefined) }));
const mockDeleteOne = vi.fn(() => ({ exec: vi.fn(async () => undefined) }));
const mockSave = vi.fn(async () => undefined);

vi.mock("../database/workspace-schema", () => ({
  DbtFile: {
    find: (...args: unknown[]) => mockFindFiles(...args),
    findOne: vi.fn(),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
  },
  DbtProject: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

import { commitChanges, createBranch } from "../integrations/github/github-api";
import { commitAndPush, commitToNewBranch } from "./dbt-github-git.service";

const projectId = new Types.ObjectId();

function makeProject(overrides: Partial<IDbtProject> = {}): IDbtProject {
  return {
    _id: projectId,
    repo: {
      owner: "acme",
      repo: "analytics",
      branch: "main",
      installationId: "inst-1",
    },
    markModified: vi.fn(),
    save: mockSave,
    ...overrides,
  } as unknown as IDbtProject;
}

function mockFiles() {
  const files = [
    {
      path: "models/selected.sql",
      content: "select 1 as selected",
      is_deleted: false,
      repoBlobSha: gitBlobSha("select 0 as selected"),
    },
    {
      path: "models/unselected.sql",
      content: "select 1 as unselected",
      is_deleted: false,
      repoBlobSha: gitBlobSha("select 0 as unselected"),
    },
  ];
  mockFindFiles.mockReturnValue({
    select: () => ({
      lean: async () => files,
    }),
  });
}

describe("selected-path dbt git commits", () => {
  let storedProject: IDbtProject;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles();
    storedProject = makeProject();
    mockFindById.mockResolvedValue(storedProject);
  });

  it("commits and reconciles only selected paths", async () => {
    const result = await commitAndPush(storedProject, {
      message: "fix: update selected model",
      updatedBy: "agent",
      paths: ["models/selected.sql"],
    });

    expect(result).toMatchObject({
      committed: true,
      sha: "new-sha",
      branch: "main",
      pushed: { added: 0, modified: 1, deleted: 0 },
    });
    expect(commitChanges).toHaveBeenCalledWith(
      "acme",
      "analytics",
      expect.objectContaining({
        branch: "main",
        message: "fix: update selected model",
        changes: [
          { path: "models/selected.sql", content: "select 1 as selected" },
        ],
      }),
      "token",
    );
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { projectId, path: "models/selected.sql" },
      { $set: { repoBlobSha: gitBlobSha("select 1 as selected") } },
    );
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  it("creates a new branch and commits only selected paths", async () => {
    const result = await commitToNewBranch(storedProject, {
      branchName: "feat/selected",
      message: "feat: add selected change",
      updatedBy: "agent",
      paths: ["models/selected.sql"],
    });

    expect(createBranch).toHaveBeenCalledWith(
      "acme",
      "analytics",
      "feat/selected",
      "parent-sha",
      "token",
    );
    expect(commitChanges).toHaveBeenCalledWith(
      "acme",
      "analytics",
      expect.objectContaining({
        branch: "feat/selected",
        changes: [
          { path: "models/selected.sql", content: "select 1 as selected" },
        ],
      }),
      "token",
    );
    expect(result).toMatchObject({
      committed: true,
      branch: "feat/selected",
      fromBranch: "main",
      pushed: { added: 0, modified: 1, deleted: 0 },
    });
  });

  it("rejects a selected path without pending changes", async () => {
    await expect(
      commitAndPush(storedProject, {
        message: "fix: update selected model",
        updatedBy: "agent",
        paths: ["models/missing.sql"],
      }),
    ).rejects.toThrow("Selected path(s) have no pending changes");
    expect(commitChanges).not.toHaveBeenCalled();
  });
});
