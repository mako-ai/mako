import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitChanges,
  createBlob,
  getRepoInfo,
  prepareCommit,
  updateBranchRef,
} from "./github-api";

describe("GitHub Git Data tree writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates binary blobs from base64", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sha: "blob-sha" }),
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(createBlob("owner", "repo", "AP+A")).resolves.toBe("blob-sha");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      content: "AP+A",
      encoding: "base64",
    });
  });

  it("encodes repository path segments instead of allowing path injection", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        full_name: "org/name/repo?x",
        name: "repo?x",
        owner: { login: "org/name" },
        default_branch: "main",
        private: true,
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await getRepoInfo("org/name", "repo?x");

    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/org%2Fname/repo%3Fx",
    );
  });

  it("accepts pre-created blob SHAs and executable modes without changing text callers", async () => {
    const bodies: unknown[] = [];
    const responses = [{ sha: "tree-sha" }, { sha: "commit-sha" }, {}];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return {
        ok: true,
        json: async () => responses.shift(),
      };
    });
    vi.stubGlobal("fetch", fetch);

    await commitChanges("owner", "repo", {
      branch: "feature",
      parentSha: "parent",
      baseTreeSha: "base-tree",
      message: "mirror",
      changes: [
        { path: "script.sh", sha: "binary-blob", mode: "100755" },
        { path: "model.sql", content: "select 1" },
        { path: "removed.bin", sha: null },
      ],
    });

    expect(bodies[0]).toEqual({
      base_tree: "base-tree",
      tree: [
        {
          path: "script.sh",
          mode: "100755",
          type: "blob",
          sha: "binary-blob",
        },
        {
          path: "model.sql",
          mode: "100644",
          type: "blob",
          content: "select 1",
        },
        {
          path: "removed.bin",
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    });
    expect(bodies[2]).toEqual({ sha: "commit-sha", force: false });
  });

  it("prepares an immutable commit before separately updating its branch ref", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: "tree-sha" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: "prepared-sha" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);

    await expect(
      prepareCommit("owner", "repo", {
        parentSha: "parent",
        baseTreeSha: "base-tree",
        message: "mirror",
        changes: [{ path: "app.ts", content: "export {}" }],
      }),
    ).resolves.toBe("prepared-sha");
    expect(fetch).toHaveBeenCalledTimes(2);

    await updateBranchRef("owner", "repo", "feature", "prepared-sha");
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({
      sha: "prepared-sha",
      force: false,
    });
  });
});
