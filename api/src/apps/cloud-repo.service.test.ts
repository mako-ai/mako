/**
 * §13.17 — connected customer repos as durable mirrors.
 *
 * Real git against file:// remotes (APPS_GITHUB_REMOTE_BASE); Mongo and
 * GitHub auth are mocked at the module boundary. What must hold:
 *
 *  - a workspace binding outranks the mako-cloud pointer, but only where the
 *    connected tier is enabled (prod / explicit opt-in) — previews and dev on
 *    prod-cloned DBs must treat customer bindings as inert
 *  - connect-time adoption: seed an empty repo, import a non-empty repo into
 *    an empty workspace, refuse when both sides have content
 *  - a customer remote is NEVER force-pushed: a diverged remote branch
 *    survives our push attempt; only refs/mako/* may move non-fast-forward
 *  - webhook fetch fast-forwards the local branch and stands still on
 *    divergence instead of dropping either side
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  binding: null as null | {
    owner: string;
    repo: string;
    installationId?: number;
  },
  pointer: null as null | { owner: string; repo: string },
}));

vi.mock("../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
}));

vi.mock("../database/workspace-schema", () => ({
  Workspace: {
    findById: () => ({
      select: () => ({
        lean: async () => ({ appsCloudRepo: state.pointer }),
      }),
    }),
    updateOne: vi.fn(async () => ({})),
  },
}));

vi.mock("../integrations/github/cloud-app-auth", () => ({
  getMakoCloudOrg: () => undefined,
  getMakoCloudRepoPrefix: () => "dev",
  getMakoCloudToken: async () => {
    throw new Error("mako cloud not configured in this test");
  },
  isMakoCloudConfigured: () => false,
}));

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));

import { runGit } from "./git";
import {
  DEFAULT_BRANCH,
  commitTree,
  initRepo,
  listTree,
  repoDirFor,
  repoExists,
  snapshotDirToTree,
  updateRefCas,
} from "./repository.service";
import {
  adoptConnectedRepo,
  fetchFromCloud,
  mirrorPushNow,
  resolveMirrorTarget,
} from "./cloud-repo.service";

let tmpRoot: string;
let remotesRoot: string;
let seq = 0;
/** Valid ObjectId string, unique per test. */
function freshWorkspaceId(): string {
  seq += 1;
  return (700000000000 + seq).toString().padStart(24, "0");
}
let workspaceId: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-repo-test-"));
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
});

beforeEach(() => {
  workspaceId = freshWorkspaceId();
  state.binding = null;
  state.pointer = null;
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
});

afterEach(() => {
  delete process.env.APPS_CONNECTED_REPO_PUSH;
});

async function makeBareRemote(owner: string, repo: string): Promise<string> {
  const dir = path.join(remotesRoot, owner, `${repo}.git`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await runGit(["init", "--bare", "-b", DEFAULT_BRANCH, dir]);
  return dir;
}

/** Add a commit with `files` on top of `repoDir`'s current main (or root). */
async function commitFiles(
  repoDir: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  const work = await fs.mkdtemp(path.join(tmpRoot, "work-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(work, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, "utf8");
    }
    const treeOid = await snapshotDirToTree(repoDir, work);
    const head = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      `refs/heads/${DEFAULT_BRANCH}`,
    ])
      .then(r => r.stdout.trim())
      .catch(() => null);
    const commitOid = await commitTree(repoDir, {
      treeOid,
      parents: head ? [head] : [],
      message,
    });
    await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      commitOid,
      head ?? "0".repeat(40),
    );
    return commitOid;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function headOf(repoDir: string): Promise<string | null> {
  return runGit([
    "-C",
    repoDir,
    "rev-parse",
    "--verify",
    `refs/heads/${DEFAULT_BRANCH}`,
  ])
    .then(r => r.stdout.trim())
    .catch(() => null);
}

describe("resolveMirrorTarget", () => {
  it("prefers the connected binding when the tier is enabled", async () => {
    state.binding = { owner: "acme", repo: "site" };
    state.pointer = { owner: "mako-ai-cloud", repo: "dev-x" };
    const target = await resolveMirrorTarget(workspaceId);
    expect(target).toMatchObject({ kind: "connected", owner: "acme" });
  });

  it("treats the binding as inert metadata where the tier is gated off", async () => {
    delete process.env.APPS_CONNECTED_REPO_PUSH; // prefix "dev" → gated
    state.binding = { owner: "acme", repo: "site" };
    state.pointer = { owner: "mako-ai-cloud", repo: "dev-x" };
    const target = await resolveMirrorTarget(workspaceId);
    expect(target).toMatchObject({ kind: "mako-cloud", repo: "dev-x" });
  });
});

describe("adoptConnectedRepo", () => {
  it("seeds an empty repo with the workspace's history", async () => {
    const remoteDir = await makeBareRemote("acme", "empty");
    state.binding = { owner: "acme", repo: "empty" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });

    const mode = await adoptConnectedRepo(workspaceId, state.binding);
    expect(mode).toBe("seeded");
    expect(await headOf(remoteDir)).toBe(await headOf(repoDirFor(workspaceId)));
  });

  it("imports a non-empty repo into a workspace with no history", async () => {
    const remoteDir = path.join(remotesRoot, "acme", "existing.git");
    await fs.mkdir(path.dirname(remoteDir), { recursive: true });
    await initRepo(remoteDir, { "apps/imported/mako.json": "{}" });
    state.binding = { owner: "acme", repo: "existing" };

    const mode = await adoptConnectedRepo(workspaceId, state.binding);
    expect(mode).toBe("imported");
    expect(await repoExists(repoDirFor(workspaceId))).toBe(true);
    const entries = await listTree(repoDirFor(workspaceId), DEFAULT_BRANCH);
    expect(entries.map(e => e.path)).toContain("apps/imported/mako.json");
  });

  it("refuses when both the repo and the workspace have content", async () => {
    const remoteDir = path.join(remotesRoot, "acme", "busy.git");
    await fs.mkdir(path.dirname(remoteDir), { recursive: true });
    await initRepo(remoteDir, { "README.md": "not mako" });
    state.binding = { owner: "acme", repo: "busy" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    const localHead = await headOf(repoDirFor(workspaceId));

    await expect(
      adoptConnectedRepo(workspaceId, state.binding),
    ).rejects.toThrow(/already has content/);
    // Neither side was touched.
    expect(await headOf(repoDirFor(workspaceId))).toBe(localHead);
    expect(
      (await listTree(remoteDir, DEFAULT_BRANCH)).map(e => e.path),
    ).toEqual(["README.md"]);
  });

  it("is inert (deferred) where the tier is gated off", async () => {
    delete process.env.APPS_CONNECTED_REPO_PUSH;
    state.binding = { owner: "acme", repo: "whatever" };
    const mode = await adoptConnectedRepo(workspaceId, state.binding);
    expect(mode).toBe("deferred");
  });
});

describe("pushes to a connected repo", () => {
  it("never force-pushes a diverged customer branch", async () => {
    const remoteDir = await makeBareRemote("acme", "site");
    state.binding = { owner: "acme", repo: "site" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);

    // Someone pushes to GitHub directly…
    const theirCommit = await commitFiles(
      remoteDir,
      { "theirs.txt": "kept" },
      "direct push to GitHub",
    );
    // …while Mako commits divergently on the same parent.
    await commitFiles(
      repoDirFor(workspaceId),
      { "ours.txt": "mako" },
      "mako-side commit",
    );

    await expect(mirrorPushNow(workspaceId)).rejects.toThrow();
    expect(await headOf(remoteDir)).toBe(theirCommit);
  });

  it("force-updates only the refs/mako/* namespace", async () => {
    const remoteDir = await makeBareRemote("acme", "wip");
    state.binding = { owner: "acme", repo: "wip" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const repoDir = repoDirFor(workspaceId);
    const head = await headOf(repoDir);
    if (!head) throw new Error("seeded repo must have a head");

    // Two successive WIP snapshots that do NOT fast-forward each other.
    const wipA = await commitFiles(repoDir, { "w.txt": "a" }, "wip a");
    await runGit([
      "-C",
      repoDir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      head,
    ]);
    await runGit(["-C", repoDir, "update-ref", "refs/mako/wip", wipA]);
    await mirrorPushNow(workspaceId);
    const wipB = await commitFiles(repoDir, { "w.txt": "b" }, "wip b");
    await runGit([
      "-C",
      repoDir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      head,
    ]);
    await runGit(["-C", repoDir, "update-ref", "refs/mako/wip", wipB]);
    await mirrorPushNow(workspaceId);

    const remoteWip = (
      await runGit(["-C", remoteDir, "rev-parse", "refs/mako/wip"])
    ).stdout.trim();
    expect(remoteWip).toBe(wipB);
  });
});

describe("fetchFromCloud on a connected repo", () => {
  it("fast-forwards the local branch when the remote is ahead", async () => {
    const remoteDir = await makeBareRemote("acme", "ahead");
    state.binding = { owner: "acme", repo: "ahead" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const theirCommit = await commitFiles(
      remoteDir,
      { "new.txt": "from github" },
      "pushed on GitHub",
    );

    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    expect(await headOf(repoDirFor(workspaceId))).toBe(theirCommit);
  });

  it("stands still on divergence instead of dropping either side", async () => {
    const remoteDir = await makeBareRemote("acme", "split");
    state.binding = { owner: "acme", repo: "split" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    await commitFiles(remoteDir, { "r.txt": "remote" }, "remote side");
    const ourCommit = await commitFiles(
      repoDirFor(workspaceId),
      { "l.txt": "local" },
      "local side",
    );

    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    expect(await headOf(repoDirFor(workspaceId))).toBe(ourCommit);
  });
});
