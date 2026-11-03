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
  readBlob,
  resolveCommit,
  type ChangedFile,
  type CommitInfo,
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
