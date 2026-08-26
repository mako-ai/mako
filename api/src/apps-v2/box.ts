/**
 * The sandbox as an ordinary clone.
 *
 * This replaces a private transfer layer — bundles in both directions, shadow
 * "WIP" commits to decide what to transfer, and a Mongo mirror of the result —
 * with the thing every developer already has: a working copy with a remote it
 * can fetch from and push to.
 *
 * The remote is Mako's own git-over-HTTP endpoint (routes/apps-v2-git.ts),
 * serving the same bare repo the API reads. So there is one repository and two
 * ordinary git clients: the API on the server side of it, the sandbox on the
 * client side. Nothing has to be kept in step, because nothing is duplicated.
 *
 * The practical test of the design is that nothing in the box knows about
 * Mako. `git push`, `git pull`, `git log`, a coding agent running inside the
 * sandbox — all of it is just git talking to a git server.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { appsV2GitOriginBase, appsV2GitOriginUrl } from "./config";
import type { ChangedFile, GrepMatch, TreeEntry } from "./repository.service";
import { mintGitToken } from "./git-token.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-box-clone");

/**
 * Paths that must never reach a commit regardless of what the app's own
 * .gitignore says — installed dependencies and build output, which belong to
 * the machine rather than to the project.
 */
export const NEVER_COMMIT = [
  "node_modules",
  ".npm",
  ".cache",
  ".vite",
  ".pnpm-store",
  "dist",
];

/**
 * The workspace repo's root .gitignore, derived from NEVER_COMMIT.
 *
 * This is the layer that travels. The scaffold writes a per-app .gitignore,
 * but not every app comes from the scaffold: an agent can hand-build one with
 * write_file and bash, and a person can push a folder from a laptop clone —
 * and the sandbox's .git/info/exclude backstop protects neither, because
 * info/exclude is per-clone and unversioned. A root .gitignore is committed
 * state: it applies recursively to every app folder that will ever exist, in
 * every clone, however the app was created. (`.env` rides along because a
 * secret in git is a leak with history.)
 */
export function workspaceRootGitignore(): string {
  return `${NEVER_COMMIT.map(n => `${n}/`).join("\n")}\n.env\n`;
}

/** Single-quote for a POSIX shell, closing and reopening around any quote. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function boxRoot(ctx: SandboxExecContext): string {
  return getSandboxProvider().root(ctx);
}

function boxGit(ctx: SandboxExecContext, ...args: string[]): string {
  return ["git", "-C", sh(boxRoot(ctx)), ...args.map(sh)].join(" ");
}

async function run(
  ctx: SandboxExecContext,
  command: string,
  what: string,
  timeoutMs = 180_000,
): Promise<string> {
  const result = await getSandboxProvider().exec(ctx, command, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed in the sandbox: ${(result.stderr || result.stdout).slice(-500)}`,
    );
  }
  return result.stdout;
}

/** Is there already a git repository in the sandbox? */
export async function boxHasRepo(ctx: SandboxExecContext): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    `test -d ${sh(`${boxRoot(ctx)}/.git`)}`,
    { timeoutMs: 15_000 },
  );
  return result.exitCode === 0;
}

/**
 * Where a sandbox keeps its credential: inside the clone's own `.git`.
 *
 * The two wrong answers have both been shipped and both bit. $HOME: the local
 * provider shares one HOME across sandboxes (deliberately, for tool caches),
 * so two workspaces overwrote each other's token and one got 401s from a
 * valid credential for the wrong repository. Scratch (/tmp): tmpfs on the
 * microVM, which E2B's pause snapshot does not preserve — a resumed sandbox
 * woke with a configured helper pointing at a file that no longer existed and
 * failed auth with "No such file" while nothing had been rotated.
 *
 * `.git` is per-clone by construction, inside the snapshot because the clone
 * is, and nothing under it can ever be committed.
 */
function tokenPath(ctx: SandboxExecContext): string {
  return `${boxRoot(ctx)}/.git/mako-git-token`;
}

/**
 * Where box processes (launcher, hooks, agent) find how to reach the API:
 * `MAKO_API`, `MAKO_WS`, `MAKO_TOKEN_FILE`, one per line. Rewritten with the
 * token on every configure/heal, so a tunnel restart updates it too.
 */
export function boxEnvPath(ctx: SandboxExecContext): string {
  return `${boxRoot(ctx)}/.git/mako-box.env`;
}

/**
 * Give the sandbox a remote and the credential to use it.
 *
 * The token goes in a file rather than in the remote URL so that rotating it
 * is a write, `git remote -v` does not print a secret, and no command line
 * carrying it is retained anywhere. A one-line credential helper reads it —
 * which is git's own extension point for exactly this, so nothing here has to
 * understand how git authenticates.
 *
 * Safe and cheap to repeat: every call refreshes the token, which is what
 * keeps a long-lived sandbox from reaching its expiry mid-session.
 */
export async function configureBoxRemote(input: {
  ctx: SandboxExecContext;
  workspaceId: string;
  userId: string;
  /** Who commits made in the box are attributed to. */
  author?: { name?: string; email?: string };
}): Promise<void> {
  const { ctx, workspaceId, userId, author } = input;
  const url = appsV2GitOriginUrl(workspaceId);
  if (
    getSandboxProvider().id !== "local" &&
    /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)
  ) {
    // A microVM cannot reach this machine's localhost. Configuring it
    // anyway is how agent commits ended up "committed but not durable"
    // with the failure buried in a log. Fail loudly instead: the tunnel
    // (.env.tunnel) is not up yet — retry after `pnpm dev` finishes booting.
    throw new Error(
      `Refusing to configure a remote sandbox with a localhost git origin (${url}) — the tunnel is not up yet.`,
    );
  }
  const token = mintGitToken({ workspaceId, userId });
  const credential = tokenPath(ctx);
  const helper = `!f() { printf 'username=mako\\npassword=%s\\n' "$(cat ${credential})"; }; f`;

  await run(
    ctx,
    [
      // umask first: the file must never exist world-readable, not even for
      // the instant between creation and a chmod.
      `(umask 077 && printf '%s' ${sh(token)} > ${sh(credential)})`,
      `(umask 077 && printf 'MAKO_API=%s\\nMAKO_WS=%s\\nMAKO_TOKEN_FILE=%s\\n' ${sh(appsV2GitOriginBase())} ${sh(workspaceId)} ${sh(credential)} > ${sh(boxEnvPath(ctx))})`,
      // An EMPTY helper resets the inherited list, then ours is the only one.
      //
      // Git runs every configured helper in order, including any from system
      // config, and a helper that wants to talk to a human blocks forever
      // where there is no human. macOS ships `credential.helper=osxkeychain`
      // in Xcode's gitconfig, which hung every fetch and push against the
      // local sandbox until the timeout — with empty stderr, because nothing
      // had failed; git was waiting. A sandbox image that picks up a helper
      // would do the same, so this is not a macOS workaround.
      boxGit(ctx, "config", "--replace-all", "credential.helper", ""),
      boxGit(ctx, "config", "--add", "credential.helper", helper),
      boxGit(ctx, "config", "user.name", author?.name || "Mako Session"),
      boxGit(ctx, "config", "user.email", author?.email || "session@mako.ai"),
      // Push the current branch to the same name, the modern default. Without
      // it, a `git push` with no arguments on a fresh branch fails with advice
      // instead of pushing.
      boxGit(ctx, "config", "push.default", "current"),
      boxGit(ctx, "config", "push.autoSetupRemote", "true"),
      `${boxGit(ctx, "remote", "set-url", "origin", url)} || ${boxGit(ctx, "remote", "add", "origin", url)}`,
    ].join(" && "),
    "configuring the git remote",
    60_000,
  );
}

/**
 * Put a working copy of `branch` in the sandbox.
 *
 * `init` + `fetch` rather than `clone` for one practical reason: a warm
 * sandbox already has node_modules in the directory, and clone refuses a
 * non-empty target. It is the same sequence clone runs.
 */
export async function cloneIntoBox(input: {
  ctx: SandboxExecContext;
  workspaceId: string;
  userId: string;
  branch: string;
  author?: { name?: string; email?: string };
}): Promise<void> {
  const { ctx, workspaceId, userId, branch, author } = input;
  // `.git/info/exclude` is git's own home for repo-local ignores — no config
  // key needed, and (unlike the scratch file this used to be) inside the
  // pause snapshot, so a resumed sandbox cannot wake with its excludes gone
  // and quietly start committing node_modules.
  const excludes = `${boxRoot(ctx)}/.git/info/exclude`;

  await run(
    ctx,
    [
      `mkdir -p ${sh(boxRoot(ctx))}`,
      boxGit(ctx, "init", "-q"),
      `mkdir -p ${sh(`${boxRoot(ctx)}/.git/info`)}`,
      // A repo-level backstop, independent of whatever .gitignore the app
      // happens to ship.
      `printf '%s\\n' ${NEVER_COMMIT.map(n => sh(`${n}/`)).join(" ")} > ${sh(excludes)}`,
    ].join(" && "),
    "preparing the working copy",
    60_000,
  );

  await configureBoxRemote({ ctx, workspaceId, userId, author });

  await run(
    ctx,
    [
      boxGit(ctx, "fetch", "-q", "--tags", "origin"),
      // Track origin's branch, creating the local one if this is the first
      // time. `checkout -B ... origin/<branch>` is the same thing clone does
      // for the default branch.
      boxGit(ctx, "checkout", "-q", "-B", branch, `origin/${branch}`),
    ].join(" && "),
    `fetching ${branch}`,
  );

  logger.info("Apps v2 sandbox cloned the workspace repo", {
    workspaceId,
    branch,
  });
}

/** The branch the sandbox is on, and the commit it is at. */
export async function boxHead(
  ctx: SandboxExecContext,
): Promise<{ branch: string; head: string }> {
  const out = await run(
    ctx,
    [
      boxGit(ctx, "rev-parse", "--abbrev-ref", "HEAD"),
      boxGit(ctx, "rev-parse", "HEAD"),
    ].join(" && "),
    "reading HEAD",
    30_000,
  );
  const [branch, head] = out.split("\n").map(l => l.trim());
  if (!branch || !head) {
    throw new Error(
      `Unexpected git output from the sandbox: ${out.slice(-200)}`,
    );
  }
  return { branch, head };
}

// ---------------------------------------------------------------------------
// The client: a file system, a shell, and git
//
// Everything below runs IN the sandbox. There is no server-side model of the
// working copy to keep in step with it, because there is no server-side
// working copy — the same reason none of this needs a "sync".
// ---------------------------------------------------------------------------

/** Run a command in the box, returning stdout and letting failures be seen. */
export async function boxExec(
  ctx: SandboxExecContext,
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
) {
  return getSandboxProvider().exec(ctx, command, options);
}

/**
 * Files tracked in the working copy, including uncommitted ones — CAPPED.
 *
 * `ls-files` with `--others --exclude-standard` is git's own answer to "what
 * files are here that matter" — tracked plus untracked-but-not-ignored. It
 * gives the working copy, which is what an editor should show.
 *
 * The cap is not an optimization, it is correctness. The provider truncates
 * command output at a fixed byte budget, and a 100k-file tree's NUL stream
 * blows through it — truncated MID-RECORD, which parsed as a garbage path and
 * silently missing files. Capping at the source (`head -c`, under every
 * provider's budget, dropping the final partial record) makes truncation an
 * explicit answer: here are the first N, there are M in total.
 */
const LIST_BYTE_CAP = 400_000;

export interface BoxFileListing {
  entries: TreeEntry[];
  /** True when the tree holds more files than were returned. */
  truncated: boolean;
  /** Total file count, fetched only when truncated. */
  total?: number;
}

export async function boxListFiles(
  ctx: SandboxExecContext,
  subdir = "",
  limit = 5000,
): Promise<BoxFileListing> {
  const scope = subdir ? ` -- ${sh(subdir)}` : "";
  // TRACKED FIRST, then untracked — deliberately two calls. A single
  // `ls-files --cached --others` emits all OTHERS first, each group sorted
  // separately, so a byte-capped page of a tree with thousands of untracked
  // files was thousands of untracked files and not one line of the app's
  // actual source. When something must fall off the end, it is the overflow,
  // never the code. (A path cannot be in both groups, so no dedup needed.)
  const list =
    `{ git ls-files -z --cached${scope}; ` +
    `git ls-files -z --others --exclude-standard${scope}; }`;
  const listing = await boxExec(
    ctx,
    `cd ${sh(boxRoot(ctx))} && ${list} | head -c ${LIST_BYTE_CAP}`,
    { timeoutMs: 60_000 },
  );
  if (listing.exitCode !== 0) {
    throw new Error(`Could not list files: ${listing.stderr.slice(-300)}`);
  }
  let raw = listing.stdout;
  const byteCapped = Buffer.byteLength(raw, "utf8") >= LIST_BYTE_CAP;
  if (byteCapped) {
    // The last record is almost certainly cut mid-path; a partial path is
    // worse than a missing one, so it goes.
    raw = raw.slice(0, raw.lastIndexOf("\0") + 1);
  }
  let paths = raw.split("\0").filter(Boolean);
  const entryCapped = paths.length > limit;
  if (entryCapped) paths = paths.slice(0, limit);
  const truncated = byteCapped || entryCapped;
  if (paths.length === 0) return { entries: [], truncated, total: 0 };

  // `--cached` is the INDEX, and a file deleted from the working tree is still
  // in the index until the deletion is staged. Listing it back is how `rm
  // doomed.txt` in the terminal left the file sitting in the tree afterwards.
  const deleted = await boxExec(
    ctx,
    `cd ${sh(boxRoot(ctx))} && git ls-files -z --deleted${scope} | head -c ${LIST_BYTE_CAP}`,
    { timeoutMs: 60_000 },
  );
  if (deleted.exitCode !== 0) {
    throw new Error(
      `Could not list deleted files: ${deleted.stderr.slice(-300)}`,
    );
  }
  const gone = new Set(deleted.stdout.split("\0").filter(Boolean));
  paths = paths.filter(p => !gone.has(p));

  // Sizes in one PIPELINE, not one argv — the path list must never ride the
  // command line (an app that committed node_modules once took the whole
  // tree down with the exec's argument limit). Same cap, so the subset
  // matches the listing: git's ls-files order is deterministic.
  const sizes = await boxExec(
    ctx,
    `cd ${sh(boxRoot(ctx))} && ` +
      `if stat -c %s . >/dev/null 2>&1; then fmt=-c; spec='%s %n'; else fmt=-f; spec='%z %N'; fi && ` +
      `${list} | head -c ${LIST_BYTE_CAP} | xargs -0 stat "$fmt" "$spec" 2>/dev/null || true`,
    { timeoutMs: 60_000 },
  );
  const sizeByPath = new Map<string, number>();
  for (const line of sizes.stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at === -1) continue;
    sizeByPath.set(line.slice(at + 1), Number(line.slice(0, at)) || 0);
  }

  let total: number | undefined = truncated ? undefined : paths.length;
  if (truncated) {
    // `tr -cd '\0' | wc -c` counts records without ever holding them — the
    // one portable way to count a NUL stream that is too big to return.
    const count = await boxExec(
      ctx,
      `cd ${sh(boxRoot(ctx))} && ${list} | tr -cd '\\0' | wc -c`,
      { timeoutMs: 60_000 },
    );
    const parsed = Number(count.stdout.trim());
    if (Number.isFinite(parsed)) total = parsed;
  }

  return {
    entries: paths.map(p => ({
      path: p,
      size: sizeByPath.get(p) ?? 0,
      oid: "",
      mode: "100644",
    })),
    truncated,
    total,
  };
}

/** Read a file from the working copy. */
export async function boxReadFile(
  ctx: SandboxExecContext,
  relPath: string,
): Promise<{ contents: string; isBinary: boolean; size: number }> {
  const bytes = await getSandboxProvider().readFile(
    ctx,
    `${boxRoot(ctx)}/${relPath}`,
  );
  const buffer = Buffer.from(bytes);
  // A NUL byte in the first block is how git itself decides, and it is right
  // often enough that trying to be cleverer would only be wrong differently.
  const isBinary = buffer.subarray(0, 8000).includes(0);
  return {
    contents: isBinary ? "" : buffer.toString("utf8"),
    isBinary,
    size: buffer.length,
  };
}

/** Write a file into the working copy, creating parent directories. */
export async function boxWriteFile(
  ctx: SandboxExecContext,
  relPath: string,
  contents: string,
): Promise<void> {
  const target = `${boxRoot(ctx)}/${relPath}`;
  const parent = target.slice(0, target.lastIndexOf("/"));
  const made = await boxExec(ctx, `mkdir -p ${sh(parent)}`, {
    timeoutMs: 30_000,
  });
  if (made.exitCode !== 0) {
    throw new Error(`Could not create ${parent}: ${made.stderr.slice(-200)}`);
  }
  await getSandboxProvider().writeFile(
    ctx,
    target,
    new TextEncoder().encode(contents),
  );
}

/** Search file contents — `git grep`, over the working copy. */
export async function boxGrep(
  ctx: SandboxExecContext,
  pattern: string,
  options: {
    ignoreCase?: boolean;
    pathspec?: string;
    maxMatches?: number;
  } = {},
): Promise<GrepMatch[]> {
  const args = ["grep", "-n", "--no-color", "-I"];
  if (options.ignoreCase) args.push("-i");
  // Untracked files count: they are part of the working copy, and an editor
  // that cannot find a file you just created is not searching what you see.
  args.push("--untracked", "-e", pattern);
  const scope = options.pathspec ? ` -- ${sh(options.pathspec)}` : "";
  const result = await boxExec(ctx, `${boxGit(ctx, ...args)}${scope}`, {
    timeoutMs: 60_000,
  });
  // git grep exits 1 for "no matches", which is not an error.
  if (result.exitCode > 1) {
    throw new Error(`Search failed: ${result.stderr.slice(-300)}`);
  }
  const matches: GrepMatch[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    matches.push({
      path: line.slice(0, first),
      line: Number(line.slice(first + 1, second)) || 0,
      text: line.slice(second + 1),
    });
    if (options.maxMatches && matches.length >= options.maxMatches) break;
  }
  return matches;
}

/** List paths matching a glob — `git ls-files` does globs natively. */
export async function boxGlob(
  ctx: SandboxExecContext,
  glob: string,
  limit?: number,
): Promise<string[]> {
  const result = await boxExec(
    ctx,
    `${boxGit(ctx, "ls-files", "-z", "--cached", "--others", "--exclude-standard")} -- ${sh(glob)}`,
    { timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) return [];
  const paths = result.stdout.split("\0").filter(Boolean);
  return limit ? paths.slice(0, limit) : paths;
}

export interface BoxStatus {
  branch: string;
  head: string;
  changes: ChangedFile[];
  /** Commits on this branch that origin does not have yet. */
  ahead: number;
}

/**
 * What `git status` says — nothing more.
 *
 * This replaces a "worktree status" assembled from a shadow commit, a Mongo
 * document and a diff between them. Three sources that could disagree, for an
 * answer git computes directly.
 */
export async function boxStatus(ctx: SandboxExecContext): Promise<BoxStatus> {
  const result = await boxExec(
    ctx,
    `${boxGit(ctx, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all")}`,
    { timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not read status: ${result.stderr.slice(-300)}`);
  }

  let branch = "HEAD";
  let ahead = 0;
  const changes: ChangedFile[] = [];
  const records = result.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("## ")) {
      const header = record.slice(3);
      branch = header.split(/\.{3}|\s/)[0] || "HEAD";
      ahead = Number(/\[ahead (\d+)/.exec(header)?.[1] ?? 0);
      continue;
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // X = index vs HEAD, Y = working tree vs index (porcelain v1).
    const flags = {
      staged: code[0] !== " " && code[0] !== "?",
      unstaged: code === "??" || code[1] !== " ",
    };
    if (code === "??") {
      changes.push({ path, status: "added", ...flags });
    } else if (code.includes("D")) {
      changes.push({ path, status: "deleted", ...flags });
    } else if (code.includes("R")) {
      // A rename's second NUL-separated field is the old path; skip it so it
      // is not reported as a file of its own.
      i++;
      changes.push({ path, status: "renamed", ...flags });
    } else if (code.includes("A")) {
      changes.push({ path, status: "added", ...flags });
    } else {
      changes.push({ path, status: "modified", ...flags });
    }
  }

  const head = await boxExec(ctx, boxGit(ctx, "rev-parse", "HEAD"), {
    timeoutMs: 30_000,
  });
  return { branch, head: head.stdout.trim(), changes, ahead };
}

export interface BoxCommitResult {
  committed: boolean;
  commitOid?: string;
  message?: string;
  reason?: string;
}

/**
 * Commit everything in the working copy and push it.
 *
 * The push is not an optimisation, it is the durability guarantee: a sandbox
 * is disposable, so work that has not reached the server is work that only
 * exists on a machine nobody promised to keep. It is what the WIP ref used to
 * be, except that it is a commit on a branch, visible to git, and reachable
 * from any other clone.
 */
export async function boxCommitAll(input: {
  ctx: SandboxExecContext;
  message: string;
  author?: { name?: string; email?: string };
  /** Commit only what is staged (VS Code with a non-empty Staged group). */
  stagedOnly?: boolean;
}): Promise<BoxCommitResult> {
  const { ctx, message, author, stagedOnly } = input;
  const identity =
    author?.name && author?.email
      ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
      : [];

  if (!stagedOnly) {
    const staged = await boxExec(ctx, boxGit(ctx, "add", "-A"), {
      timeoutMs: 120_000,
    });
    if (staged.exitCode !== 0) {
      throw new Error(`Could not stage changes: ${staged.stderr.slice(-300)}`);
    }
  }

  const committed = await boxExec(
    ctx,
    [
      "git",
      "-C",
      sh(boxRoot(ctx)),
      ...identity.map(sh),
      "commit",
      "-q",
      "-m",
      sh(message),
    ].join(" "),
    { timeoutMs: 120_000 },
  );
  let madeCommit = true;
  if (committed.exitCode !== 0) {
    const said = `${committed.stdout}${committed.stderr}`;
    if (/nothing to commit|nothing added to commit/i.test(said)) {
      // No NEW commit — but don't return yet. An earlier commit whose push
      // failed (stale tunnel origin, say) is still local-only, and this is
      // exactly the moment to make it durable: fall through to the push,
      // which is a no-op when everything is already upstream.
      madeCommit = false;
    } else {
      throw new Error(`Could not commit: ${said.slice(-300)}`);
    }
  }

  let pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
    timeoutMs: 180_000,
  });
  if (pushed.exitCode !== 0 && isUnreachableOrigin(pushed.stderr)) {
    await healBoxOrigin(ctx);
    pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
      timeoutMs: 180_000,
    });
  }
  if (pushed.exitCode !== 0) {
    // Someone else pushed to this branch first, so the push is a
    // non-fast-forward. Pull and try once more — which is exactly what a
    // developer does, and it keeps BOTH commits instead of picking one.
    // If the merge conflicts, the retry fails and git's message says so;
    // resolving it is the person's call, not ours, and the conflict is
    // sitting in a real checkout they can open a terminal on.
    await boxPull(ctx);
    pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
      timeoutMs: 180_000,
    });
  }
  if (pushed.exitCode !== 0) {
    throw new Error(
      `Committed in the sandbox, but the push failed — the commit is not durable yet: ${(pushed.stderr || pushed.stdout).slice(-300)}`,
    );
  }

  if (!madeCommit) {
    return { committed: false, reason: "No changes to commit" };
  }
  const head = await boxExec(ctx, boxGit(ctx, "rev-parse", "HEAD"), {
    timeoutMs: 30_000,
  });
  return { committed: true, commitOid: head.stdout.trim(), message };
}

/** A repo-relative path that stays inside the repo. */
function safeRepoPath(relPath: string): string {
  if (
    !relPath ||
    relPath.startsWith("/") ||
    relPath.split("/").some(seg => seg === "..") ||
    relPath.includes("\0")
  ) {
    throw new Error(`Refusing path outside the repository: ${relPath}`);
  }
  return relPath;
}

/**
 * Stage, unstage, or discard specific files — the per-file actions of VS
 * Code's Source Control view, as the git commands they stand for.
 *
 * discard: the working tree goes back to the INDEX version (what "Discard
 * Changes" on an unstaged change means), and an untracked file is removed;
 * each path is handled on its own so an untracked path does not fail the
 * checkout of the others.
 */
export async function boxGitPaths(
  ctx: SandboxExecContext,
  action: "stage" | "unstage" | "discard",
  paths: string[],
): Promise<void> {
  const safe = paths.map(safeRepoPath);
  if (safe.length === 0) return;
  let command: string;
  if (action === "stage") {
    command = boxGit(ctx, "add", "-A", "--", ...safe);
  } else if (action === "unstage") {
    command = boxGit(ctx, "reset", "-q", "HEAD", "--", ...safe);
  } else {
    // Tracked paths go back to the index version (checkout), untracked ones
    // are removed (clean) — split by `ls-files` so each command runs ONCE
    // over its list. Per-path invocations were 2 git calls per file, which
    // on 300 files outlived the request; and a single checkout over a mixed
    // list aborts entirely on the first untracked pathspec.
    const list = safe.map(sh).join(" ");
    command =
      `tracked=$(${boxGit(ctx, "ls-files", "-z", "--")} ${list} | tr '\\0' '\\n'); ` +
      `if [ -n "$tracked" ]; then printf '%s\\n' "$tracked" | tr '\\n' '\\0' | xargs -0 git -C ${sh(boxRoot(ctx))} checkout -q -- ; fi; ` +
      `${boxGit(ctx, "clean", "-qf", "--")} ${list}`;
  }
  const result = await boxExec(ctx, command, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not ${action} ${safe.length} file(s): ${(result.stderr || result.stdout).slice(-300)}`,
    );
  }
}

export interface BoxFileVersions {
  /** Contents at HEAD; null when the file is new. */
  head: string | null;
  /** Contents in the index; null when not staged/tracked. */
  index: string | null;
  /** Contents in the working tree; null when deleted. */
  working: string | null;
  binary: boolean;
}

/**
 * The three versions a diff can be drawn between (HEAD, index, working
 * tree) — in ONE exec. Each round trip to the sandbox is ~600ms, and the
 * obvious three-command shape made a one-line diff take three seconds.
 * Sections are base64 so no delimiter can occur inside a file.
 */
export async function boxFileVersions(
  ctx: SandboxExecContext,
  relPath: string,
): Promise<BoxFileVersions> {
  const p = safeRepoPath(relPath);
  const git = (spec: string) => boxGit(ctx, "show", spec);
  const file = sh(`${boxRoot(ctx)}/${p}`);
  const script =
    `printf 'H:'; ${git(`HEAD:${p}`)} 2>/dev/null | base64 -w0 && printf '\\n' || printf '-\\n'; ` +
    `printf 'I:'; ${git(`:${p}`)} 2>/dev/null | base64 -w0 && printf '\\n' || printf '-\\n'; ` +
    `printf 'W:'; if [ -f ${file} ]; then base64 -w0 < ${file}; printf '\\n'; else printf '-\\n'; fi`;
  const result = await boxExec(ctx, script, { timeoutMs: 60_000 });
  const sections: Record<string, string | null> = { H: null, I: null, W: null };
  for (const line of result.stdout.split("\n")) {
    const key = line.slice(0, 1);
    if (!(key in sections) || line[1] !== ":") continue;
    const body = line.slice(2);
    // `git show` of a missing object prints nothing and fails: the `||`
    // branch writes "-" for absent. An EMPTY existing file is "" (present).
    sections[key] =
      body === "-" ? null : Buffer.from(body, "base64").toString("utf8");
  }
  const working = sections.W;
  const binary = working !== null && working.includes("\u0000");
  return {
    head: sections.H,
    index: sections.I,
    working: binary ? null : working,
    binary,
  };
}

/** Branch + shaped changes, for pushing a fresh snapshot after a mutation. */
export async function boxPorcelain(
  ctx: SandboxExecContext,
): Promise<{ branch: string | null; changes: ChangedFile[] }> {
  const status = await boxStatus(ctx);
  return { branch: status.branch, changes: status.changes };
}

/**
 * Push commits the server does not have yet, and only then.
 *
 * A commit made in the terminal is a deliberate act, and a sandbox is
 * disposable — so a commit that has not reached the server is one nobody
 * promised to keep. This is the safety net for that, and it is deliberately
 * only about COMMITS: uncommitted work stays uncommitted, exactly as it would
 * on a laptop.
 *
 * The ahead-check runs in the sandbox so the common case (nothing to push)
 * costs no network at all.
 */
export async function boxPushIfAhead(ctx: SandboxExecContext): Promise<void> {
  const push = () =>
    boxExec(
      ctx,
      // A branch with no upstream is the `git checkout -b` case, and there the
      // answer is not "nothing to do" — the branch and every commit on it exist
      // ONLY on a machine that can be thrown away. Push it and set the upstream,
      // which is what push.autoSetupRemote already says we want.
      `if ${boxGit(ctx, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")} >/dev/null 2>&1; then ` +
        `ahead=$(${boxGit(ctx, "rev-list", "--count", "@{u}..HEAD")} 2>/dev/null || echo 0); ` +
        `if [ "$ahead" -gt 0 ]; then ${boxGit(ctx, "push", "-q", "origin", "HEAD")}; fi; ` +
        `else ${boxGit(ctx, "push", "-q", "-u", "origin", "HEAD")}; fi`,
      { timeoutMs: 180_000 },
    );
  let result = await push();
  if (result.exitCode !== 0 && isUnreachableOrigin(result.stderr)) {
    await healBoxOrigin(ctx);
    result = await push();
  }
  if (result.exitCode !== 0) {
    // This is a safety net, so a failure must not break the caller's flow —
    // but silence here is how commits quietly stay trapped in a disposable
    // machine. Leave a trail.
    logger.warn("Apps v2 push-if-ahead failed", {
      sessionKey: ctx.sessionKey,
      said: (result.stderr || result.stdout).slice(-300),
    });
  }
}

/**
 * Switch branches — `git checkout`, and git decides the outcome.
 *
 * Git carries uncommitted work across when the two branches agree about the
 * files you touched, and refuses, naming them, when it would clobber
 * something. Passing its message through beats inventing one: it is the only
 * version that says which file.
 */
export async function boxCheckout(
  ctx: SandboxExecContext,
  branch: string,
  options: { create?: boolean } = {},
): Promise<void> {
  const fetched = await boxExec(ctx, boxGit(ctx, "fetch", "-q", "origin"), {
    timeoutMs: 120_000,
  });
  if (fetched.exitCode !== 0) {
    throw new Error(
      `Could not reach the remote: ${fetched.stderr.slice(-300)}`,
    );
  }
  // Creating: `git checkout -b` from HEAD, then push -u so the branch exists
  // at the remote immediately (auto-commit pushes assume an upstream).
  // Switching: prefer the remote's version if the box has never seen it.
  const result = await boxExec(
    ctx,
    options.create
      ? `${boxGit(ctx, "checkout", "-b", branch)} && ${boxGit(ctx, "push", "-q", "-u", "origin", branch)}`
      : `${boxGit(ctx, "checkout", branch)} || ${boxGit(ctx, "checkout", "-b", branch, `origin/${branch}`)}`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    const said = (result.stderr || result.stdout).trim();
    throw new Error(
      said
        ? `Could not switch to ${branch}.\n${said.slice(-600)}`
        : `Could not switch to ${branch}.`,
    );
  }
}

/** Throw away uncommitted work — what `git reset --hard` means everywhere. */
export async function boxDiscard(ctx: SandboxExecContext): Promise<void> {
  const result = await boxExec(
    ctx,
    // Ignored files (node_modules) stay: reinstalling them is not what
    // "discard my changes" asks for.
    `${boxGit(ctx, "reset", "-q", "--hard")} && ${boxGit(ctx, "clean", "-qfd")}`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not discard changes: ${result.stderr.slice(-300)}`);
  }
}

/** Push/fetch stderr that means "could not REACH origin" (vs a git refusal). */
export function isUnreachableOrigin(stderr: string): boolean {
  return /unable to access|Failed to connect|Could not resolve host/i.test(
    stderr,
  );
}

/**
 * Re-point the box's origin at the CURRENT git endpoint and token.
 *
 * Every `pnpm dev` restarts the tunnel with a fresh URL, so a box configured
 * against the previous one keeps failing every push and pull until something
 * rewrites its remote. Callers invoke this when a git network operation could
 * not reach origin, then retry once.
 */
export async function healBoxOrigin(ctx: SandboxExecContext): Promise<void> {
  logger.warn("Apps v2 origin unreachable; reconfiguring the box remote", {
    sessionKey: ctx.sessionKey,
  });
  const [workspaceId, ...rest] = ctx.sessionKey.split(":");
  await configureBoxRemote({ ctx, workspaceId, userId: rest.join(":") });
}

/**
 * Bring the box up to date with the server — `git pull`, essentially.
 *
 * Fast-forwards a clean tree and merges a dirty one, which is git's own rule.
 * A conflict is left in the working copy rather than resolved on the user's
 * behalf: it is a real conflict in a real checkout, and it is fixable there.
 */
export async function boxPull(ctx: SandboxExecContext): Promise<void> {
  // The merge may legitimately refuse (uncommitted work in the way, or a
  // real conflict) — that is the user's to resolve in their checkout, not
  // ours to force. But refusing SILENTLY cost a debugging session when a
  // stale box kept lacking an app that main had for days: log what git said
  // so "the box is behind and won't catch up" has a trail.
  let result = await boxExec(
    ctx,
    [
      boxGit(ctx, "fetch", "-q", "origin"),
      `${boxGit(ctx, "merge", "--no-edit", "@{u}")}`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
  if (result.exitCode !== 0 && isUnreachableOrigin(result.stderr)) {
    await healBoxOrigin(ctx);
    result = await boxExec(
      ctx,
      [
        boxGit(ctx, "fetch", "-q", "origin"),
        `${boxGit(ctx, "merge", "--no-edit", "@{u}")}`,
      ].join(" && "),
      { timeoutMs: 180_000 },
    );
  }
  if (result.exitCode !== 0) {
    logger.warn("Apps v2 box pull did not merge", {
      sessionKey: ctx.sessionKey,
      said: (result.stderr || result.stdout).slice(-400),
    });
  }
}

/**
 * Copy a directory out of the sandbox — a build's `dist/`, typically.
 *
 * Not a git operation: build output is deliberately not committed, so it
 * cannot travel as a commit, and publishing still needs the bytes. A tar
 * through the provider's file channel is the plain way to move a directory
 * off a machine.
 */
export async function readBoxDir(
  ctx: SandboxExecContext,
  boxRelDir: string,
  destDir: string,
): Promise<void> {
  const execFileAsync = promisify(execFile);
  const archive = `${getSandboxProvider().scratch(ctx)}/mako-dir-${process.hrtime.bigint()}.tar.gz`;
  // Packed from INSIDE the directory, so entries are "./x" and extraction
  // needs no guessing about how many leading components to strip.
  const packed = await boxExec(
    ctx,
    `tar -czf ${sh(archive)} -C ${sh(`${boxRoot(ctx)}/${boxRelDir}`)} .`,
    { timeoutMs: 180_000 },
  );
  if (packed.exitCode !== 0) {
    throw new Error(
      `Could not read ${boxRelDir} from the sandbox: ${packed.stderr.slice(-300)}`,
    );
  }
  const bytes = await getSandboxProvider().readFile(ctx, archive);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-dir-"));
  try {
    const localArchive = path.join(tmp, "dir.tar.gz");
    await fs.writeFile(localArchive, Buffer.from(bytes));
    await fs.mkdir(destDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", localArchive, "-C", destDir]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await boxExec(ctx, `rm -f ${sh(archive)}`, { timeoutMs: 15_000 }).catch(
      () => undefined,
    );
  }
}
