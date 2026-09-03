/**
 * §13.17 — connected customer repos as durable mirrors.
 *
 * Real git against file:// remotes (APPS_GITHUB_REMOTE_BASE); Mongo and
 * GitHub auth are mocked at the module boundary. What must hold:
 *
 *  - a workspace binding is the mirror, but only where the
 *    connected tier is enabled (prod / explicit opt-in) — previews and dev on
 *    prod-cloned DBs must treat customer bindings as inert
 *  - connect-time adoption: seed an empty repo, import a non-empty repo into
 *    an empty workspace, reconnect a repo that shares the workspace's
 *    history (unlink never touches the local repo, so a re-link finds both
 *    sides populated), refuse only when both sides have UNRELATED content
 *  - a customer remote is NEVER force-pushed: a diverged remote branch
 *    survives our push attempt; only refs/mako/* may move non-fast-forward
 *  - webhook fetch fast-forwards the local branch, leaves a merely-ahead
 *    branch alone, and on divergence resets to the mirror with the local
 *    tip parked under refs/mako/diverged/* (nothing dropped, cache honest)
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
}));

vi.mock("../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
  findWorkspaceIdsByRepoBinding: vi.fn(async () => []),
}));

vi.mock("../database/workspace-schema", () => ({
  Workspace: { updateOne: vi.fn(async () => ({})) },
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
  ensureCommitLocally,
  fetchFromCloud,
  mirrorPushNow,
  resolveMirrorTarget,
  freshenForServe,
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
    const target = await resolveMirrorTarget(workspaceId);
    expect(target).toMatchObject({ kind: "connected", owner: "acme" });
  });

  it("treats the binding as inert metadata where the tier is gated off", async () => {
    delete process.env.APPS_CONNECTED_REPO_PUSH; // dev, no opt-in → gated
    state.binding = { owner: "acme", repo: "site" };
    const target = await resolveMirrorTarget(workspaceId);
    expect(target).toBeNull();
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

  it("reconnects a repo that already holds the workspace's history", async () => {
    // Connect, disconnect (the local repo stays), connect again.
    const remoteDir = await makeBareRemote("acme", "relink-same");
    state.binding = { owner: "acme", repo: "relink-same" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    expect(await adoptConnectedRepo(workspaceId, state.binding)).toBe("seeded");
    const head = await headOf(repoDirFor(workspaceId));

    expect(await adoptConnectedRepo(workspaceId, state.binding)).toBe(
      "reconnected",
    );
    expect(await headOf(repoDirFor(workspaceId))).toBe(head);
    expect(await headOf(remoteDir)).toBe(head);
  });

  it("reconnect pushes commits made while the repo was disconnected", async () => {
    const remoteDir = await makeBareRemote("acme", "relink-behind");
    state.binding = { owner: "acme", repo: "relink-behind" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const local = await commitFiles(
      repoDirFor(workspaceId),
      { "apps/b/mako.json": "{}" },
      "made while unlinked",
    );

    expect(await adoptConnectedRepo(workspaceId, state.binding)).toBe(
      "reconnected",
    );
    expect(await headOf(remoteDir)).toBe(local);
  });

  it("reconnect fast-forwards to a repo that moved on GitHub meanwhile", async () => {
    const remoteDir = await makeBareRemote("acme", "relink-ahead");
    state.binding = { owner: "acme", repo: "relink-ahead" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const theirs = await commitFiles(
      remoteDir,
      { "apps/c/mako.json": "{}" },
      "pushed to GitHub while unlinked",
    );

    expect(await adoptConnectedRepo(workspaceId, state.binding)).toBe(
      "reconnected",
    );
    expect(await headOf(repoDirFor(workspaceId))).toBe(theirs);
    const entries = await listTree(repoDirFor(workspaceId), DEFAULT_BRANCH);
    expect(entries.map(e => e.path)).toContain("apps/c/mako.json");
  });

  it("reconnect on a diverged shared history lets the mirror win and parks the local tip", async () => {
    const remoteDir = await makeBareRemote("acme", "relink-split");
    state.binding = { owner: "acme", repo: "relink-split" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const theirs = await commitFiles(
      remoteDir,
      { "theirs.txt": "x" },
      "theirs",
    );
    const ours = await commitFiles(
      repoDirFor(workspaceId),
      { "ours.txt": "y" },
      "ours",
    );

    expect(await adoptConnectedRepo(workspaceId, state.binding)).toBe(
      "reconnected",
    );
    expect(await headOf(repoDirFor(workspaceId))).toBe(theirs);
    expect(await headOf(remoteDir)).toBe(theirs);
    const parked = (
      await runGit([
        "-C",
        remoteDir,
        "rev-parse",
        `refs/mako/diverged/${DEFAULT_BRANCH}/${ours.slice(0, 12)}`,
      ])
    ).stdout.trim();
    expect(parked).toBe(ours);
  });

  it("refuses when both the repo and the workspace have unrelated content", async () => {
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

/**
 * Serving a published app reads its binding files AT the published sha. On a
 * multi-instance host only the instance that handled the push has that
 * commit; the rest hold a clone that predates it, and ensureLocalRepo is
 * happy because a repo dir exists. That is `fatal: not a tree object` on a
 * live app's data — so a miss must fetch, not fail.
 */
describe("ensureCommitLocally", () => {
  it("fetches a commit this instance's cache has never seen", async () => {
    const remoteDir = await makeBareRemote("acme", "published");
    state.binding = { owner: "acme", repo: "published" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    // Another instance publishes: the commit exists only on the mirror.
    const publishedSha = await commitFiles(
      remoteDir,
      { "apps/a/bindings/x.sql": "-- connection: c\nSELECT 1\n" },
      "publish from another instance",
    );
    await expect(
      runGit([
        "-C",
        repoDirFor(workspaceId),
        "cat-file",
        "-e",
        `${publishedSha}^{commit}`,
      ]),
    ).rejects.toThrow();

    await ensureCommitLocally(workspaceId, publishedSha);

    await expect(
      runGit([
        "-C",
        repoDirFor(workspaceId),
        "cat-file",
        "-e",
        `${publishedSha}^{commit}`,
      ]),
    ).resolves.toBeDefined();
  });

  it("does not fetch when the commit is already here", async () => {
    await makeBareRemote("acme", "already");
    state.binding = { owner: "acme", repo: "already" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const local = await headOf(repoDirFor(workspaceId));
    // No remote branch to fetch: a fetch here would throw, so passing proves
    // the present-commit path never reached the network.
    await expect(
      ensureCommitLocally(workspaceId, local as string),
    ).resolves.toBeUndefined();
  });

  it("leaves the caller's own error for a sha that is nowhere", async () => {
    const remoteDir = await makeBareRemote("acme", "missing");
    state.binding = { owner: "acme", repo: "missing" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    await commitFiles(remoteDir, { "r.txt": "remote" }, "remote side");
    // Unknown sha: it must return quietly (the git command the caller runs
    // next is what reports the real, specific failure), not throw here.
    await expect(
      ensureCommitLocally(workspaceId, "0".repeat(40)),
    ).resolves.toBeUndefined();
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

  it("leaves a local branch that is merely ahead alone (its push is pending)", async () => {
    const remoteDir = await makeBareRemote("acme", "ahead-local");
    state.binding = { owner: "acme", repo: "ahead-local" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const ourCommit = await commitFiles(
      repoDirFor(workspaceId),
      { "l.txt": "local" },
      "committed here, not pushed yet",
    );

    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    expect(await headOf(repoDirFor(workspaceId))).toBe(ourCommit);
    expect(await headOf(remoteDir)).not.toBe(ourCommit);
  });

  it("on divergence the mirror wins and the local tip is parked under refs/mako/diverged", async () => {
    const remoteDir = await makeBareRemote("acme", "split");
    state.binding = { owner: "acme", repo: "split" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);
    const theirCommit = await commitFiles(
      remoteDir,
      { "r.txt": "remote" },
      "remote side",
    );
    const ourCommit = await commitFiles(
      repoDirFor(workspaceId),
      { "l.txt": "local" },
      "local side",
    );

    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    // The cache agrees with its source again…
    expect(await headOf(repoDirFor(workspaceId))).toBe(theirCommit);
    // …and nothing was dropped: the local tip is parked, here and — via the
    // forced refs/mako/* namespace — on the mirror, where it can be recovered.
    const parked = `refs/mako/diverged/${DEFAULT_BRANCH}/${ourCommit.slice(0, 12)}`;
    const localParked = await runGit([
      "-C",
      repoDirFor(workspaceId),
      "rev-parse",
      parked,
    ]);
    expect(localParked.stdout.trim()).toBe(ourCommit);
    // fetchFromCloud queued the push; a push scheduled now starts after it.
    await mirrorPushNow(workspaceId);
    const remoteParked = await runGit(["-C", remoteDir, "rev-parse", parked]);
    expect(remoteParked.stdout.trim()).toBe(ourCommit);
    // The mirror's own main was never touched.
    expect(await headOf(remoteDir)).toBe(theirCommit);
  });
});

/**
 * serveGit calls this before answering a FETCH: an instance whose clone
 * predates a push must pull the mirror or a just-pushed sha is
 * `upload-pack: not our ref` (the deploy-on-push race seen in prod).
 */
describe("freshenForServe", () => {
  it("makes a mirror-only commit servable, and throttles repeat calls", async () => {
    const remoteDir = await makeBareRemote("acme", "freshen");
    state.binding = { owner: "acme", repo: "freshen" };
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await adoptConnectedRepo(workspaceId, state.binding);

    // Another instance handled a push: the commit exists only on the mirror.
    const pushedSha = await commitFiles(
      remoteDir,
      { "apps/a/index.html": "<h1>new</h1>" },
      "push handled elsewhere",
    );
    const has = (sha: string) =>
      runGit([
        "-C",
        repoDirFor(workspaceId),
        "cat-file",
        "-e",
        `${sha}^{commit}`,
      ]);
    await expect(has(pushedSha)).rejects.toThrow();

    await freshenForServe(workspaceId);
    await expect(has(pushedSha)).resolves.toBeDefined();

    // Inside the throttle window a newer mirror commit is NOT pulled…
    const laterSha = await commitFiles(
      remoteDir,
      { "apps/a/later.txt": "later" },
      "later push",
    );
    await freshenForServe(workspaceId);
    await expect(has(laterSha)).rejects.toThrow();

    // …and a zero-interval call (the window elapsed) pulls it.
    await freshenForServe(workspaceId, 0);
    await expect(has(laterSha)).resolves.toBeDefined();
  });

  it("serves local state quietly when the mirror is unreachable", async () => {
    state.binding = null; // no connected repo — nothing to freshen from
    await initRepo(repoDirFor(workspaceId), { "apps/a/mako.json": "{}" });
    await expect(freshenForServe(workspaceId, 0)).resolves.toBeUndefined();
  });
});
