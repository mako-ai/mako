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
 * (pathspec) and to the newest `limit` commits that renamed something
 * there. A rename older than that is not found, which is a stale link, not
 * a wrong answer — the caller already tried the current name and the
 * recorded aliases first.
 */
import { runGit } from "../apps/git";

export interface RenamePair {
  from: string;
  to: string;
}

/**
 * Parse `git log --format=%x01%H -M --name-status --diff-filter=R -z`:
 * each commit is `\x01<sha>\0\n` followed by `R<score>\0<old>\0<new>\0`
 * triples. Newest commit first, exactly as git prints them.
 */
export function parseRenameLog(stdout: string): RenamePair[][] {
  const commits: RenamePair[][] = [];
  for (const chunk of stdout.split("\x01")) {
    if (!chunk) continue;
    const headerEnd = chunk.indexOf("\0");
    if (headerEnd < 0) continue;
    const body = chunk.slice(headerEnd + 1).replace(/^\n/, "");
    const fields = body.split("\0");
    const pairs: RenamePair[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (!fields[i].startsWith("R")) continue;
      pairs.push({ from: fields[i + 1], to: fields[i + 2] });
    }
    commits.push(pairs);
  }
  return commits;
}

/**
 * Follow the rename chain of `path` forward through `commits` (newest
 * first, as `parseRenameLog` returns them). Returns the newest name, or
 * null when nothing ever renamed `path` within the scanned window.
 */
export function followRenames(
  path: string,
  commits: RenamePair[][],
): string | null {
  let current = path;
  let moved = false;
  // Oldest first, so a→b is applied before b→c.
  for (let i = commits.length - 1; i >= 0; i--) {
    for (const pair of commits[i]) {
      if (pair.from === current) {
        current = pair.to;
        moved = true;
        break;
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
export async function findRenamedPath(
  repoDir: string,
  ref: string,
  oldPath: string,
  dirPrefix: string,
  limit = 200,
): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        "--format=%x01%H",
        "-M",
        "--name-status",
        "--diff-filter=R",
        "-z",
        "-n",
        String(Math.max(1, Math.min(limit, 1000))),
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
  limit = 200,
): Promise<string | null> {
  const next = await findRenamedPath(
    repoDir,
    ref,
    `${dir}/${oldFolder}/${marker}`,
    dir,
    limit,
  );
  if (!next) return null;
  const m = new RegExp(
    `^${escapeRegExp(dir)}/([^/]+)/${escapeRegExp(marker)}$`,
  ).exec(next);
  return m ? m[1] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
