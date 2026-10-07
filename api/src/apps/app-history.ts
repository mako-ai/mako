/**
 * An app's own history across its renames.
 *
 * An app is a folder, and `git log -- <folder>` knows only the folder's
 * CURRENT name: the History panel of an app renamed from `apps/a` to
 * `apps/acq` started at the rename, and "View changes" on anything older
 * showed nothing. Git has `--follow`, but for one file only. So the walk is
 * done here: one `git log -M --name-status` over the app's current folder
 * and every folder it is known to have had (its aliases, from the index),
 * read newest first while tracking where the app was —
 *
 *  - a commit is the app's when it touched the folder the app was in at
 *    that point of the walk;
 *  - the commit that moved the app INTO that folder (git pairs its files
 *    `old/x → new/x`; failing that, the old folder's manifest deleted and
 *    the new one added in the same commit) is the app's too, and from
 *    there back the app was in the old folder;
 *  - the commit that CREATED the manifest where the app was is its first:
 *    anything older at that folder was another app (deleted, or moved away
 *    before this one took the name).
 *
 * A later app that took one of the old names never shows up: by the time
 * it arrived, the walk had already left that folder behind.
 */
import { runGit } from "./git";
import {
  APP_MANIFEST,
  APPS_DIR,
  USERS_DIR,
  parseAppRepoPath,
} from "./app-paths";
import type { CommitInfo } from "./repository.service";

/** One commit of an app's history, and where the app was in it. */
export interface AppHistoryCommit extends CommitInfo {
  /** The app's folder after this commit. */
  root: string;
  /** For the commit that moved the app: its folder before. */
  previousRoot?: string;
}

interface LogEntry {
  status: string;
  path: string;
  from?: string;
}

interface LogCommit extends CommitInfo {
  entries: LogEntry[];
}

/**
 * Parse `git log --format=%x01%H%x00%an%x00%at%x00%s --name-status -z -M`:
 * `\x01<sha>\0<author>\0<at>\0<subject>\0` then, per file,
 * `<status>\0<path>\0` (`R<score>\0<from>\0<to>\0` for a rename). Pure.
 */
export function parseNameStatusLog(stdout: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const chunk of stdout.split("\x01")) {
    if (!chunk) continue;
    const fields = chunk.split("\0");
    const [oid, author, at, subject] = fields;
    if (!oid) continue;
    const entries: LogEntry[] = [];
    for (let i = 4; i < fields.length; i++) {
      const status = fields[i].trim();
      if (!status) continue;
      if (/^[RC]\d*$/.test(status)) {
        const from = fields[i + 1];
        const to = fields[i + 2];
        i += 2;
        if (from && to) entries.push({ status: status[0], path: to, from });
      } else if (/^[AMDT]$/.test(status)) {
        const path = fields[i + 1];
        i += 1;
        if (path) entries.push({ status, path });
      }
    }
    commits.push({
      oid,
      author: author ?? "",
      timestamp: Number(at) * 1000,
      subject: subject ?? "",
      entries,
    });
  }
  return commits;
}

const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);

/**
 * The walk (see the module doc) over parsed commits, newest first. Pure.
 * `candidates` are the folders the app may have been in before (only
 * these count as where a manifest deleted beside the app's own creation
 * came from).
 */
export function walkAppLineage(
  commits: readonly LogCommit[],
  root: string,
  candidates: readonly string[],
  limit: number,
): AppHistoryCommit[] {
  const out: AppHistoryCommit[] = [];
  let current = root;
  const manifestOf = (dir: string) => `${dir}/${APP_MANIFEST}`;
  for (const commit of commits) {
    const touches = commit.entries.some(
      e => within(e.path, current) || (!!e.from && within(e.from, current)),
    );
    if (!touches) continue;
    // Where the app came from, if this commit moved it into `current`:
    // its files renamed `old/x → current/x` (the manifest's pair decides
    // when git found one; else the most files).
    const votes = new Map<string, number>();
    let manifestFrom: string | undefined;
    for (const e of commit.entries) {
      if (!e.from || !within(e.path, current) || within(e.from, current)) {
        continue;
      }
      const rel = e.path.slice(current.length);
      if (!e.from.endsWith(rel)) continue;
      const from = e.from.slice(0, e.from.length - rel.length);
      if (!from || !parseAppRepoPath(from)) continue;
      votes.set(from, (votes.get(from) ?? 0) + 1);
      if (rel === `/${APP_MANIFEST}`) manifestFrom = from;
    }
    let previous: string | undefined =
      manifestFrom ??
      [...votes].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]?.[0];
    const created = commit.entries.some(
      e => e.status === "A" && e.path === manifestOf(current),
    );
    if (!previous && created) {
      // A move AND an edit of a tiny manifest: git pairs nothing, but the
      // old folder's manifest went in the very commit this one came.
      previous = candidates.find(c =>
        commit.entries.some(e => e.status === "D" && e.path === manifestOf(c)),
      );
    }
    out.push({
      oid: commit.oid,
      author: commit.author,
      timestamp: commit.timestamp,
      subject: commit.subject,
      root: current,
      ...(previous ? { previousRoot: previous } : {}),
    });
    if (out.length >= limit) break;
    if (previous) {
      current = previous;
      continue;
    }
    if (created) break;
  }
  return out;
}

/** How many commits one walk reads at most (old folders' too). */
export const APP_HISTORY_SCAN_MAX_COMMITS = 2000;

/**
 * Folders an alias may name: a slug alias `x` was `apps/x`; a path alias
 * is a path, with or without its leading `apps/`.
 */
export function aliasFolders(aliases: readonly string[]): string[] {
  const out = new Set<string>();
  for (const alias of aliases) {
    const path =
      alias.startsWith(`${APPS_DIR}/`) || alias.startsWith(`${USERS_DIR}/`)
        ? alias
        : `${APPS_DIR}/${alias}`;
    if (parseAppRepoPath(path)) out.add(path);
  }
  return [...out];
}

/**
 * The app's history at `ref`, newest first, across the folders it had
 * (`previousRoots`, e.g. aliasFolders of its aliases): see the module doc.
 */
export async function appHistory(
  repoDir: string,
  ref: string,
  root: string,
  previousRoots: readonly string[],
  limit = 20,
): Promise<AppHistoryCommit[]> {
  const candidates = previousRoots.filter(r => r !== root && !within(root, r));
  const { stdout } = await runGit(
    [
      "-C",
      repoDir,
      "log",
      "-M",
      "--format=%x01%H%x00%an%x00%at%x00%s",
      "--name-status",
      "-z",
      "-n",
      // Without old folders every commit read is the app's, up to its
      // creation: `limit` of them is enough. With them, commits at an old
      // folder after the app left it are read and skipped.
      String(
        candidates.length > 0
          ? APP_HISTORY_SCAN_MAX_COMMITS
          : Math.max(1, Math.min(limit, APP_HISTORY_SCAN_MAX_COMMITS)),
      ),
      ref,
      "--",
      root,
      ...candidates,
    ],
    { timeoutMs: 60_000 },
  );
  return walkAppLineage(parseNameStatusLog(stdout), root, candidates, limit);
}
