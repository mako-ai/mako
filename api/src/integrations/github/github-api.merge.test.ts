/**
 * mergePullRequest + tryDeleteBranch — GitHub REST error handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergePullRequest, tryDeleteBranch } from "./github-api";

describe("mergePullRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns merge commit sha on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify({ sha: "merged-sha", merged: true }),
      })),
    );

    const result = await mergePullRequest("o", "r", 10, {
      mergeMethod: "squash",
    });
    expect(result.sha).toBe("merged-sha");
  });

  it("throws GitHub message verbatim on merge failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        text: async () =>
          JSON.stringify({
            message: "Pull Request is not mergeable",
            documentation_url: "https://docs.github.com/rest",
          }),
      })),
    );

    await expect(
      mergePullRequest("o", "r", 10, { mergeMethod: "squash" }),
    ).rejects.toThrow("Pull Request is not mergeable");
  });
});

describe("tryDeleteBranch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats 404 as already deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{"message":"Reference does not exist"}',
      })),
    );

    const result = await tryDeleteBranch("o", "r", "gone-branch");
    expect(result).toEqual({ deleted: true });
  });

  it("returns warning on protected branch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => '{"message":"Resource not accessible"}',
      })),
    );

    const result = await tryDeleteBranch("o", "r", "protected");
    expect(result.deleted).toBe(false);
    expect(result.warning).toContain("GitHub 403");
  });
});
