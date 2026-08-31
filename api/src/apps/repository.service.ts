/**
 * Apps repository service — one Mako-managed bare git repo per WORKSPACE
 * (§10 monorepo; apps are `apps/<slug>` folders inside it).
 *
 * Layout: <APPS_GIT_ROOT>/<workspaceId>.git
 *
 * Design (apps.md §4.3–4.4):
 * - Bare repos are the durable source of truth. The API is the trusted "git
 *   broker": it is the only principal that touches refs, always with
 *   compare-and-swap (`git update-ref <ref> <new> <old>`).
 * - Uncommitted work lives on private WIP refs under `refs/mako/`, which are
 *   hidden from transfer advertisement (`transfer.hideRefs`) so future
 *   smart-HTTP clones never see another actor's in-progress work.
 * - `uploadpack.allowAnySHA1InWant` is enabled so the broker can materialize
 *   WIP snapshots into session working trees by object id over the file
 *   transport without advertising the hidden refs.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appsReposRoot } from "./config";
import {
  GitError,
  ZERO_OID,
  assertSafeRelPath,
  isOid,
  runGit,
  runGitBuffer,
} from "./git";

export const DEFAULT_BRANCH = "main";

const MAKO_AUTHOR_NAME = "Mako";
const MAKO_AUTHOR_EMAIL = "bot@mako.ai";

export interface GitAuthor {
  name: string;
  email: string;
  /**
   * Historical timestamp for migrated commits (v1 version history — §13.18).
   * Applied to BOTH author and committer dates so imported history reads
   * chronologically in every tool. Unset = now.
   */
  date?: Date;
}

export interface TreeEntry {
  path: string;
  /** Blob size in bytes. */
  size: number;
  oid: string;
  mode: string;
}

export interface CommitInfo {
  oid: string;
  author: string;
  timestamp: number;
  subject: string;
}

function authorEnv(author?: GitAuthor): Record<string, string> {
  const name = author?.name || MAKO_AUTHOR_NAME;
  const email = author?.email || MAKO_AUTHOR_EMAIL;
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: MAKO_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: MAKO_AUTHOR_EMAIL,
  };
  if (author?.date) {
    const iso = author.date.toISOString();
    env.GIT_AUTHOR_DATE = iso;
    env.GIT_COMMITTER_DATE = iso;
  }
  return env;
}

/** Absolute path of a workspace's bare repo. Id is validated as hex. */
export function repoDirFor(workspaceId: string): string {
  if (!/^[0-9a-f]{24}$/i.test(workspaceId)) {
    throw new Error("Invalid workspace id");
  }
  return path.join(appsReposRoot(), `${workspaceId}.git`);
}

export async function repoExists(repoDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoDir, "HEAD"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a bare repo with an initial commit containing `files` on the
 * default branch. Idempotence is the caller's concern (project create).
 */
export async function initRepo(
  repoDir: string,
  files: Record<string, string>,
  options: { message?: string; author?: GitAuthor } = {},
): Promise<{ commitOid: string }> {
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  await runGit(["init", "--bare", "-b", DEFAULT_BRANCH, repoDir]);
  // Hide Mako-internal refs from any future transfer advertisement, and let
  // the broker fetch WIP snapshots by raw oid over the file transport.
  await runGit(["-C", repoDir, "config", "transfer.hideRefs", "refs/mako/"]);
  await runGit([
    "-C",
    repoDir,
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  ]);

  // Materialize the scaffold in a temp work tree and commit it.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-apps-init-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const safe = assertSafeRelPath(rel);
      const abs = path.join(tmp, safe);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, "utf8");
    }
    const treeOid = await snapshotDirToTree(repoDir, tmp);
    const commitOid = await commitTree(repoDir, {
      treeOid,
      parents: [],
      message: options.message ?? "Initial scaffold",
      author: options.author,
    });
    await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      commitOid,
      ZERO_OID,
    );
    return { commitOid };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function deleteRepo(repoDir: string): Promise<void> {
  await fs.rm(repoDir, { recursive: true, force: true });
}

/**
 * Snapshot a working directory into the repo's object database and return the
 * tree oid. Uses a throwaway index so concurrent snapshots never collide, and
 * respects the work tree's .gitignore (node_modules, dist, ... stay out).
 */
export async function snapshotDirToTree(
  repoDir: string,
  workDir: string,
): Promise<string> {
  const indexFile = path.join(
    os.tmpdir(),
    `mako-apps-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = {
    GIT_DIR: repoDir,
    GIT_WORK_TREE: workDir,
    GIT_INDEX_FILE: indexFile,
  };
  try {
    await runGit(["add", "-A", "--", "."], { cwd: workDir, env });
    const { stdout } = await runGit(["write-tree"], { cwd: workDir, env });
    return stdout.trim();
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

/**
 * Commit a new state of ONE subtree (`prefix`) on `branch`, leaving the rest
 * of the head tree untouched — pure bare-repo plumbing, no clone. Built for
 * replaying long histories (v1 version imports, §13.18): a throwaway index
 * takes the head tree, the old `prefix` entries drop out, the work dir's
 * snapshot grafts in at `prefix`, and the resulting tree is committed with
 * the given author (including a historical date when one is set).
 *
 * Commits even when the tree is unchanged — a replayed version whose content
 * equals its predecessor still happened (its message and author are the
 * record), and dropping it would silently renumber history.
 */
export async function commitSubtreeOnBranch(
  repoDir: string,
  branch: string,
  prefix: string,
  workDir: string,
  options: { message: string; author?: GitAuthor },
): Promise<{ commitOid: string }> {
  const safePrefix = assertSafeRelPath(prefix);
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!head) throw new Error(`Branch ${branch} is missing`);
  const headTree = await treeOfCommit(repoDir, head);
  const subtreeOid = await snapshotDirToTree(repoDir, workDir);

  const indexFile = path.join(
    os.tmpdir(),
    `mako-apps-subtree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // GIT_WORK_TREE is nominal: update-index/read-tree refuse to run "bare",
  // but never touch the tree for cached-only operations — workDir serves.
  const env = {
    GIT_DIR: repoDir,
    GIT_WORK_TREE: workDir,
    GIT_INDEX_FILE: indexFile,
  };
  try {
    await runGit(["read-tree", headTree], { env, cwd: workDir });
    const { stdout: oldPaths } = await runGit(
      [
        "-C",
        repoDir,
        "ls-tree",
        "-r",
        "--name-only",
        headTree,
        "--",
        safePrefix,
      ],
      { maxBufferBytes: 64 * 1024 * 1024 },
    );
    const paths = oldPaths.split("\n").filter(Boolean);
    for (let i = 0; i < paths.length; i += 500) {
      await runGit(
        ["update-index", "--force-remove", "--", ...paths.slice(i, i + 500)],
        { env, cwd: workDir },
      );
    }
    await runGit(["read-tree", `--prefix=${safePrefix}/`, subtreeOid], {
      env,
      cwd: workDir,
    });
    const { stdout } = await runGit(["write-tree"], { env, cwd: workDir });
    const treeOid = stdout.trim();
    const commitOid = await commitTree(repoDir, {
      treeOid,
      parents: [head],
      message: options.message,
      author: options.author,
    });
    const applied = await updateRefCas(
      repoDir,
      `refs/heads/${branch}`,
      commitOid,
      head,
    );
    if (!applied) {
      throw new Error(
        `Branch ${branch} moved while replaying history — retry the migration`,
      );
    }
    return { commitOid };
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

/**
 * The git object id of a blob with these contents — `sha1("blob <len>\0" +
 * bytes)`. Computed in-process so a caller can stamp a derived index with
 * the id git will assign without a round-trip (§16.3: consoles record their
 * file's blob id and skip re-projection when it has not moved).
 */
export function blobOid(contents: string | Buffer): string {
  const bytes = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents, "utf8");
  return crypto
    .createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export interface BlobMutation {
  /** repo-relative path → full contents. */
  writes?: Record<string, string>;
  /** repo-relative paths to remove; absent paths are ignored. */
  deletes?: string[];
}

/**
 * Commit a set of whole-file writes and deletes onto `branch` with index
 * plumbing only — no clone, no work tree: `hash-object -w` the blobs, load
 * the head tree into a throwaway index, splice the entries in with
 * `update-index --index-info`, `write-tree`, `commit-tree`, CAS the ref.
 * A few milliseconds for a small change against any size of repo, which is
 * what a console save needs (§16.3); `commitFilesOnBranch` clones and is
 * for lifecycle-sized changes.
 *
 * Returns `unchanged: true` (and the head oid) when the mutation produces
 * the tree already at head, so re-runs and no-op saves leave no commit —
 * unless `allowEmpty` is set: a replayed version whose content equals its
 * predecessor still happened (its author, date and message are the record),
 * and dropping it would silently renumber history (§13.18 doctrine).
 */
export async function commitBlobsOnBranch(
  repoDir: string,
  branch: string,
  mutation: BlobMutation,
  options: { message: string; author?: GitAuthor; allowEmpty?: boolean },
): Promise<{ commitOid: string; previousHead: string; unchanged: boolean }> {
  const writes = Object.entries(mutation.writes ?? {}).map(
    ([rel, contents]) => [assertSafeRelPath(rel), contents] as const,
  );
  const deletes = (mutation.deletes ?? []).map(p => assertSafeRelPath(p));
  // Blobs first: they are content-addressed, so writing them before knowing
  // the head is safe and keeps the CAS window short.
  const oids = new Map<string, string>();
  for (const [rel, contents] of writes) {
    const { stdout } = await runGit(
      ["-C", repoDir, "hash-object", "-w", "--stdin", "--path", rel],
      { stdin: contents },
    );
    oids.set(rel, stdout.trim());
  }
  const indexInfo =
    [
      ...deletes.map(rel => `0 ${ZERO_OID}\t${rel}`),
      ...writes.map(([rel]) => `100644 ${oids.get(rel)}\t${rel}`),
    ].join("\n") + "\n";

  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) throw new Error(`Branch ${branch} is missing`);
    const headTree = await treeOfCommit(repoDir, head);
    const indexFile = path.join(
      os.tmpdir(),
      `mako-apps-blobs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const env = { GIT_DIR: repoDir, GIT_INDEX_FILE: indexFile };
    let treeOid: string;
    try {
      await runGit(["read-tree", headTree], { env, cwd: repoDir });
      await runGit(["update-index", "--index-info"], {
        env,
        cwd: repoDir,
        stdin: indexInfo,
      });
      treeOid = (
        await runGit(["write-tree"], { env, cwd: repoDir })
      ).stdout.trim();
    } finally {
      await fs.rm(indexFile, { force: true });
    }
    if (treeOid === headTree && !options.allowEmpty) {
      return { commitOid: head, previousHead: head, unchanged: true };
    }
    const commitOid = await commitTree(repoDir, {
      treeOid,
      parents: [head],
      message: options.message,
      author: options.author,
    });
    if (await updateRefCas(repoDir, `refs/heads/${branch}`, commitOid, head)) {
      return { commitOid, previousHead: head, unchanged: false };
    }
  }
  throw new Error(
    `Branch ${branch} kept advancing during a blob commit; retry.`,
  );
}

export async function commitTree(
  repoDir: string,
  input: {
    treeOid: string;
    parents: string[];
    message: string;
    author?: GitAuthor;
  },
): Promise<string> {
  const args = ["-C", repoDir, "commit-tree", input.treeOid];
  for (const p of input.parents) args.push("-p", p);
  args.push("-m", input.message || "(no message)");
  const { stdout } = await runGit(args, { env: authorEnv(input.author) });
  return stdout.trim();
}

/**
 * Compare-and-swap a ref. Returns true when the swap applied, false when the
 * ref's current value did not match `expectedOldOid` (someone else won).
 * `expectedOldOid = ZERO_OID` asserts the ref must not exist yet.
 */
export async function updateRefCas(
  repoDir: string,
  ref: string,
  newOid: string,
  expectedOldOid: string,
): Promise<boolean> {
  try {
    await runGit(["-C", repoDir, "update-ref", ref, newOid, expectedOldOid]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/** Resolve a ref (or oid) to a commit oid, or null when unresolvable. */
export async function resolveCommit(
  repoDir: string,
  refOrOid: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${refOrOid}^{commit}`,
    ]);
    const oid = stdout.trim();
    return isOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Tree oid of a commit. */
export async function treeOfCommit(
  repoDir: string,
  commitOid: string,
): Promise<string> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "rev-parse",
    `${commitOid}^{tree}`,
  ]);
  return stdout.trim();
}

/** Recursive file listing of a commit/tree. */
export async function listTree(
  repoDir: string,
  refOrOid: string,
): Promise<TreeEntry[]> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "ls-tree",
    "-r",
    "-l",
    "-z",
    refOrOid,
  ]);
  const entries: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    // "<mode> <type> <oid> <size>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const [mode, type, oid, size] = meta;
    if (type !== "blob") continue;
    entries.push({
      path: record.slice(tab + 1),
      mode,
      oid,
      size: Number(size) || 0,
    });
  }
  return entries;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Content search over a tree-ish, straight from the object database — no
 * working tree, so it runs even when the app's sandbox is paused or dead
 * (Claude Code keeps grep as a first-class tool for exactly this ergonomic
 * reliability; here it is also sandbox-independent).
 */
export async function grepTree(
  repoDir: string,
  refOrOid: string,
  pattern: string,
  options: {
    ignoreCase?: boolean;
    pathspec?: string;
    maxMatches?: number;
  } = {},
): Promise<GrepMatch[]> {
  const args = [
    "-C",
    repoDir,
    "grep",
    "--no-color",
    "-n", // line numbers
    "-I", // skip binary files
    "-E", // extended regex
  ];
  if (options.ignoreCase) args.push("-i");
  args.push("-e", pattern, refOrOid);
  if (options.pathspec) args.push("--", options.pathspec);

  let stdout = "";
  try {
    ({ stdout } = await runGit(args, { maxBufferBytes: 16 * 1024 * 1024 }));
  } catch (error) {
    // `git grep` exits 1 when there are simply no matches — not an error.
    if (error instanceof GitError && error.exitCode === 1) return [];
    throw error;
  }

  const max = options.maxMatches ?? 200;
  const matches: GrepMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // Format: "<ref>:<path>:<lineno>:<text>"
    const afterRef = raw.slice(refOrOid.length + 1);
    const firstColon = afterRef.indexOf(":");
    const secondColon = afterRef.indexOf(":", firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const path = afterRef.slice(0, firstColon);
    const line = Number(afterRef.slice(firstColon + 1, secondColon));
    const text = afterRef.slice(secondColon + 1);
    matches.push({ path, line, text: text.slice(0, 500) });
    if (matches.length >= max) break;
  }
  return matches;
}

/** Translate a glob (`**`, `*`, `?`) into an anchored regex. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across path separators; consume an optional trailing `/`.
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

/**
 * List file paths in a tree-ish matching a glob (also sandbox-free). Mirrors
 * Claude Code's Glob tool contract.
 */
export async function globTree(
  repoDir: string,
  refOrOid: string,
  glob: string,
  limit = 200,
): Promise<string[]> {
  const entries = await listTree(repoDir, refOrOid);
  const matcher = globToRegExp(glob);
  const matched = entries
    .map(e => e.path)
    .filter(p => matcher.test(p) || matcher.test(`/${p}`));
  return matched.slice(0, limit);
}

export interface BlobContent {
  contents: string;
  isBinary: boolean;
  size: number;
}

/** Read a file at a ref. Throws when the path does not exist at that ref. */
export async function readBlob(
  repoDir: string,
  refOrOid: string,
  relPath: string,
): Promise<BlobContent> {
  const safe = assertSafeRelPath(relPath);
  const buf = await runGitBuffer([
    "-C",
    repoDir,
    "show",
    `${refOrOid}:${safe}`,
  ]);
  const isBinary = buf.includes(0);
  return {
    contents: isBinary ? buf.toString("base64") : buf.toString("utf8"),
    isBinary,
    size: buf.length,
  };
}

/**
 * Read MANY blobs at a ref in one git process (`cat-file --batch`), for
 * materializing whole trees (a dbt run reads ~2000 files; a spawn per file
 * would take tens of seconds, this takes one). Missing paths are simply
 * absent from the result. Binary blobs are returned as raw Buffers alongside
 * text so callers decide the encoding.
 */
export async function readBlobsBatch(
  repoDir: string,
  refOrOid: string,
  relPaths: string[],
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (relPaths.length === 0) return out;
  const safe = relPaths.map(assertSafeRelPath);
  const { spawn } = await import("node:child_process");
  const child = spawn("git", ["-C", repoDir, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const errChunks: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => errChunks.push(c));
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve(code ?? -1));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(safe.map(p => `${refOrOid}:${p}\n`).join(""));
  const code = await done;
  if (code !== 0) {
    throw new Error(
      `git cat-file --batch failed: ${Buffer.concat(errChunks).toString("utf8").slice(0, 500)}`,
    );
  }
  // Records: "<oid> <type> <size>\n<size bytes>\n" or "<input> missing\n",
  // in input order — pair them back up positionally.
  let buf = Buffer.concat(chunks);
  for (const relPath of safe) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break;
    const header = buf.subarray(0, nl).toString("utf8");
    buf = buf.subarray(nl + 1);
    if (header.endsWith(" missing")) continue;
    const parts = header.split(" ");
    const size = Number(parts[2] ?? NaN);
    if (!Number.isFinite(size)) {
      throw new Error(`Unexpected cat-file header: ${header.slice(0, 100)}`);
    }
    out.set(relPath, buf.subarray(0, size));
    buf = buf.subarray(size + 1); // skip trailing newline
  }
  return out;
}

/** Commit history of a ref. */
export async function log(
  repoDir: string,
  refOrOid: string,
  limit = 20,
  pathspec?: string,
): Promise<CommitInfo[]> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "log",
    `--format=%H%x00%an%x00%at%x00%s`,
    "-n",
    String(Math.max(1, Math.min(limit, 200))),
    refOrOid,
    ...(pathspec ? ["--", pathspec] : []),
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [oid, author, at, subject] = line.split("\0");
      return { oid, author, timestamp: Number(at) * 1000, subject };
    });
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Change recorded in the index (git add) — VS Code's "Staged Changes". */
  staged?: boolean;
  /** Change in the working tree not (fully) in the index — "Changes". */
  unstaged?: boolean;
}

/** Name-status diff between two commits/trees. */
export async function diffNameStatus(
  repoDir: string,
  fromRef: string,
  toRef: string,
): Promise<ChangedFile[]> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "diff",
    "--name-status",
    "-z",
    fromRef,
    toRef,
  ]);
  const parts = stdout.split("\0").filter(Boolean);
  const changes: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (code.startsWith("R")) {
      // rename: R<score>\0<from>\0<to>
      const to = parts[i + 2];
      changes.push({ path: to, status: "renamed" });
      i += 2;
      continue;
    }
    const p = parts[i + 1];
    i += 1;
    if (code === "A") changes.push({ path: p, status: "added" });
    else if (code === "D") changes.push({ path: p, status: "deleted" });
    else changes.push({ path: p, status: "modified" });
  }
  return changes;
}

/** Unified diff between two commits (for review surfaces). */
export async function diffUnified(
  repoDir: string,
  fromRef: string,
  toRef: string,
  relPath?: string,
): Promise<string> {
  const args = ["-C", repoDir, "diff", fromRef, toRef];
  if (relPath) args.push("--", assertSafeRelPath(relPath));
  const { stdout } = await runGit(args, {
    maxBufferBytes: 8 * 1024 * 1024,
  });
  return stdout;
}

export { ZERO_OID };
