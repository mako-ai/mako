/**
 * mergeProjectPullRequest — unit tests with mocked GitHub API + sync.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IDbtProject } from "../database/workspace-schema";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));

vi.mock("../integrations/github/github-api", () => ({
  getPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  getRepoInfo: vi.fn(),
  tryDeleteBranch: vi.fn(),
}));

vi.mock("./dbt-github-sync.service", () => ({
  syncProjectFromRepo: vi.fn(async () => undefined),
}));

const mockFindById = vi.fn();
const mockSave = vi.fn(async () => undefined);

vi.mock("../database/workspace-schema", () => ({
  DbtFile: {
    find: vi.fn(() => ({
      select: () => ({
        lean: async () => [],
      }),
    })),
    findOne: vi.fn(),
  },
  DbtProject: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

import {
  getPullRequest,
  mergePullRequest,
  getRepoInfo,
  tryDeleteBranch,
} from "../integrations/github/github-api";
import { syncProjectFromRepo } from "./dbt-github-sync.service";
import { mergeProjectPullRequest } from "./dbt-github-git.service";

const projectId = new Types.ObjectId();

function makeProject(overrides: Partial<IDbtProject> = {}): IDbtProject {
  return {
    _id: projectId,
    repo: {
      owner: "acme",
      repo: "dbt",
      branch: "feature/add-model",
      installationId: "inst-1",
    },
    markModified: vi.fn(),
    save: mockSave,
    ...overrides,
  } as unknown as IDbtProject;
}

describe("mergeProjectPullRequest", () => {
  let storedProject: IDbtProject;

  beforeEach(() => {
    vi.clearAllMocks();
    storedProject = makeProject();
    mockFindById.mockImplementation(async () => storedProject);
  });

  it("merges PR, deletes branch, switches to default, and syncs", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      number: 42,
      headRef: "feature/add-model",
      baseRef: "main",
      mergeable: true,
      state: "open",
    });
    vi.mocked(mergePullRequest).mockResolvedValue({ sha: "abc123" });
    vi.mocked(getRepoInfo).mockResolvedValue({
      fullName: "acme/dbt",
      owner: "acme",
      name: "dbt",
      defaultBranch: "main",
      private: false,
    });
    vi.mocked(tryDeleteBranch).mockResolvedValue({ deleted: true });

    const project = storedProject;
    const result = await mergeProjectPullRequest(project, {
      prNumber: 42,
      updatedBy: "agent",
    });

    expect(mergePullRequest).toHaveBeenCalledWith(
      "acme",
      "dbt",
      42,
      { mergeMethod: "squash" },
      "token",
    );
    expect(project.repo?.branch).toBe("main");
    expect(mockSave).toHaveBeenCalled();
    expect(syncProjectFromRepo).toHaveBeenCalledWith(project, "agent");
    expect(tryDeleteBranch).toHaveBeenCalledWith(
      "acme",
      "dbt",
      "feature/add-model",
      "token",
    );
    expect(result).toEqual({
      sha: "abc123",
      branchDeleted: true,
      branchDeleteWarning: undefined,
      branch: "main",
      workingTreeClean: true,
    });
  });

  it("returns branch delete warning when deletion fails", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      number: 7,
      headRef: "feature/x",
      baseRef: "main",
      mergeable: true,
      state: "open",
    });
    vi.mocked(mergePullRequest).mockResolvedValue({ sha: "def456" });
    vi.mocked(getRepoInfo).mockResolvedValue({
      fullName: "acme/dbt",
      owner: "acme",
      name: "dbt",
      defaultBranch: "main",
      private: false,
    });
    vi.mocked(tryDeleteBranch).mockResolvedValue({
      deleted: false,
      warning: "GitHub 403 on ...: protected branch",
    });

    const result = await mergeProjectPullRequest(storedProject, {
      prNumber: 7,
      mergeMethod: "merge",
      deleteBranch: true,
      updatedBy: "u1",
    });

    expect(result.sha).toBe("def456");
    expect(result.branchDeleted).toBe(false);
    expect(result.branchDeleteWarning).toContain("protected branch");
  });

  it("skips branch deletion when deleteBranch is false", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      number: 3,
      headRef: "feature/y",
      baseRef: "main",
      mergeable: true,
      state: "open",
    });
    vi.mocked(mergePullRequest).mockResolvedValue({ sha: "ghi789" });
    vi.mocked(getRepoInfo).mockResolvedValue({
      fullName: "acme/dbt",
      owner: "acme",
      name: "dbt",
      defaultBranch: "main",
      private: false,
    });

    const result = await mergeProjectPullRequest(storedProject, {
      prNumber: 3,
      deleteBranch: false,
      updatedBy: "u1",
    });

    expect(tryDeleteBranch).not.toHaveBeenCalled();
    expect(result.branchDeleted).toBe(false);
  });

  it("surfaces GitHub merge errors verbatim", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      number: 99,
      headRef: "feature/conflict",
      baseRef: "main",
      mergeable: false,
      state: "open",
    });
    vi.mocked(mergePullRequest).mockRejectedValue(
      new Error("Pull Request is not mergeable"),
    );

    await expect(
      mergeProjectPullRequest(storedProject, {
        prNumber: 99,
        updatedBy: "u1",
      }),
    ).rejects.toThrow("Pull Request is not mergeable");
  });

  it("rejects closed pull requests", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      number: 5,
      headRef: "feature/done",
      baseRef: "main",
      mergeable: null,
      state: "closed",
    });

    await expect(
      mergeProjectPullRequest(storedProject, {
        prNumber: 5,
        updatedBy: "u1",
      }),
    ).rejects.toThrow("Pull request #5 is closed");
    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});
