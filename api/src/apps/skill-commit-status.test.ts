/**
 * Hidden skill files as a GitHub commit status on main's head. The catalog,
 * GitHub, auth and the mirror are stubbed: what is under test is the state,
 * the wording and that reporting never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  catalog: {
    workspaceId: "ws",
    head: "a".repeat(40) as string | null,
    skills: [] as Array<{ name: string }>,
    invalid: [] as Array<{ name: string; path: string; reason: string }>,
    warnings: [] as Array<{ name: string; path: string; reason: string }>,
    incomplete: undefined as boolean | undefined,
  },
  target: { kind: "connected", owner: "acme", repo: "workspace" } as null | {
    kind: "connected";
    owner: string;
    repo: string;
    installationId?: number;
  },
  token: "ghs_token" as string | undefined,
  postError: null as Error | null,
  calls: [] as string[],
  posts: [] as Array<{
    owner: string;
    repo: string;
    sha: string;
    params: {
      state: string;
      description: string;
      context?: string;
      targetUrl?: string;
    };
  }>,
}));

vi.mock("../integrations/github/github-api", () => ({
  postCommitStatus: vi.fn(
    async (
      owner: string,
      repo: string,
      sha: string,
      params: (typeof state.posts)[number]["params"],
    ) => {
      state.calls.push("post");
      if (state.postError) throw state.postError;
      state.posts.push({ owner, repo, sha, params });
    },
  ),
}));

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => state.token),
}));

vi.mock("./cloud-repo.service", () => ({
  resolveMirrorTarget: vi.fn(async () => state.target),
  mirrorPushNow: vi.fn(async () => {
    state.calls.push("mirror");
  }),
}));

vi.mock("./workspace-skills.service", () => ({
  loadSkillCatalog: vi.fn(async () => state.catalog),
}));

import {
  SKILLS_STATUS_CONTEXT,
  describeSkillsStatus,
  reportSkillsCommitStatus,
  resetSkillsStatusForTest,
} from "./skill-commit-status";

const WS = "ws";
const skills = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `s${i}` }));
const glossary = {
  name: "glossary",
  path: "skills/glossary/SKILL.md",
  reason: "body 24,713 chars over the 20,000 limit",
};
const pricing = {
  name: "pricing",
  path: "skills/pricing/SKILL.md",
  reason: "front matter line 7: bad indentation of a mapping entry",
};
const wordy = {
  name: "wordy",
  path: "skills/wordy/SKILL.md",
  reason: "description 247 chars: the index shows the first 200",
};

beforeEach(() => {
  resetSkillsStatusForTest();
  state.catalog = {
    workspaceId: WS,
    head: "a".repeat(40),
    skills: skills(139),
    invalid: [],
    warnings: [],
    incomplete: undefined,
  };
  state.target = { kind: "connected", owner: "acme", repo: "workspace" };
  state.token = "ghs_token";
  state.postError = null;
  state.calls = [];
  state.posts = [];
  process.env.CLIENT_URL = "https://app.example.com/";
});

describe("describeSkillsStatus", () => {
  it("fails the commit when a skill file is hidden, naming the file and the reason", () => {
    expect(
      describeSkillsStatus({
        skills: skills(139) as never,
        invalid: [glossary],
        warnings: [wordy],
      }),
    ).toEqual({
      state: "failure",
      description:
        "1 skill file hidden from the agent: skills/glossary/SKILL.md: body 24,713 chars over the 20,000 limit",
    });
    const four = describeSkillsStatus({
      skills: skills(139) as never,
      invalid: [glossary, pricing, pricing, pricing],
      warnings: [],
    })!;
    expect(four.state).toBe("failure");
    expect(four.description).toBe(
      "4 skill files hidden from the agent: skills/glossary/SKILL.md: body 24,713 chars over the 20,000 limit (+3 more)",
    );
    expect(four.description.length).toBeLessThanOrEqual(140);
  });

  it("passes with the warning in the text: GitHub has no neutral state", () => {
    expect(
      describeSkillsStatus({
        skills: skills(143) as never,
        invalid: [],
        warnings: [wordy],
      }),
    ).toEqual({
      state: "success",
      description:
        "143 skills load, 1 warning: skills/wordy/SKILL.md: description 247 chars: the index shows the first 200",
    });
  });

  it("passes plainly when every file loads, and says nothing without skills", () => {
    expect(
      describeSkillsStatus({
        skills: skills(143) as never,
        invalid: [],
        warnings: [],
      }),
    ).toEqual({ state: "success", description: "143 skills load" });
    expect(
      describeSkillsStatus({ skills: [], invalid: [], warnings: [] }),
    ).toBeNull();
  });

  it("clips a long reason to GitHub's 140 characters", () => {
    const long = describeSkillsStatus({
      skills: [],
      invalid: [{ ...pricing, reason: "x".repeat(300) }],
      warnings: [],
    })!;
    expect(long.description).toHaveLength(140);
    expect(long.description.endsWith("…")).toBe(true);
  });
});

describe("reportSkillsCommitStatus", () => {
  it("posts a failure on main's head under mako/skills, after the mirror push", async () => {
    state.catalog.invalid = [glossary, pricing];
    expect(await reportSkillsCommitStatus(WS)).toEqual({ posted: true });
    expect(state.calls).toEqual(["mirror", "post"]);
    expect(state.posts).toEqual([
      {
        owner: "acme",
        repo: "workspace",
        sha: "a".repeat(40),
        params: {
          state: "failure",
          description:
            "2 skill files hidden from the agent: skills/glossary/SKILL.md: body 24,713 chars over the 20,000 limit (+1 more)",
          context: SKILLS_STATUS_CONTEXT,
          targetUrl: "https://app.example.com/settings/skills",
        },
      },
    ]);
    expect(SKILLS_STATUS_CONTEXT).toBe("mako/skills");
  });

  it("posts once per head: the webhook echo of the same push is skipped", async () => {
    await reportSkillsCommitStatus(WS);
    expect(await reportSkillsCommitStatus(WS)).toEqual({
      posted: false,
      reason: "already-reported",
    });
    state.catalog.head = "b".repeat(40);
    state.catalog.invalid = [glossary];
    await reportSkillsCommitStatus(WS);
    expect(state.posts.map(post => [post.sha[0], post.params.state])).toEqual([
      ["a", "success"],
      ["b", "failure"],
    ]);
  });

  it("posts nothing without skill files, a repo, a connected mirror or a token", async () => {
    state.catalog.skills = [];
    expect((await reportSkillsCommitStatus(WS)).reason).toBe("no-skills");
    state.catalog.skills = skills(1);
    state.catalog.head = null;
    expect((await reportSkillsCommitStatus(WS)).reason).toBe("no-repo");
    state.catalog.head = "a".repeat(40);
    state.target = null;
    expect((await reportSkillsCommitStatus(WS)).reason).toBe(
      "no-connected-repo",
    );
    state.target = { kind: "connected", owner: "acme", repo: "workspace" };
    state.token = undefined;
    expect((await reportSkillsCommitStatus(WS)).reason).toBe("no-token");
    expect(state.posts).toEqual([]);
  });

  it("posts nothing from a catalog git could not fully read", async () => {
    state.catalog.incomplete = true;
    state.catalog.invalid = [
      { ...glossary, reason: "the file could not be read just now; retry" },
    ];
    expect(await reportSkillsCommitStatus(WS)).toEqual({
      posted: false,
      reason: "incomplete",
    });
    state.catalog.incomplete = undefined;
    state.catalog.invalid = [];
    expect(await reportSkillsCommitStatus(WS)).toEqual({ posted: true });
    expect(state.posts.map(post => post.params.state)).toEqual(["success"]);
  });

  it("never throws: a GitHub error is swallowed and the next push retries", async () => {
    state.postError = new Error(
      "GitHub 403: Resource not accessible by integration",
    );
    expect(await reportSkillsCommitStatus(WS)).toEqual({
      posted: false,
      reason: "permission",
    });
    state.postError = new Error("socket hang up");
    expect(await reportSkillsCommitStatus(WS)).toEqual({
      posted: false,
      reason: "error",
    });
    state.postError = null;
    expect(await reportSkillsCommitStatus(WS)).toEqual({ posted: true });
  });
});
