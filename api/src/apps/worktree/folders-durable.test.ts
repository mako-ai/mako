/**
 * App moves, folder writes and app creation land on the mirror's main even
 * when GitHub's main moves under them. Real git (a file:// "GitHub" remote
 * and the instance's local bare cache) with workspace metadata in PGlite.
 *
 * On 2026-11-18 at 23:30 UTC four POST /apps/:id/move calls failed with
 * "Could not store the change durably (GitHub push failed)". The push sent
 * every local branch: main was rejected non-fast-forward (a merge had just
 * landed) and so were six stale claude/* branches. What must hold:
 *
 *   RACE   — main moving on GitHub between our fetch and our push costs a
 *            retry: both commits end up on the mirror's main.
 *   STALE  — a local branch GitHub would reject does not fail a main write,
 *            and is left alone on both sides.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";
import {
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../cloud-repo/fetch", async importOriginal => {
  const { withFreshenHook } =
    await import("../cloud-repo/durable-main.testkit");
  return withFreshenHook(
    await importOriginal<typeof import("../cloud-repo/fetch")>(),
  );
});

import { runGit } from "../git";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../repository.service";
import {
  commitOnRemoteMain,
  freshenHooks,
  resetFreshenHooks,
  seedMirroredWorkspace,
} from "../cloud-repo/durable-main.testkit";
import { invalidateAppsIndexCache } from "../app-index.service";
import {
  createAppFolder,
  createProject,
  moveAppFolder,
  moveProject,
  resolveProjectRef,
} from "../worktree.service";

const A_ID = new Types.ObjectId().toHexString();
const manifest = (title: string, id: string) =>
  `${JSON.stringify({ id, schemaVersion: 1, title }, null, 2)}\n`;

let pgh: PgTestDb;
let tmpRoot: string;
let remoteDir: string;
let WS: string;

const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const head = (dir: string, ref = MAIN) => resolveCommit(dir, ref);

async function remoteFile(rel: string): Promise<string | null> {
  try {
    return (await readBlob(remoteDir, (await head(remoteDir))!, rel)).contents;
  } catch {
    return null;
  }
}

async function isAncestor(ancestor: string, of: string): Promise<boolean> {
  return runGit(["-C", remoteDir, "merge-base", "--is-ancestor", ancestor, of])
    .then(() => true)
    .catch(() => false);
}

/**
 * Move GitHub's main right after the write's own freshen (the last one
 * before its commit), and return the other writer's commit once it ran.
 */
function raceOnNextWrite(): () => string {
  let theirs: string | null = null;
  const at = freshenHooks.calls + 1;
  freshenHooks.after.set(at, async () => {
    theirs = await commitOnRemoteMain(remoteDir, {
      writes: { "notes/other.md": "from another instance\n" },
    });
  });
  return () => {
    expect(theirs, "the other writer never ran").not.toBeNull();
    return theirs!;
  };
}

/** The same branch with different commits locally and on GitHub. */
async function divergedBranch(name: string): Promise<{
  local: string;
  remote: string;
}> {
  const local = repoDirFor(WS);
  for (const dir of [local, remoteDir]) {
    await runGit(["-C", dir, "branch", name, DEFAULT_BRANCH]);
  }
  const ours = await commitBlobsOnBranch(
    local,
    name,
    { writes: { "notes/stale.md": "this instance\n" } },
    { message: "stale local work" },
  );
  const theirs = await commitBlobsOnBranch(
    remoteDir,
    name,
    { writes: { "notes/stale.md": "github\n" } },
    { message: "pushed from a laptop" },
  );
  return { local: ours.commitOid, remote: theirs.commitOid };
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "folders-durable-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${path.join(tmpRoot, "remotes")}`;
  pgh = await setupPgTestDb();
}, 120_000);

afterAll(async () => {
  await pgh.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  resetFreshenHooks();
  WS = new Types.ObjectId().toString();
  await pgh.reset();
  await ensureTestWorkspace(pgh.db, { id: WS });
  invalidateAppsIndexCache();
  remoteDir = await seedMirroredWorkspace(path.join(tmpRoot, "remotes"), WS, {
    "README.md": "x\n",
    "apps/a/mako.json": manifest("A", A_ID),
    "apps/a/src/main.tsx": "export {}\n",
    "apps/Ops/.gitkeep": "",
  });
});

afterEach(() => {
  delete process.env.APPS_CONNECTED_REPO_PUSH;
});

describe("in-app main writes against a moving GitHub main", () => {
  it("RACE: an app move lands when GitHub's main moves mid-write", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    const treeBefore = (
      await runGit(["-C", remoteDir, "rev-parse", `${MAIN}:apps/a`])
    ).stdout.trim();
    const theirs = raceOnNextWrite();

    const moved = await moveProject(a, {
      scope: "workspace",
      folderSegments: ["Ops"],
    });

    expect(moved).toEqual({ from: "apps/a", to: "apps/Ops/a" });
    const tip = (await head(remoteDir))!;
    expect(await head(repoDirFor(WS))).toBe(tip);
    expect(await isAncestor(theirs(), tip)).toBe(true);
    expect(await remoteFile("notes/other.md")).toBe("from another instance\n");
    expect(await remoteFile("apps/a/mako.json")).toBeNull();
    expect(await remoteFile("apps/Ops/a/mako.json")).toBe(manifest("A", A_ID));
    // The folder moved whole: same tree, so nothing rebuilds.
    const treeAfter = (
      await runGit(["-C", remoteDir, "rev-parse", `${tip}:apps/Ops/a`])
    ).stdout.trim();
    expect(treeAfter).toBe(treeBefore);
  });

  it("RACE: folder writes land when GitHub's main moves mid-write", async () => {
    const first = raceOnNextWrite();
    await createAppFolder(WS, { scope: "workspace", folderSegments: ["New"] });
    expect(await isAncestor(first(), (await head(remoteDir))!)).toBe(true);
    expect(await remoteFile("apps/New/.gitkeep")).toBe("");

    const second = raceOnNextWrite();
    await moveAppFolder(
      WS,
      { scope: "workspace", folderSegments: ["Ops"] },
      { scope: "workspace", folderSegments: ["Ops2"] },
    );
    const tip = (await head(remoteDir))!;
    expect(await isAncestor(second(), tip)).toBe(true);
    expect(await head(repoDirFor(WS))).toBe(tip);
    expect(await remoteFile("apps/Ops/.gitkeep")).toBeNull();
    expect(await remoteFile("apps/Ops2/.gitkeep")).toBe("");
  });

  it("RACE: app creation lands when GitHub's main moves mid-write", async () => {
    const theirs = raceOnNextWrite();
    const project = await createProject({ workspaceId: WS, title: "Fresh" });
    const tip = (await head(remoteDir))!;
    expect(await head(repoDirFor(WS))).toBe(tip);
    expect(await isAncestor(theirs(), tip)).toBe(true);
    const created = await remoteFile(`${project.path}/mako.json`);
    expect(JSON.parse(created!).id).toBe(project._id.toString());
  });

  it("STALE: a branch GitHub would reject does not fail an app move", async () => {
    const stale = await divergedBranch("claude/stale-1");
    const a = (await resolveProjectRef(WS, "a"))!;

    await moveProject(a, { scope: "workspace", folderSegments: ["Ops"] });

    const tip = (await head(remoteDir))!;
    expect(await head(repoDirFor(WS))).toBe(tip);
    expect(await remoteFile("apps/Ops/a/mako.json")).toBe(manifest("A", A_ID));
    // Neither side of the stale branch moved.
    const branch = "refs/heads/claude/stale-1";
    expect(await head(remoteDir, branch)).toBe(stale.remote);
    expect(await head(repoDirFor(WS), branch)).toBe(stale.local);
  });
});
