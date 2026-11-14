/**
 * Git history for one entity's files in the workspace repo — the reads behind
 * every History popover (consoles, notebooks, flows, connectors; apps.md §16).
 *
 * An entity is a set of repo paths it owns: a console's file and its chart
 * sidecar, a notebook's `.deepnote`, a flow's `flows/<slug>.yml`, a
 * connector's whole `connectors/<slug>/` folder. Each kind supplies a
 * pathspec for `git log` and an ownership test; everything else is shared.
 *
 * The ownership test is also the access check for file reads: the diff route
 * takes a path from the caller, and the repo holds other people's private
 * files, so a path the entity does not own is refused rather than read.
 */
import { boundRepoDirIfExists } from "./workspace-repo-required";
import { EMPTY_TREE } from "./git";
import {
  DEFAULT_BRANCH,
  diffNameStatus,
  log as repoLog,
  logFollow,
  readBlob,
  resolveCommit,
  type ChangedFile,
  type CommitInfo,
  type FollowedCommit,
} from "./repository.service";

const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

export interface EntityGitScope {
  workspaceId: string;
  /** `git log` pathspec: a file, or a directory with a trailing slash. */
  pathspec: string;
  /** Whether a repo path belongs to this entity. */
  owns: (path: string) => boolean;
}

export interface CommitChanges {
  sha: string;
  parent: string | null;
  files: ChangedFile[];
}

export interface FileVersions {
  before: string | null;
  after: string | null;
  binary: boolean;
}

/** The path is not this entity's — the caller answers 403. */
export class NotEntityPathError extends Error {
  constructor(path: string) {
    super(`Path is not part of this entity: ${path}`);
    this.name = "NotEntityPathError";
  }
}

/** A directory scope: everything under `dir/`. */
export function directoryScope(
  workspaceId: string,
  dir: string,
): EntityGitScope {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return {
    workspaceId,
    pathspec: prefix,
    owns: p => p.startsWith(prefix),
  };
}

/** A scope of exact files; the first is the one `git log` follows. */
export function fileScope(
  workspaceId: string,
  primary: string,
  ...others: string[]
): EntityGitScope {
  const mine = new Set([primary, ...others]);
  return { workspaceId, pathspec: primary, owns: p => mine.has(p) };
}

/** Commits on main that touched the entity, newest first. */
export async function entityHistory(
  scope: EntityGitScope,
  limit = 50,
): Promise<CommitInfo[]> {
  const repoDir = await boundRepoDirIfExists(scope.workspaceId);
  if (repoDir == null) return [];
  if (!(await resolveCommit(repoDir, MAIN_REF))) return [];
  return repoLog(repoDir, MAIN_REF, limit, scope.pathspec);
}

async function commitAndParent(
  workspaceId: string,
  sha: string,
): Promise<{ repoDir: string; oid: string; parent: string | null }> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) throw new Error(`No such commit: ${sha}`);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  return { repoDir, oid, parent };
}

/** What one commit did to the entity's files. */
export async function entityCommitChanges(
  scope: EntityGitScope,
  sha: string,
): Promise<CommitChanges> {
  const { repoDir, oid, parent } = await commitAndParent(
    scope.workspaceId,
    sha,
  );
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  return { sha: oid, parent, files: all.filter(f => scope.owns(f.path)) };
}

/** One of the entity's files before and after a commit (null = absent). */
export async function entityFileVersions(
  scope: EntityGitScope,
  sha: string,
  relPath: string,
): Promise<FileVersions> {
  if (!scope.owns(relPath)) throw new NotEntityPathError(relPath);
  const { repoDir, oid, parent } = await commitAndParent(
    scope.workspaceId,
    sha,
  );
  const read = async (ref: string | null) => {
    if (!ref) return null;
    try {
      return await readBlob(repoDir, ref, relPath);
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([read(parent), read(oid)]);
  return {
    before: before?.isBinary ? null : (before?.contents ?? null),
    after: after?.isBinary ? null : (after?.contents ?? null),
    binary: Boolean(before?.isBinary || after?.isBinary),
  };
}

// ---------------------------------------------------------------------------
// One file followed across its renames (consoles, notebooks)
// ---------------------------------------------------------------------------

/**
 * A file-backed entity that keeps its id when its file is renamed or moved.
 * Its history is the file's own rename chain — not whatever else has lived
 * at its current path, and not the paths it used to have once another file
 * took them. So every read is scoped by COMMIT: a path is the entity's only
 * in a commit of its own history, under the name it had in that commit.
 */
export interface FollowedFile {
  workspaceId: string;
  /** Where the file is now; undefined while it has none (in the trash). */
  path?: string | null;
  /**
   * Earlier lives, oldest first: the path the file had and the commit
   * that removed it (a trip to the trash; a restore starts a new file).
   */
  earlier?: ReadonlyArray<{ path: string; until: string }>;
  /** A companion file that travels with it (a console's chart sidecar). */
  companionOf?: (path: string) => string | undefined;
}

/** The entity's commits, newest first, each with the file's path in it. */
export async function followedHistory(
  file: FollowedFile,
  limit = 50,
): Promise<FollowedCommit[]> {
  const repoDir = await boundRepoDirIfExists(file.workspaceId);
  if (repoDir == null) return [];
  if (!(await resolveCommit(repoDir, MAIN_REF))) return [];
  const out: FollowedCommit[] = [];
  const seen = new Set<string>();
  const add = (commits: FollowedCommit[]) => {
    for (const commit of commits) {
      if (seen.has(commit.oid)) continue;
      seen.add(commit.oid);
      out.push(commit);
    }
  };
  if (file.path) add(await logFollow(repoDir, MAIN_REF, limit, file.path));
  for (const life of [...(file.earlier ?? [])].reverse()) {
    if (out.length >= limit) break;
    // A removing commit that is no longer in the repo takes that life along.
    const until = await resolveCommit(repoDir, life.until);
    if (until) add(await logFollow(repoDir, until, limit, life.path));
  }
  return out.slice(0, limit);
}

/** The entity's own entry for `sha`, or null when the commit is not its. */
async function followedAt(
  file: FollowedFile,
  sha: string,
): Promise<{
  repoDir: string;
  oid: string;
  parent: string | null;
  at: FollowedCommit | null;
}> {
  const found = await commitAndParent(file.workspaceId, sha);
  const history = await followedHistory(file, 200);
  return { ...found, at: history.find(c => c.oid === found.oid) ?? null };
}

/** What one commit did to the entity's file (and its companion). */
export async function followedCommitChanges(
  file: FollowedFile,
  sha: string,
): Promise<CommitChanges> {
  const { repoDir, oid, parent, at } = await followedAt(file, sha);
  if (!at) return { sha: oid, parent, files: [] };
  const mine = new Set<string>();
  for (const p of [at.path, at.previousPath]) {
    if (!p) continue;
    mine.add(p);
    const companion = file.companionOf?.(p);
    if (companion) mine.add(companion);
  }
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  return { sha: oid, parent, files: all.filter(f => mine.has(f.path)) };
}

/**
 * The entity's file (or companion) before and after one of ITS commits.
 * `relPath` is the name the file had in that commit, or its current one
 * (or omitted) — both mean "this entity's file then". Anything else throws
 * {@link NotEntityPathError}: the repo holds other people's private files.
 */
export async function followedFileVersions(
  file: FollowedFile,
  sha: string,
  relPath?: string,
): Promise<FileVersions> {
  const { repoDir, oid, parent, at } = await followedAt(file, sha);
  if (!at) throw new NotEntityPathError(relPath ?? file.path ?? "");
  const companion = (p: string | undefined | null) =>
    (p && file.companionOf?.(p)) || undefined;
  const before = at.previousPath ?? at.path;
  let pair: [string, string] | undefined;
  if (!relPath || relPath === at.path || relPath === file.path) {
    pair = [before, at.path];
  } else if (
    relPath === companion(at.path) ||
    relPath === companion(file.path)
  ) {
    pair = [companion(before) as string, companion(at.path) as string];
  }
  if (!pair) throw new NotEntityPathError(relPath ?? "");
  const read = (ref: string | null, rel: string) =>
    ref ? readBlob(repoDir, ref, rel).catch(() => null) : null;
  const [was, is] = await Promise.all([
    read(parent, pair[0]),
    read(oid, pair[1]),
  ]);
  return {
    before: was?.isBinary ? null : (was?.contents ?? null),
    after: is?.isBinary ? null : (is?.contents ?? null),
    binary: Boolean(was?.isBinary || is?.isBinary),
  };
}

/** Where the entity's file was in `sha`, when that is one of its commits. */
export async function followedPathAt(
  file: FollowedFile,
  sha: string,
): Promise<string | null> {
  return (await followedAt(file, sha)).at?.path ?? null;
}
