/**
 * compareRefs + listPullRequests head filter — GitHub REST mapping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareRefs, listPullRequests } from "./github-api";

describe("compareRefs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the compare payload and encodes refs", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "ahead",
        ahead_by: 2,
        behind_by: 1,
        commits: [
          {
            sha: "abc1234def",
            commit: {
              message: "feat: add model\n\nlong body",
              committer: { date: "2026-07-01T10:00:00Z" },
            },
          },
          {
            sha: "def5678abc",
            commit: { message: "fix: tweak", committer: null },
          },
        ],
        files: [
          {
            filename: "models/stg_orders.sql",
            status: "modified",
            additions: 3,
            deletions: 1,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await compareRefs("o", "r", "dev", "feat/csm-owner");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/o/r/compare/dev...feat%2Fcsm-owner"),
      expect.anything(),
    );
    expect(result.status).toBe("ahead");
    expect(result.aheadBy).toBe(2);
    expect(result.behindBy).toBe(1);
    expect(result.commits).toEqual([
      {
        sha: "abc1234def",
        message: "feat: add model\n\nlong body",
        date: "2026-07-01T10:00:00Z",
      },
      { sha: "def5678abc", message: "fix: tweak", date: undefined },
    ]);
    expect(result.files).toEqual([
      {
        filename: "models/stg_orders.sql",
        status: "modified",
        additions: 3,
        deletions: 1,
      },
    ]);
  });

  it("surfaces GitHub errors (unknown ref)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{"message":"Not Found"}',
      })),
    );

    await expect(compareRefs("o", "r", "dev", "gone")).rejects.toThrow(
      "GitHub 404",
    );
  });
});

describe("listPullRequests head filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes head=owner:branch and maps mergedAt", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          number: 15,
          title: "Docs contract",
          state: "closed",
          merged_at: "2026-06-30T12:00:00Z",
          head: { ref: "feat/docs" },
          base: { ref: "dev" },
          html_url: "https://github.com/o/r/pull/15",
          user: { login: "alice" },
          body: null,
          created_at: "2026-06-29T09:00:00Z",
          updated_at: "2026-06-30T12:00:00Z",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const prs = await listPullRequests("o", "r", {
      state: "all",
      head: "o:feat/docs",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("&head=o%3Afeat%2Fdocs"),
      expect.anything(),
    );
    expect(prs).toHaveLength(1);
    expect(prs[0].merged).toBe(true);
    expect(prs[0].mergedAt).toBe("2026-06-30T12:00:00Z");
  });
});
