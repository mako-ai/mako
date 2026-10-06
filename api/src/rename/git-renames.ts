/**
 * Laptop-rename detection for file-backed kinds (brief rule 3).
 *
 * A push from a checkout can move a file AND edit it in the same commit —
 * `git mv consoles/a.sql consoles/b.sql` followed by a tweak. The syncs that
 * reconcile Mongo with the tree only see "a vanished, b appeared"; matching
 * by identical blob (consoles) or by path (notebooks) tears the old row down
 * and mints a new path-derived id, so `/c/<old>` dies and every share,
 * schedule and telemetry row attached to it detaches.
 *
 * Git already knows the answer: `diff -M` pairs a deletion with an addition
 * of similar content. The sync does not store the commit it last reconciled,
 * so for each vanished path the last commit that touched it (its deletion)
 * is found and its parent — the last tree that still had the file — is
 * diffed against head. One diff per deletion commit, however many files it
 * removed, and nothing at all when no path vanished.
 */
import { EMPTY_TREE, runGit } from "../apps/git";

/** vanished path → the path git says it was renamed to. */
export type RenamedPaths = Map<string, string>;

/**
 * Which of `vanishedPaths` (present at some earlier commit, absent at
 * `head`) git sees as renamed, and to what. `roots` limits the diff to the
 * directories the kind lives in; a rename out of them is not a rename of
 * that kind. Unknown paths and git failures yield no match — the caller
 * then falls back to treating the path as deleted, exactly as before.
 */
export async function detectRenamedPaths(
  repoDir: string,
  head: string,
  vanishedPaths: readonly string[],
  roots: readonly string[],
): Promise<RenamedPaths> {
  const out: RenamedPaths = new Map();
  if (vanishedPaths.length === 0) return out;

  // Group the vanished paths by the commit that deleted them: a `git mv` of
  // a whole folder removes many files in one commit, and one diff from its
  // parent answers for all of them.
  const byDeletion = new Map<string, string[]>();
  for (const path of vanishedPaths) {
    const deletedIn = await lastCommitTouching(repoDir, head, path);
    if (!deletedIn) continue;
    const list = byDeletion.get(deletedIn) ?? [];
    list.push(path);
    byDeletion.set(deletedIn, list);
  }

  const wanted = new Set(vanishedPaths);
  for (const [deletion, paths] of byDeletion) {
    const base = (await parentOf(repoDir, deletion)) ?? EMPTY_TREE;
    if (base === EMPTY_TREE) continue; // nothing existed before: no rename
    const pairs = await renamesBetween(repoDir, base, head, roots);
    for (const [from, to] of pairs) {
      if (wanted.has(from) && paths.includes(from)) out.set(from, to);
    }
  }
  return out;
}

/**
 * `old path → new path` for every rename git detects between two commits
 * under `roots` (`-M`, default 50% similarity — so a file moved and lightly
 * edited still pairs with its origin).
 */
export async function renamesBetween(
  repoDir: string,
  from: string,
  to: string,
  roots: readonly string[],
): Promise<RenamedPaths> {
  const out: RenamedPaths = new Map();
  if (!from || !to || from === to) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "diff",
        "--name-status",
        "-M",
        "-z",
        "--diff-filter=R",
        from,
        to,
        "--",
        ...roots,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return out;
  }
  // -z output: R<score>\0<old>\0<new>\0 per rename.
  const fields = stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [status, oldPath, newPath] = [
      fields[i],
      fields[i + 1],
      fields[i + 2],
    ];
    if (!status.startsWith("R") || !oldPath || !newPath) continue;
    out.set(oldPath, newPath);
  }
  return out;
}

/** The newest commit at or before `head` that changed `path` (its deletion, for a vanished path). */
async function lastCommitTouching(
  repoDir: string,
  head: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "log",
      "-1",
      "--format=%H",
      head,
      "--",
      path,
    ]);
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

async function parentOf(repoDir: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}^`,
    ]);
    const parent = stdout.trim();
    return parent || null;
  } catch {
    return null;
  }
}
