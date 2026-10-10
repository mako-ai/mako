/**
 * History scopes and restore for the repo-authoritative kinds whose files are
 * read by a push reactor rather than projected from a row: flows
 * (`flows/<slug>.yml`) and workspace connectors (`connectors/<slug>/`).
 *
 * A restore is an ordinary commit on main that puts the old files back —
 * history stays append-only, so a restore can itself be undone — followed by
 * the same sync a `git push` triggers. Going through the reactor (rather than
 * writing the row directly) keeps one path from file to runtime: the file is
 * validated, a refused definition is marked invalid instead of half-applied,
 * and CDC streams / connector rows reconcile exactly as they would on a push.
 */
import { RepoRequiredError } from "../apps/config";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  directoryScope,
  fileScope,
  type EntityGitScope,
} from "../apps/entity-git-history";
import {
  DEFAULT_BRANCH,
  listTree,
  log as repoLog,
  readBlob,
  resolveCommit,
} from "../apps/repository.service";
import { commitConfigToMain } from "./flow-config.service";
import { flowFilePath, parseFlowFileResult } from "./flow-config-files";
import { syncFlowsFromRepo, type FlowSyncResult } from "./flow-sync.service";
import { CONNECTORS_DIR } from "../connectors/workspace/resolver";
import { isValidSlug } from "../connectors/workspace/connector-file";
import {
  syncConnectorsFromRepo,
  type ConnectorSyncResult,
} from "../connectors/workspace/reconcile.service";

const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

/** A restore the caller asked for that cannot be done — answered with 400. */
export class RestoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

export function flowGitScope(workspaceId: string, slug: string) {
  return fileScope(workspaceId, flowFilePath(slug));
}

export function connectorGitScope(
  workspaceId: string,
  slug: string,
): EntityGitScope {
  if (!isValidSlug(slug)) {
    throw new RestoreRefusedError(`Not a connector slug: ${slug}`);
  }
  return directoryScope(workspaceId, `${CONNECTORS_DIR}/${slug}`);
}

async function resolveRestorePoint(
  workspaceId: string,
  sha: string,
): Promise<{ repoDir: string; oid: string; subject: string }> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) throw new RepoRequiredError();
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new RestoreRefusedError(`No such commit: ${sha}`);
  const [info] = await repoLog(repoDir, oid, 1);
  return { repoDir, oid, subject: info?.subject ?? "" };
}

/** The same subject consoles and apps use for a restore commit. */
function restoreMessage(oid: string, subject: string): string {
  return `Restore${subject ? ` "${subject}"` : ""} (${oid.slice(0, 7)})`;
}

export interface FlowRestoreResult {
  unchanged: boolean;
  sync: FlowSyncResult;
}

/**
 * Put `flows/<slug>.yml` back to its content at `sha` as a new commit on main,
 * then apply it through the push reactor. A file that no longer parses is
 * refused up front: committing it would only mark the live flow invalid.
 */
export async function restoreFlowTo(args: {
  workspaceId: string;
  slug: string;
  sha: string;
  actorUserId?: string;
}): Promise<FlowRestoreResult> {
  const { repoDir, oid, subject } = await resolveRestorePoint(
    args.workspaceId,
    args.sha,
  );
  const path = flowFilePath(args.slug);
  const blob = await readBlob(repoDir, oid, path).catch(() => null);
  if (!blob || blob.isBinary) {
    throw new RestoreRefusedError(
      "That commit has no version of this flow to restore",
    );
  }
  const parsed = parseFlowFileResult(blob.contents);
  if (!parsed.ok) {
    throw new RestoreRefusedError(
      "The flow file at that commit is not a valid definition",
    );
  }
  const current = await readBlob(repoDir, MAIN_REF, path).catch(() => null);
  const unchanged = current?.contents === blob.contents;
  if (!unchanged) {
    await commitConfigToMain(
      args.workspaceId,
      { writes: { [path]: blob.contents } },
      restoreMessage(oid, subject),
      await authorForUser(args.actorUserId),
    );
  }
  const sync = await syncFlowsFromRepo(args.workspaceId, args.actorUserId);
  return { unchanged, sync };
}

export interface ConnectorRestoreResult {
  unchanged: boolean;
  sync: ConnectorSyncResult;
}

/**
 * Put the whole `connectors/<slug>/` folder back to `sha` — files that did not
 * exist then are removed — as one commit on main, then re-index connectors.
 */
export async function restoreConnectorTo(args: {
  workspaceId: string;
  slug: string;
  sha: string;
  actorUserId?: string;
}): Promise<ConnectorRestoreResult> {
  const scope = connectorGitScope(args.workspaceId, args.slug);
  const { repoDir, oid, subject } = await resolveRestorePoint(
    args.workspaceId,
    args.sha,
  );
  const then = (await listTree(repoDir, oid)).filter(e => scope.owns(e.path));
  if (!then.some(e => e.path === `${scope.pathspec}connector.yaml`)) {
    throw new RestoreRefusedError(
      "That commit has no version of this connector to restore",
    );
  }
  const writes: Record<string, string> = {};
  for (const entry of then) {
    const blob = await readBlob(repoDir, oid, entry.path);
    if (blob.isBinary) {
      throw new RestoreRefusedError(
        `Cannot restore binary file ${entry.path} from the app; restore it with git`,
      );
    }
    writes[entry.path] = blob.contents;
  }
  const now = (await resolveCommit(repoDir, MAIN_REF))
    ? (await listTree(repoDir, MAIN_REF)).filter(e => scope.owns(e.path))
    : [];
  const deletes = now.map(e => e.path).filter(p => !(p in writes));
  const nowByPath = new Map(now.map(e => [e.path, e.oid]));
  const unchanged =
    deletes.length === 0 && then.every(e => nowByPath.get(e.path) === e.oid);
  if (!unchanged) {
    await commitConfigToMain(
      args.workspaceId,
      { writes, deletes },
      restoreMessage(oid, subject),
      await authorForUser(args.actorUserId),
    );
  }
  const sync = await syncConnectorsFromRepo(args.workspaceId, args.actorUserId);
  return { unchanged, sync };
}
