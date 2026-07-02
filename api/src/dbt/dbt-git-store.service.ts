/**
 * Git-backed file store for dbt projects — "nothing in Mongo, all in git".
 *
 * Every dbt project owns a BARE git repository on disk under DBT_GIT_ROOT
 * (`<root>/<workspaceId>/<projectId>.git`). File contents live exclusively in
 * git objects; Mongo keeps only metadata (projects, jobs, runs, checkouts).
 *
 *  - Blank (non-repo) projects: a single local branch (`main`) is the shared
 *    working tree every member edits — each save is a commit, so history is
 *    free.
 *  - Repo-bound projects: local branches mirror the GitHub remote
 *    (`git fetch` on sync, `git push` on commit, authenticated with the App
 *    installation token). Per-user uncommitted work lives in overlay refs:
 *      refs/mako/drafts/<user>       — draft tip (one commit per save)
 *      refs/mako/drafts-base/<user>  — the branch head the overlay forked from
 *    The user's pending changes are exactly `diff(drafts-base, drafts)`; the
 *    overlay is applied onto whatever branch their checkout points at, so
 *    drafts carry across branch switches and a base sync can never clobber
 *    them (same collaboration semantics as the previous Mongo draft rows).
 *
 * All operations shell out to the system `git` (no shell interpolation — argv
 * arrays only) with a hermetic environment (no user/system git config).
 * Ref updates use compare-and-swap (`git update-ref <ref> <new> <old>`), so
 * concurrent writers retry instead of clobbering each other.
 */

import { spawn } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { loggers } from "../logging";
import type { ResolvedRemote } from "./dbt-git-remote";

const logger = loggers.api("dbt-git-store");

/** SHA-1 of the empty tree (constant across every git repository). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** All-zeros object id — "ref must not exist" in update-ref CAS terms. */
export const ZERO_SHA = "0".repeat(40);

/** Per-file size cap (parity with the previous Mongo document limit). */
export const MAX_DBT_FILE_BYTES = 1_000_000;

export interface GitAuthor {
  name: string;
  email: string;
}

/** Commit identity for a Mako-side actor (userId or "agent"). */
export function authorFor(userId: string): GitAuthor {
  const safe = (userId || "unknown").replace(/[<>\n]/g, "_").slice(0, 128);
  return { name: safe, email: `${safe}@mako.dev` };
}

// ---------------------------------------------------------------------------
// Repo location
// ---------------------------------------------------------------------------

export function dbtGitRoot(): string {
  if (process.env.DBT_GIT_ROOT) return process.env.DBT_GIT_ROOT;
  if (process.env.NODE_ENV === "production") return "/data/dbt-git";
  return path.resolve(process.cwd(), ".data", "dbt-git");
}

function assertObjectIdLike(value: string, label: string): string {
  if (!/^[a-f0-9]{24}$/i.test(value)) {
    throw new Error(`Invalid ${label} for dbt git repo path`);
  }
  return value;
}

/** Absolute path of a project's bare repository. */
export function repoDirFor(workspaceId: string, projectId: string): string {
  return path.join(
    dbtGitRoot(),
    assertObjectIdLike(workspaceId, "workspaceId"),
    `${assertObjectIdLike(projectId, "projectId")}.git`,
  );
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** Branch used as the shared tree of blank (non-repo) projects. */
export const BLANK_PROJECT_BRANCH = "main";

/**
 * Encode an arbitrary identifier (user id, branch name) into a single safe
 * git ref path component. [A-Za-z0-9_-] pass through; every other byte is
 * escaped as `!xx` (hex). Never needs decoding — refs are always constructed
 * from known identifiers.
 */
export function encodeRefComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, ch =>
    [...Buffer.from(ch, "utf8")]
      .map(byte => `!${byte.toString(16).padStart(2, "0")}`)
      .join(""),
  );
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export interface DraftRefs {
  /** Draft tip — tree is the user's full working tree, one commit per save. */
  tip: string;
  /** Fork point — the branch head the overlay was started from. */
  base: string;
  /** Marker set once legacy Mongo drafts were imported for this user. */
  migrated: string;
}

export function draftRefsFor(userId: string): DraftRefs {
  const user = encodeRefComponent(userId);
  return {
    tip: `refs/mako/drafts/${user}`,
    base: `refs/mako/drafts-base/${user}`,
    migrated: `refs/mako/drafts-migrated/${user}`,
  };
}

// ---------------------------------------------------------------------------
// git invocation
// ---------------------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Hermetic git environment: no system/global config (a host's core.autocrlf
 * or hooks must never affect stored content), no terminal prompts, and no
 * inherited credentials.
 */
function gitEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function runGit(
  args: string[],
  opts: {
    cwd?: string;
    input?: Buffer | string;
    env?: Record<string, string>;
  } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr.on("data", chunk => stderr.push(chunk as Buffer));
    child.on("error", reject);
    child.on("close", code => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function git(
  repoDir: string,
  args: string[],
  opts: { input?: Buffer | string; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await runGit(args, { cwd: repoDir, ...opts });
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  return result.stdout.toString("utf8");
}

// ---------------------------------------------------------------------------
// Repo lifecycle
// ---------------------------------------------------------------------------

export function repoExists(repoDir: string): boolean {
  return existsSync(path.join(repoDir, "HEAD"));
}

/** Initialize the bare repository if missing. Returns the repo dir. */
export async function ensureBareRepo(repoDir: string): Promise<string> {
  if (repoExists(repoDir)) return repoDir;
  await mkdir(repoDir, { recursive: true });
  await runGitOrThrow(["init", "--bare", "--initial-branch", "main", repoDir]);
  return repoDir;
}

async function runGitOrThrow(args: string[]): Promise<void> {
  const result = await runGit(args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`,
    );
  }
}

export async function deleteRepoDir(repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Tree SHA of a commit-ish, or null when it does not resolve. */
export async function treeShaOf(
  repoDir: string,
  commitish: string,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", `${commitish}^{tree}`],
    { cwd: repoDir },
  );
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8").trim() || null;
}

/** Resolve a ref/treeish to a commit SHA, or null when it does not exist. */
export async function resolveCommit(
  repoDir: string,
  ref: string,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: repoDir },
  );
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8").trim() || null;
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

/**
 * Recursively list blobs of a tree-ish. Returns [] when the ref is missing
 * (e.g. a blank project before its first commit).
 */
export async function listTree(
  repoDir: string,
  ref: string,
): Promise<TreeEntry[]> {
  if (!(await resolveCommit(repoDir, ref))) return [];
  const out = await git(repoDir, ["ls-tree", "-r", "-l", "-z", ref]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (!record) continue;
    // "<mode> SP <type> SP <sha> SP+ <size> TAB <path>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    if (meta[1] !== "blob") continue;
    entries.push({
      path: record.slice(tab + 1),
      blobSha: meta[2],
      size: Number(meta[3]) || 0,
    });
  }
  return entries;
}

/** Read one file at a ref. Null when the ref or the path does not exist. */
export async function readBlobAt(
  repoDir: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const result = await runGit(["cat-file", "blob", `${ref}:${filePath}`], {
    cwd: repoDir,
  });
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8");
}

/**
 * Batch-read blobs by SHA (one `cat-file --batch` round-trip). Returns a
 * map of blobSha → utf8 content for every sha found.
 */
export async function readBlobs(
  repoDir: string,
  blobShas: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const unique = [...new Set(blobShas)];
  if (unique.length === 0) return contents;
  const result = await runGit(["cat-file", "--batch"], {
    cwd: repoDir,
    input: unique.join("\n") + "\n",
  });
  if (result.code !== 0) {
    throw new Error(`git cat-file --batch failed: ${result.stderr.trim()}`);
  }
  const buf = result.stdout;
  let offset = 0;
  while (offset < buf.length) {
    const headerEnd = buf.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = buf.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;
    const [sha, type, sizeRaw] = header.split(" ");
    if (type !== "blob") {
      // "<sha> missing" — skip (no body follows).
      continue;
    }
    const size = Number(sizeRaw) || 0;
    contents.set(sha, buf.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1; // trailing newline after each object body
  }
  return contents;
}

export interface TreeFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

/**
 * Name-status diff between two tree-ishes (renames reported as add+delete,
 * matching the working-tree status the IDE shows).
 */
export async function diffTrees(
  repoDir: string,
  fromRef: string,
  toRef: string,
): Promise<TreeFileChange[]> {
  const out = await git(repoDir, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-status",
    fromRef,
    toRef,
  ]);
  const parts = out.split("\0");
  const changes: TreeFileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const filePath = parts[i + 1];
    if (!status || !filePath) continue;
    changes.push({
      path: filePath,
      status:
        status[0] === "A"
          ? "added"
          : status[0] === "D"
            ? "deleted"
            : "modified",
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CommitTreeUpdateParams {
  /**
   * Full ref to update, e.g. refs/heads/main or refs/mako/drafts/u1. Omit to
   * create a dangling commit the caller refs (or discards) later.
   */
  ref?: string;
  /**
   * CAS guard: current SHA the ref must have (ZERO_SHA when the ref must not
   * exist yet). Omit to skip the guard (last write wins).
   */
  expectedOldSha?: string;
  /** Tree-ish the new tree starts from; omitted → empty tree. */
  baseTree?: string;
  /** Parent commit SHAs of the new commit. */
  parents: string[];
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
  message: string;
  author: GitAuthor;
}

export class RefCasError extends Error {
  constructor(ref: string) {
    super(`Concurrent update to ${ref} — retry`);
    this.name = "RefCasError";
  }
}

/**
 * Create a commit that applies `writes` + `deletes` on top of `baseTree` and
 * point `ref` at it (CAS-guarded). Returns the new commit SHA.
 */
export async function commitTreeUpdate(
  repoDir: string,
  params: CommitTreeUpdateParams,
): Promise<{ sha: string; treeSha: string }> {
  const scratch = await mkdtemp(path.join(tmpdir(), "mako-git-"));
  const indexFile = path.join(scratch, "index");
  const indexEnv = { GIT_INDEX_FILE: indexFile };
  try {
    if (params.baseTree) {
      await git(repoDir, ["read-tree", params.baseTree], { env: indexEnv });
    } else {
      await git(repoDir, ["read-tree", "--empty"], { env: indexEnv });
    }

    // Hash all written blobs in one spawn (contents staged as temp files).
    const blobShas: string[] = [];
    if (params.writes.length > 0) {
      const paths: string[] = [];
      for (let i = 0; i < params.writes.length; i++) {
        const tmpFile = path.join(scratch, `blob-${i}`);
        await writeFile(tmpFile, params.writes[i].content, "utf8");
        paths.push(tmpFile);
      }
      const out = await git(repoDir, ["hash-object", "-w", "--stdin-paths"], {
        input: paths.join("\n") + "\n",
      });
      blobShas.push(...out.trim().split("\n"));
      if (blobShas.length !== params.writes.length) {
        throw new Error("git hash-object returned unexpected output");
      }
    }

    // Apply writes + deletes to the index in one NUL-delimited batch.
    const indexInfo: string[] = [];
    params.writes.forEach((write, i) => {
      indexInfo.push(`100644 ${blobShas[i]}\t${write.path}`);
    });
    for (const del of params.deletes) {
      indexInfo.push(`0 ${ZERO_SHA}\t${del}`);
    }
    if (indexInfo.length > 0) {
      await git(repoDir, ["update-index", "-z", "--index-info"], {
        env: indexEnv,
        input: indexInfo.join("\0") + "\0",
      });
    }

    const treeSha = (
      await git(repoDir, ["write-tree"], { env: indexEnv })
    ).trim();

    const commitArgs = ["commit-tree", treeSha, "-m", params.message || "."];
    for (const parent of params.parents) commitArgs.push("-p", parent);
    const sha = (
      await git(repoDir, commitArgs, {
        env: {
          GIT_AUTHOR_NAME: params.author.name,
          GIT_AUTHOR_EMAIL: params.author.email,
          GIT_COMMITTER_NAME: params.author.name,
          GIT_COMMITTER_EMAIL: params.author.email,
        },
      })
    ).trim();

    if (params.ref) {
      await updateRef(repoDir, params.ref, sha, params.expectedOldSha);
    }
    return { sha, treeSha };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** CAS ref update. `expectedOldSha` = ZERO_SHA → the ref must not exist. */
export async function updateRef(
  repoDir: string,
  ref: string,
  newSha: string,
  expectedOldSha?: string,
): Promise<void> {
  const args = ["update-ref", ref, newSha];
  if (expectedOldSha !== undefined) args.push(expectedOldSha);
  const result = await runGit(args, { cwd: repoDir });
  if (result.code !== 0) {
    if (expectedOldSha !== undefined) throw new RefCasError(ref);
    throw new Error(`git update-ref failed: ${result.stderr.trim()}`);
  }
}

export async function deleteRef(repoDir: string, ref: string): Promise<void> {
  await runGit(["update-ref", "-d", ref], { cwd: repoDir });
}

// ---------------------------------------------------------------------------
// Remote transport (repo-bound projects; file paths in tests)
// ---------------------------------------------------------------------------

function remoteArgs(remote: ResolvedRemote): string[] {
  return remote.authHeader
    ? ["-c", `http.extraheader=${remote.authHeader}`]
    : [];
}

/**
 * Fetch one remote branch into the same-named local branch (forced — the
 * remote is authoritative for base trees). Returns the branch head SHA.
 */
export async function fetchBranch(
  repoDir: string,
  remote: ResolvedRemote,
  branch: string,
): Promise<string> {
  await git(repoDir, [
    ...remoteArgs(remote),
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    remote.url,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  const sha = await resolveCommit(repoDir, branchRef(branch));
  if (!sha) throw new Error(`Branch "${branch}" not found on remote`);
  return sha;
}

/** Push a local commit to a remote branch. */
export async function pushBranch(
  repoDir: string,
  remote: ResolvedRemote,
  params: {
    localSha: string;
    branch: string;
    /** Expected remote head (compare-and-swap); omit for new branches. */
    expectedRemoteSha?: string;
  },
): Promise<void> {
  // Lease with an empty expectation means "the ref must not exist yet".
  const expect =
    params.expectedRemoteSha === ZERO_SHA ? "" : params.expectedRemoteSha;
  const lease =
    expect !== undefined
      ? [`--force-with-lease=refs/heads/${params.branch}:${expect}`]
      : [];
  await git(repoDir, [
    ...remoteArgs(remote),
    "push",
    "--quiet",
    ...lease,
    remote.url,
    `${params.localSha}:refs/heads/${params.branch}`,
  ]);
}

/** Delete a branch on the remote (no-op if it is already gone). */
export async function pushDeleteBranch(
  repoDir: string,
  remote: ResolvedRemote,
  branch: string,
): Promise<void> {
  const result = await runGit(
    [
      ...remoteArgs(remote),
      "push",
      "--quiet",
      remote.url,
      `:refs/heads/${branch}`,
    ],
    { cwd: repoDir },
  );
  if (result.code !== 0 && !/remote ref does not exist/i.test(result.stderr)) {
    throw new Error(`git push (delete) failed: ${result.stderr.trim()}`);
  }
}

/** List branch names on the remote (`git ls-remote --heads`). */
export async function listRemoteBranchNames(
  repoDir: string,
  remote: ResolvedRemote,
): Promise<string[]> {
  const out = await git(repoDir, [
    ...remoteArgs(remote),
    "ls-remote",
    "--heads",
    remote.url,
  ]);
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const match = line.match(/\trefs\/heads\/(.+)$/);
    if (match) names.push(match[1]);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Default branch of the remote (`ls-remote --symref HEAD`), or null. */
export async function remoteDefaultBranch(
  repoDir: string,
  remote: ResolvedRemote,
): Promise<string | null> {
  const out = await git(repoDir, [
    ...remoteArgs(remote),
    "ls-remote",
    "--symref",
    remote.url,
    "HEAD",
  ]);
  const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

export interface DeletedFileRecord {
  path: string;
  /** Commit that deleted the file (content is at `<sha>^:<path>`). */
  commitSha: string;
  deletedAt: Date;
  deletedBy: string;
}

/**
 * Files deleted on a branch within the last `maxCommits` commits that do not
 * exist at the branch head anymore (the git-native "recoverable files").
 */
export async function listDeletedFiles(
  repoDir: string,
  ref: string,
  maxCommits = 200,
): Promise<DeletedFileRecord[]> {
  if (!(await resolveCommit(repoDir, ref))) return [];
  const out = await git(repoDir, [
    "log",
    `-n`,
    String(maxCommits),
    "--diff-filter=D",
    "--name-only",
    "--no-renames",
    "--pretty=format:__C__%H%x09%at%x09%an",
    ref,
  ]);
  const alive = new Set((await listTree(repoDir, ref)).map(e => e.path));
  const seen = new Set<string>();
  const records: DeletedFileRecord[] = [];
  let current: { sha: string; at: Date; by: string } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("__C__")) {
      const [sha, at, by] = line.slice(5).split("\t");
      current = { sha, at: new Date(Number(at) * 1000), by: by ?? "" };
      continue;
    }
    const filePath = line.trim();
    if (!filePath || !current) continue;
    if (alive.has(filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    records.push({
      path: filePath,
      commitSha: current.sha,
      deletedAt: current.at,
      deletedBy: current.by,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Retry wrapper for CAS races
// ---------------------------------------------------------------------------

export async function withCasRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof RefCasError)) throw error;
      lastError = error;
      logger.debug("dbt git ref CAS retry", { attempt: i + 1 });
    }
  }
  throw lastError;
}
