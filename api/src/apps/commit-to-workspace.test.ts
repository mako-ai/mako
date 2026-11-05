/**
 * GitHub is the commit point for every server-side save (`commitToWorkspace`).
 *
 * Two API instances are two clone roots (APPS_GIT_ROOT) against one file://
 * mirror standing in for GitHub. Each content type saves on one instance
 * while the other is behind, and both saves must be on the mirror's main:
 * before the primitive, the second save committed onto a stale tip, its
 * background push was refused, and the next fetch parked it under
 * refs/mako/diverged/* while the user had been told it saved.
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

const state = vi.hoisted(() => ({
  binding: null as null | { owner: string; repo: string },
}));

vi.mock("../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
  findWorkspaceIdsByRepoBinding: vi.fn(async () => []),
}));
vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));

import { WorkspaceRepoHead } from "../database/workspace-schema";
import { runGit } from "./git";
import {
  WorkspaceSaveNotPushedError,
  commitToWorkspace,
  ensureLocalRepo,
  freshenForServe,
} from "./cloud-repo.service";
import { advanceBranchHead, readBranchHead } from "./branch-head.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import { commitWorkspacePrompt } from "./workspace-prompt";
import { commitSkillSave } from "./workspace-skills.service";
import { commitConsoleBatch } from "./workspace-consoles.service";
import { commitConfigToMain } from "../services/flow-config.service";
import { mergeBranchToMain } from "./worktree.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
let remoteDir: string;
let WS: string;

/** Run `fn` as one of two API instances: each has its own clone root. */
async function on<T>(instance: "a" | "b", fn: () => Promise<T>): Promise<T> {
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, `instance-${instance}`);
  return fn();
}

async function mirrorFile(rel: string): Promise<string | null> {
  try {
    return (await readBlob(remoteDir, DEFAULT_BRANCH, rel)).contents;
  } catch {
    return null;
  }
}

async function mirrorHead(): Promise<string> {
  return (
    await runGit(["-C", remoteDir, "rev-parse", DEFAULT_BRANCH])
  ).stdout.trim();
}

async function localHead(): Promise<string | null> {
  return resolveCommit(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`);
}

/** Make both instances hold a clone, as they would after serving anything. */
async function warmBothInstances(): Promise<void> {
  await on("a", () => ensureLocalRepo(WS));
  await on("b", () => ensureLocalRepo(WS));
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commit-to-ws-"));
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
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
  WS = new Types.ObjectId().toString();
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  const repo = `ws-${WS}`;
  remoteDir = path.join(remotesRoot, "acme", `${repo}.git`);
  await fs.mkdir(path.dirname(remoteDir), { recursive: true });
  await initRepo(remoteDir, { "README.md": "workspace\n" });
  state.binding = { owner: "acme", repo };
  // Each instance clones on first use, like a cold Cloud Run instance.
  await warmBothInstances();
});

describe("every server-side content type, saved on two instances", () => {
  const cases: Array<{
    type: string;
    save: (n: 1 | 2) => Promise<unknown>;
    file: (n: 1 | 2) => string;
  }> = [
    {
      type: "prompt",
      // One file, so the second save replaces the first: both must land, in
      // order, rather than the second being parked.
      save: n => commitWorkspacePrompt(WS, `prompt ${n}\n`),
      file: () => "PROMPT.md",
    },
    {
      type: "skills",
      save: n =>
        commitSkillSave(WS, {
          name: `skill_${n}`,
          loadWhen: "always",
          entities: [],
          suppressed: false,
          pinned: false,
          body: `body ${n}\n`,
        }),
      file: n => `skills/skill_${n}/SKILL.md`,
    },
    {
      type: "consoles",
      save: n =>
        commitConsoleBatch({
          workspaceId: WS,
          mutation: { writes: { [`consoles/q${n}.sql`]: `select ${n}\n` } },
          message: `console ${n}`,
          skipAdoption: true,
        }),
      file: n => `consoles/q${n}.sql`,
    },
    {
      type: "flows",
      save: n =>
        commitConfigToMain(
          WS,
          { writes: { [`flows/f${n}.yml`]: `name: f${n}\n` } },
          `flow ${n}`,
        ),
      file: n => `flows/f${n}.yml`,
    },
  ];

  for (const c of cases) {
    it(`${c.type}: a save on a behind instance lands on GitHub`, async () => {
      await on("a", () => c.save(1));
      // Instance b still has the clone from before a's save.
      await on("b", () => c.save(2));

      if (c.file(1) === c.file(2)) {
        const content = await mirrorFile(c.file(2));
        expect(content).toContain("2");
        // a's save is history on main, not parked.
        const { stdout } = await runGit([
          "-C",
          remoteDir,
          "log",
          "--format=%s",
          DEFAULT_BRANCH,
        ]);
        expect(stdout.split("\n").filter(Boolean).length).toBe(3);
      } else {
        expect(await mirrorFile(c.file(1))).not.toBeNull();
        expect(await mirrorFile(c.file(2))).not.toBeNull();
      }
      // Neither clone holds work GitHub does not have.
      const head = await mirrorHead();
      expect(await on("b", localHead)).toBe(head);
    });
  }

  it("merge to main: a merge on a behind instance lands on GitHub", async () => {
    // A branch with work, on GitHub.
    const mainHead = await mirrorHead();
    const featCommit = await commitBlobsOnBranch(
      remoteDir,
      DEFAULT_BRANCH,
      { writes: { "apps/x/feat.txt": "feat\n" } },
      { message: "feat" },
    );
    await runGit([
      "-C",
      remoteDir,
      "update-ref",
      "refs/heads/feat",
      featCommit.commitOid,
    ]);
    await runGit([
      "-C",
      remoteDir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      mainHead,
    ]);
    // Instance a saves to main; b has not seen it.
    await on("a", () => commitWorkspacePrompt(WS, "from a\n"));

    const result = await on("b", () =>
      mergeBranchToMain(
        { workspaceId: WS, root: null, defaultBranch: DEFAULT_BRANCH },
        "feat",
      ),
    );
    expect(result.merged).toBe(true);
    expect(await mirrorFile("apps/x/feat.txt")).toBe("feat\n");
    expect(await mirrorFile("PROMPT.md")).toBe("from a\n");
    expect(await on("b", localHead)).toBe(await mirrorHead());
  });
});

describe("commitToWorkspace", () => {
  it("re-runs the write on GitHub's tip when GitHub moved mid-save", async () => {
    let runs = 0;
    await on("a", () =>
      commitToWorkspace(WS, async () => {
        runs++;
        if (runs === 1) {
          // A sibling's push lands between this save's freshen and its push.
          await commitBlobsOnBranch(
            remoteDir,
            DEFAULT_BRANCH,
            { writes: { "sibling.txt": "sibling\n" } },
            { message: "sibling" },
          );
        }
        return commitBlobsOnBranch(
          repoDirFor(WS),
          DEFAULT_BRANCH,
          { writes: { "mine.txt": "mine\n" } },
          { message: "mine" },
        );
      }),
    );
    expect(runs).toBe(2);
    expect(await mirrorFile("sibling.txt")).toBe("sibling\n");
    expect(await mirrorFile("mine.txt")).toBe("mine\n");
  });

  it("fails the save and keeps nothing locally when GitHub refuses it", async () => {
    const before = await mirrorHead();
    await fs.writeFile(
      path.join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    await expect(
      on("a", () => commitWorkspacePrompt(WS, "never saved\n")),
    ).rejects.toBeInstanceOf(WorkspaceSaveNotPushedError);
    expect(await mirrorHead()).toBe(before);
    expect(await on("a", localHead)).toBe(before);
  });

  it("moves the shared head pointer on every push", async () => {
    await on("a", () => commitWorkspacePrompt(WS, "one\n"));
    expect(await readBranchHead(WS, DEFAULT_BRANCH)).toBe(await mirrorHead());
    await on("b", () => commitWorkspacePrompt(WS, "two\n"));
    expect(await readBranchHead(WS, DEFAULT_BRANCH)).toBe(await mirrorHead());
  });

  it("a read on another instance sees a save at once via the pointer", async () => {
    // Both instances fetched moments ago, so a timer alone would not fetch.
    await on("a", () => commitWorkspacePrompt(WS, "fresh\n"));
    await on("b", () => freshenForServe(WS));
    expect(await on("b", localHead)).toBe(await mirrorHead());
  });
});

describe("branch head pointer", () => {
  it("advances on a matching swap and drops on a mismatch", async () => {
    const sha = (c: string) => c.repeat(40);
    await advanceBranchHead(WS, "main", null, sha("a"));
    expect(await readBranchHead(WS, "main")).toBe(sha("a"));
    await advanceBranchHead(WS, "main", sha("a"), sha("b"));
    expect(await readBranchHead(WS, "main")).toBe(sha("b"));
    // A webhook delivered out of order: it replaces something else.
    await advanceBranchHead(WS, "main", sha("c"), sha("d"));
    expect(await readBranchHead(WS, "main")).toBeNull();
    // Branch deleted on GitHub.
    await advanceBranchHead(WS, "feat", null, sha("e"));
    await advanceBranchHead(WS, "feat", sha("e"), "0".repeat(40));
    expect(
      await WorkspaceRepoHead.countDocuments({
        workspaceId: new Types.ObjectId(WS),
        branch: "feat",
      }),
    ).toBe(0);
  });
});
