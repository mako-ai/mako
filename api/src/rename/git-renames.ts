/**
 * Where did a path go? Rename history read from git.
 *
 * A kind whose identity IS a path (a dbt file, a skill folder) has nowhere
 * to record an old name when the rename was a bare `git mv` from a laptop.
 * Git still knows: `git log -M` pairs a deleted path with an added one when
 * their contents match. This follows that chain forward (a → b → c) and
 * answers "the file you asked for is `c` now", or nothing.
 *
 * Bounded on purpose: the scan is limited to the kind's own directory
 * (pathspec) and to the newest `limit` commits that added, deleted or
 * renamed something there. A rename older than that is not found, which is
 * a stale link, not a wrong answer: the caller tried the current name
 * first.
 */
import { runGit } from "../apps/git";

/** One change under the scanned directory: a rename, an add or a delete. */
export interface PathChange {
  status: "R" | "A" | "D";
  /** For `A`/`D` both sides are the same path. */
  from: string;
  to: string;
}

/**
 * Parse `git log --format=%x01%H --name-status --diff-filter=ADR -z`: each
 * commit is `\x01<sha>\0\n` followed by `R<score>\0<old>\0<new>\0` triples
 * and `A\0<path>\0` / `D\0<path>\0` pairs. Newest commit first, as printed.
 */
export function parseRenameLog(stdout: string): PathChange[][] {
  const commits: PathChange[][] = [];
  for (const chunk of stdout.split("\x01")) {
    const headerEnd = chunk.indexOf("\0");
    if (headerEnd < 0) continue;
    const fields = chunk
      .slice(headerEnd + 1)
      .replace(/^\n/, "")
      .split("\0");
    const changes: PathChange[] = [];
    for (let i = 0; i < fields.length;) {
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
 * first). Returns the newest name, or null when nothing renamed `path` in
 * the scanned window, or when the chain was cut:
 *
 *   - the name it moved to was DELETED: the file is gone, and a later file
 *     created under that name is a different file;
 *   - `path` itself was taken again after it moved (a new file created
 *     there, or another file renamed onto it): the name belongs to that
 *     newcomer for good, even after the newcomer is gone. An old link never
 *     leads back to the object that gave the name up.
 */
export function followRenames(
  path: string,
  commits: PathChange[][],
): string | null {
  let current = path;
  let moved = false;
  // Oldest first, so a → b is applied before b → c.
  for (let i = commits.length - 1; i >= 0; i--) {
    for (const change of commits[i]) {
      if (change.status === "R" && change.from === current) {
        current = change.to;
        moved = true;
        break;
      }
      if (!moved) continue;
      if (change.status === "D" && change.from === current) return null;
      if (change.status !== "D" && change.to === path) return null;
    }
  }
  return moved ? current : null;
}

export interface RenameScanOptions {
  /** Newest commits touching the directory to scan (default 500, at most 2000). */
  limit?: number;
}

/**
 * The current path of a file that used to be at `oldPath`, following git's
 * rename detection along `ref`'s history under `dirPrefix`. Null when the
 * chain cannot be followed or ends at a path that no longer exists (renamed,
 * then deleted: a dead link, reported as one). A bad ref is "not found",
 * never a throw.
 *
 * Whether `oldPath` still exists at `ref` is the caller's question; this
 * answers only "where did it go".
 */
export async function findRenamedPath(
  repoDir: string,
  ref: string,
  oldPath: string,
  dirPrefix: string,
  options: RenameScanOptions = {},
): Promise<string | null> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
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
        // Adds and deletes too: they are what cuts a chain.
        "--diff-filter=ADR",
        "-z",
        "-n",
        String(limit),
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
  const exists = await runGit([
    "-C",
    repoDir,
    "cat-file",
    "-e",
    `${ref}:${next}`,
  ])
    .then(() => true)
    .catch(() => false);
  return exists ? next : null;
}
