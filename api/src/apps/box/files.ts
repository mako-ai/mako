/**
 * The client: a file system, a shell, and git — the working copy's files
 * and status, read and written in the box.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import type { ChangedFile, GrepMatch, TreeEntry } from "../repository.service";
import { sh, boxRoot, boxGit } from "./shell";

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
