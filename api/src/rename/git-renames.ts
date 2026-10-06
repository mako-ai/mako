/**
 * Where did a path go? — rename history straight from the object database.
 *
 * Git-backed kinds whose identity IS a path (dbt files, skill folders,
 * connector folders) have nowhere to record an alias when the rename was a
 * bare `git mv` from a laptop, or happened before aliases existed. Git still
 * knows: `git log -M` pairs the deleted path with the added one when their
 * contents match. This module follows that chain forward — a → b → c — and
 * answers "the file you asked for is `c` now", or nothing.
 *
 * Bounded on purpose: the scan is limited to the kind's own directory
 * (pathspec) and to the newest `limit` commits that added, deleted or
 * renamed something there. A rename older than that is not found, which is a stale link, not
 * a wrong answer — the caller already tried the current name and the
 * recorded aliases first.
 */
import { runGit } from "../apps/git";

export interface RenamePair {
  from: string;
  to: string;
}

/** One change under the scanned directory: a rename, an add or a delete. */
export interface PathChange {
  status: "R" | "A" | "D";
  /** For `A`/`D` both sides are the same path. */
  from: string;
  to: string;
}

/**
 * Parse `git log --format=%x01%H --name-status --diff-filter=ADR -z`:
 * each commit is `\x01<sha>\0\n` followed by `R<score>\0<old>\0<new>\0`
 * triples and `A\0<path>\0` / `D\0<path>\0` pairs. Newest commit first,
 * exactly as git prints them.
 */
export function parseRenameLog(stdout: string): PathChange[][] {
  const commits: PathChange[][] = [];
  for (const chunk of stdout.split("\x01")) {
    if (!chunk) continue;
    const headerEnd = chunk.indexOf("\0");
    if (headerEnd < 0) continue;
    const body = chunk.slice(headerEnd + 1).replace(/^\n/, "");
    const fields = body.split("\0");
    const changes: PathChange[] = [];
    for (let i = 0; i < fields.length; ) {
      const code = fields[i];
      if (code.startsWith("R") && i + 2 < fields.length) {
        changes.push({ status: "R", from: fields[i + 1], to: fields[i + 2] });
        i += 3;
      } else if ((code === "A" || code === "D") && i + 1 < fields.length) {
        changes.push({ status: code, from: fields[i + 1], to: fields[i + 1] });
        i += 2;
      } else {
        i += 1;
      }
    }
    commits.push(changes);
  }
  return commits;
}

/**
 * Follow the rename chain of `path` forward through `commits` (newest
 * first, as `parseRenameLog` returns them). Returns the newest name, or
 * null when nothing ever renamed `path` within the scanned window — or
 * when the chain was cut: a DELETE of the current name after a rename
 * means the file is gone, and a later file created under that name is a
 * different file (a → b, b deleted, a new b: `a` must not open the new b).
 */
export function followRenames(
  path: string,
  commits: PathChange[][],
): string | null {
  let current = path;
  let moved = false;
  // Oldest first, so a→b is applied before b→c.
  for (let i = commits.length - 1; i >= 0; i--) {
    for (const change of commits[i]) {
      if (change.status === "R" && change.from === current) {
        current = change.to;
        moved = true;
        break;
      }
      if (change.status === "D" && moved && change.from === current) {
        return null;
      }
    }
  }
  return moved ? current : null;
}

/** Does `path` exist in the tree of `ref`? */
export async function pathExistsAt(
  repoDir: string,
  ref: string,
  path: string,
): Promise<boolean> {
  return runGit(["-C", repoDir, "cat-file", "-e", `${ref}:${path}`])
    .then(() => true)
    .catch(() => false);
}

/**
 * The current path of a file that used to be at `oldPath`, following git's
 * rename detection along `ref`'s history under `dirPrefix`. Null when the
 * chain cannot be followed, or when it ends at a path that no longer exists
 * (renamed, then deleted: a dead link, honestly reported).
 *
 * `oldPath` existing at `ref` is the caller's concern — this answers only
 * "where did it go", never "is it still here".
 */
export interface RenameScanOptions {
  /** Newest commits that added, deleted or renamed under the directory to scan (default 500). */
  limit?: number;
  /**
   * Minimum similarity (percent) for git to call a delete + add a rename
   * (git's default is 50). Kinds whose marker file is small and often
   * identical across objects (a connector's entry file) ask for more, so
   * two unrelated folders are not paired.
   */
  similarity?: number;
}

function renameFlag(options: RenameScanOptions): string {
  const pct = options.similarity;
  return pct && pct > 0 && pct <= 100 ? `-M${Math.round(pct)}%` : "-M";
}

export async function findRenamedPath(
  repoDir: string,
  ref: string,
  oldPath: string,
  dirPrefix: string,
  options: RenameScanOptions = {},
): Promise<string | null> {
  const limit = options.limit ?? 500;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        "--format=%x01%H",
        renameFlag(options),
        "--name-status",
        // Adds and deletes too: a delete of the renamed-to path cuts the
        // chain (see followRenames), and only the log can show it.
        "--diff-filter=ADR",
        "-z",
        "-n",
        String(Math.max(1, Math.min(limit, 2000))),
        ref,
        "--",
        dirPrefix,
      ],
      { timeoutMs: 30_000, maxBufferBytes: 8 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  const next = followRenames(oldPath, parseRenameLog(stdout));
  if (!next || next === oldPath) return null;
  return (await pathExistsAt(repoDir, ref, next)) ? next : null;
}

/**
 * The folder a path moved to, for kinds keyed by directory: the rename of
 * `<dir>/<old>/<marker>` to `<dir>/<new>/<marker>` names the folder rename.
 */
export async function findRenamedFolder(
  repoDir: string,
  ref: string,
  dir: string,
  oldFolder: string,
  marker: string,
  options: RenameScanOptions = {},
): Promise<string | null> {
  const next = await findRenamedPath(
    repoDir,
    ref,
    `${dir}/${oldFolder}/${marker}`,
    dir,
    options,
  );
  if (!next) return null;
  const m = new RegExp(
    `^${escapeRegExp(dir)}/([^/]+)/${escapeRegExp(marker)}$`,
  ).exec(next);
  return m ? m[1] : null;
}

/**
 * Folder renames between two commits, for kinds keyed by directory whose
 * index remembers the commit it last read (`row.sha`): a push that moved
 * `<dir>/<old>/<marker>` to `<dir>/<new>/<marker>` is a rename, not a
 * delete plus a create. Returns new folder → old folder. Empty (never a
 * throw) when either commit is unknown here.
 */
export async function renamedFoldersBetween(
  repoDir: string,
  fromCommit: string,
  toCommit: string,
  dir: string,
  marker: string,
  options: RenameScanOptions = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!fromCommit || !toCommit || fromCommit === toCommit) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "diff",
        "--name-status",
        renameFlag(options),
        "-z",
        "--diff-filter=R",
        fromCommit,
        toCommit,
        "--",
        dir,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return out;
  }
  const fields = stdout.split("\0");
  const re = new RegExp(
    `^${escapeRegExp(dir)}/([^/]+)/${escapeRegExp(marker)}$`,
  );
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (!fields[i].startsWith("R")) continue;
    const from = re.exec(fields[i + 1]);
    const to = re.exec(fields[i + 2]);
    if (from && to && from[1] !== to[1]) out.set(to[1], from[1]);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
