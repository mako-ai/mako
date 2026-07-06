/**
 * compareProjectRefs — branch-vs-base comparison verdicts, incl. the
 * squash-merge detection that plain ahead/behind counts can't answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDbtProject } from "../database/workspace-schema";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));

const github = vi.hoisted(() => ({
  compareRefs: vi.fn(),
  listPullRequests: vi.fn(),
  getRepoInfo: vi.fn(),
}));

vi.mock("../integrations/github/github-api", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../integrations/github/github-api")
  >()),
  compareRefs: github.compareRefs,
  listPullRequests: github.listPullRequests,
  getRepoInfo: github.getRepoInfo,
}));

import { compareProjectRefs } from "./dbt-github-git.service";

const project = {
  repo: {
    provider: "github",
    owner: "acme",
    repo: "analytics",
    branch: "dev",
    installationId: 123,
  },
} as unknown as IDbtProject;

function compareResult(
  overrides: Partial<{
    status: string;
    aheadBy: number;
    behindBy: number;
    commits: Array<{ sha: string; message: string; date?: string }>;
    files: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
  }> = {},
) {
  return {
    status: "ahead",
    aheadBy: 1,
    behindBy: 0,
    commits: [
      { sha: "abc", message: "feat: x", date: "2026-06-01T00:00:00Z" },
    ],
    files: [
      { filename: "models/x.sql", status: "added", additions: 5, deletions: 0 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  github.getRepoInfo.mockResolvedValue({
    fullName: "acme/analytics",
    owner: "acme",
    name: "analytics",
    defaultBranch: "dev",
    private: true,
  });
  github.listPullRequests.mockResolvedValue([]);
});

describe("compareProjectRefs", () => {
  it("defaults base to the repo default branch and filters PRs by head", async () => {
    github.compareRefs.mockResolvedValue(compareResult());

    const result = await compareProjectRefs(project, { head: "feat/x" });

    expect(result.base).toBe("dev");
    expect(result.head).toBe("feat/x");
    expect(github.compareRefs).toHaveBeenCalledWith(
      "acme",
      "analytics",
      "dev",
      "feat/x",
      "token",
    );
    expect(github.listPullRequests).toHaveBeenCalledWith(
      "acme",
      "analytics",
      { state: "all", head: "acme:feat/x" },
      "token",
    );
  });

  it("skips the default-branch lookup when base is given", async () => {
    github.compareRefs.mockResolvedValue(compareResult());

    const result = await compareProjectRefs(project, {
      head: "feat/x",
      base: "staging",
    });

    expect(result.base).toBe("staging");
    expect(github.getRepoInfo).not.toHaveBeenCalled();
  });

  it("aheadBy 0 → fully merged (regular merge)", async () => {
    github.compareRefs.mockResolvedValue(
      compareResult({ status: "behind", aheadBy: 0, commits: [], files: [] }),
    );

    const result = await compareProjectRefs(project, { head: "feat/merged" });
    expect(result.fullyMergedIntoBase).toBe(true);
  });

  it("aheadBy > 0 with a PR into base merged after the last commit → fully merged (squash)", async () => {
    github.compareRefs.mockResolvedValue(
      compareResult({
        aheadBy: 2,
        commits: [
          { sha: "a", message: "feat", date: "2026-06-01T00:00:00Z" },
          { sha: "b", message: "fix", date: "2026-06-02T00:00:00Z" },
        ],
      }),
    );
    github.listPullRequests.mockResolvedValue([
      {
        number: 15,
        state: "closed",
        merged: true,
        mergedAt: "2026-06-03T00:00:00Z",
        baseRef: "dev",
      },
    ]);

    const result = await compareProjectRefs(project, { head: "feat/docs" });
    expect(result.fullyMergedIntoBase).toBe(true);
    expect(result.pullRequests).toHaveLength(1);
  });

  it("commits pushed AFTER the merged PR → NOT fully merged", async () => {
    github.compareRefs.mockResolvedValue(
      compareResult({
        aheadBy: 2,
        commits: [
          { sha: "a", message: "feat", date: "2026-06-01T00:00:00Z" },
          { sha: "b", message: "post-merge fix", date: "2026-06-05T00:00:00Z" },
        ],
      }),
    );
    github.listPullRequests.mockResolvedValue([
      {
        number: 15,
        state: "closed",
        merged: true,
        mergedAt: "2026-06-03T00:00:00Z",
        baseRef: "dev",
      },
    ]);

    const result = await compareProjectRefs(project, { head: "feat/docs" });
    expect(result.fullyMergedIntoBase).toBe(false);
  });

  it("merged PR into a DIFFERENT base → NOT fully merged", async () => {
    github.compareRefs.mockResolvedValue(compareResult({ aheadBy: 1 }));
    github.listPullRequests.mockResolvedValue([
      {
        number: 9,
        state: "closed",
        merged: true,
        mergedAt: "2026-06-03T00:00:00Z",
        baseRef: "main",
      },
    ]);

    const result = await compareProjectRefs(project, { head: "feat/x" });
    expect(result.fullyMergedIntoBase).toBe(false);
  });

  it("ahead with no merged PR → NOT fully merged (unmerged work)", async () => {
    github.compareRefs.mockResolvedValue(
      compareResult({ status: "diverged", aheadBy: 3, behindBy: 4 }),
    );

    const result = await compareProjectRefs(project, { head: "wip/experiment" });
    expect(result.fullyMergedIntoBase).toBe(false);
  });

  it("throws for projects without a connected repo", async () => {
    await expect(
      compareProjectRefs({} as IDbtProject, { head: "feat/x" }),
    ).rejects.toThrow("not connected to a repository");
  });
});
