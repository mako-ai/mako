/**
 * Shared helpers for the rename SCENARIO suites (flows, dbt jobs). Not a
 * test file: each `*.scenarios.test.ts` owns its `vi.mock`s and imports
 * these, which then see the mocked modules like any other import.
 *
 * Everything here is real git: a laptop clone that runs `git mv` and
 * `git push` against the workspace's bare repo, a `file://` mirror standing
 * in for GitHub, and a second repo root standing in for another API
 * instance (its clone is a cache of the mirror, exactly as in production).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runGit } from "../../apps/git";
import {
  DEFAULT_BRANCH,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";

const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

export async function headOf(workspaceId: string): Promise<string> {
  return (await resolveCommit(repoDirFor(workspaceId), MAIN_REF)) as string;
}

/** The file at main, or null when it is not there. */
export async function fileAtMain(
  workspaceId: string,
  rel: string,
): Promise<string | null> {
  try {
    const dir = repoDirFor(workspaceId);
    return (await readBlob(dir, await headOf(workspaceId), rel)).contents;
  } catch {
    return null;
  }
}

/** Every path at main under `prefix`, sorted. */
export async function pathsAtMain(
  workspaceId: string,
  prefix: string,
): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "ls-tree",
    "-r",
    "--name-only",
    DEFAULT_BRANCH,
    "--",
    prefix,
  ]);
  return stdout.split("\n").filter(Boolean).sort();
}

export async function commitCountOf(workspaceId: string): Promise<number> {
  const dir = repoDirFor(workspaceId);
  const { stdout } = await runGit(["-C", dir, "rev-list", "--count", MAIN_REF]);
  return Number(stdout.trim());
}

/** The paths a commit touched (both sides of a move), sorted. */
export async function pathsTouchedBy(
  workspaceId: string,
  commit: string,
): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    `${commit}^`,
    commit,
  ]);
  return stdout.split("\n").filter(Boolean).sort();
}

/**
 * The mirror every test workspace is bound to (`bindTestWorkspaceRepo`:
 * test-owner/test-repo) under `APPS_GITHUB_REMOTE_BASE=file://<remotesRoot>`.
 */
export function mirrorDirIn(remotesRoot: string): string {
  return path.join(remotesRoot, "test-owner", "test-repo.git");
}

/** Create the mirror from the workspace repo as it is now (main only). */
export async function seedMirror(
  workspaceId: string,
  remotesRoot: string,
): Promise<void> {
  const mirror = mirrorDirIn(remotesRoot);
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  await runGit(["init", "--bare", "-q", "-b", DEFAULT_BRANCH, mirror]);
  const dir = repoDirFor(workspaceId);
  await runGit(["-C", dir, "push", "-q", mirror, `${MAIN_REF}:${MAIN_REF}`]);
}

export async function mirrorMain(remotesRoot: string): Promise<string> {
  const mirror = mirrorDirIn(remotesRoot);
  return (await runGit(["-C", mirror, "rev-parse", MAIN_REF])).stdout.trim();
}

const LAPTOP_IDENTITY = [
  "-c",
  "user.name=laptop",
  "-c",
  "user.email=laptop@example.com",
  "-c",
  "commit.gpgsign=false",
];

/**
 * A working clone of the workspace repo, as a person's laptop has it. A
 * push lands in the bare repo as Mako's git endpoint would receive it; the
 * caller then runs the push sync the endpoint triggers.
 */
export class Laptop {
  private constructor(readonly dir: string) {}

  static async clone(workspaceId: string, root: string): Promise<Laptop> {
    await fs.mkdir(root, { recursive: true });
    const dir = await fs.mkdtemp(path.join(root, "laptop-"));
    await runGit(["clone", "-q", repoDirFor(workspaceId), dir]);
    return new Laptop(dir);
  }

  git(args: string[]) {
    return runGit([...LAPTOP_IDENTITY, "-C", this.dir, ...args]);
  }

  async mv(from: string, to: string): Promise<void> {
    await this.git(["mv", from, to]);
  }

  async write(rel: string, contents: string): Promise<void> {
    const abs = path.join(this.dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
    await this.git(["add", "--", rel]);
  }

  read(rel: string): Promise<string> {
    return fs.readFile(path.join(this.dir, rel), "utf8");
  }

  async rm(rel: string): Promise<void> {
    await this.git(["rm", "-q", "--", rel]);
  }

  /** Commit what is staged and push main. */
  async push(message: string): Promise<void> {
    await this.git(["commit", "-q", "-m", message]);
    await this.git(["push", "-q", "origin", `HEAD:${DEFAULT_BRANCH}`]);
  }
}

export function tmpRootFor(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}
