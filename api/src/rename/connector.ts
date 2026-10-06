/**
 * Graceful rename of a workspace connector (kind `connector`).
 *
 * A workspace connector is `connectors/<slug>/` in the repo; the slug is
 * its identity, and every connection of that connector is typed
 * `ws:<slug>` (SourceConnection.type). Renaming the folder used to delete
 * the ConnectorDefinition row and strand every connection: its config
 * schema — which is also the list of fields that are encrypted — could no
 * longer be resolved. Now:
 *
 *   1. `connectors/<from>/` moves to `connectors/<to>/` with `aliases:
 *      [from]` added to connector.yaml, in ONE commit on main (the file is
 *      the record; a clone or laptop `git mv` that keeps it behaves the
 *      same, and reconcile.service detects a bare move by git -M);
 *   2. the index row is re-keyed in place (same _id, same status, alias
 *      recorded) — exactly what the push-time reconcile would do, done now
 *      so the rename is observable before the mirror push lands;
 *   3. `SourceConnection.type` moves from `ws:<from>` to `ws:<to>`
 *      (idempotent). Only `type` changes: credentials stay encrypted as
 *      they are, and `ws:<from>` resolves to the same definition — the
 *      same secret-field list — through the alias whether or not the
 *      migration has run. Flows reference connections by id and follow.
 *
 * PERMISSION. Workspace connectors are created and changed by pushing to
 * main, which any workspace member's git token can do (no role gate on
 * the git endpoint); the objects route and MCP auth already require
 * membership, and that is the rule mirrored here. A workspace API key
 * (no user) is treated like the other MCP write tools: allowed.
 *
 * The display name (`defineConnector({ name })`) lives in the connector's
 * code, not in a file Mako edits, so `title` is read-only here.
 */
import { Types } from "mongoose";
import {
  ConnectorDefinition,
  SourceConnection,
} from "../database/workspace-schema";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import { requireWorkspaceRepo } from "../apps/workspace-repo-required";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  listTree,
  readBlobsBatch,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import {
  isValidSlug,
  withConnectorAlias,
} from "../connectors/workspace/connector-file";
import {
  CONNECTORS_DIR,
  DEFAULT_ENTRY,
  findConnectorDefinitionRow,
} from "../connectors/workspace/resolver";
import {
  CONNECTOR_RENAME_SIMILARITY,
  migrateSourceConnectionType,
  syncConnectorsFromRepo,
} from "../connectors/workspace/reconcile.service";
import {
  WORKSPACE_TYPE_PREFIX,
  isWorkspaceConnectorType,
  slugFromType,
} from "../connectors/workspace/SandboxedConnector";
import { loggers } from "../logging";
import { findRenamedFolder } from "./git-renames";
import {
  RenameError,
  type RenameContext,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.connector();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** `ws:acme` or `acme` → `acme`. */
export function connectorSlugFromRef(ref: string): string {
  const clean = ref.trim();
  return isWorkspaceConnectorType(clean) ? slugFromType(clean) : clean;
}

function displayName(row: { slug: string; spec?: unknown }): string {
  const mako = (row.spec as { mako?: { name?: unknown } } | undefined)?.mako;
  return typeof mako?.name === "string" ? mako.name : row.slug;
}

export async function resolveConnector(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const slug = connectorSlugFromRef(ref);
  if (!isValidSlug(slug)) return null;
  const wsId = new Types.ObjectId(ctx.workspaceId);
  let found = await findConnectorDefinitionRow(ctx.workspaceId, slug);
  if (!found) {
    // A bare `git mv` not yet reconciled, or older than the index: git
    // still knows where the folder went.
    const repoDir = repoDirFor(ctx.workspaceId);
    if (!(await repoExists(repoDir))) return null;
    // Followed on the entry file (the code), like the reconcile pass: a
    // connector.yaml is too small and too alike to tell folders apart.
    const moved = await findRenamedFolder(
      repoDir,
      MAIN,
      CONNECTORS_DIR,
      slug,
      DEFAULT_ENTRY,
      { similarity: CONNECTOR_RENAME_SIMILARITY },
    );
    if (!moved) return null;
    const row = await ConnectorDefinition.findOne({
      workspaceId: wsId,
      slug: moved,
    });
    if (!row) return null;
    found = { row, via: "alias" };
  }
  return {
    kind: "connector",
    id: String(found.row._id),
    via: found.via,
    current: {
      title: displayName(found.row),
      slug: found.row.slug,
      path: `${CONNECTORS_DIR}/${found.row.slug}/`,
    },
  };
}

export interface RenameConnectorInput {
  from: string;
  to: string;
}

export async function renameWorkspaceConnector(
  ctx: RenameContext,
  input: RenameConnectorInput,
): Promise<RenameResult> {
  const from = connectorSlugFromRef(input.from);
  const to = connectorSlugFromRef(input.to);
  if (!isValidSlug(from) || !isValidSlug(to)) {
    throw new RenameError(
      "A connector slug is lowercase letters, digits and dashes (e.g. acme-crm)",
      400,
    );
  }
  if (from === to) throw new RenameError("The new slug is the old slug", 400);
  const wsId = new Types.ObjectId(ctx.workspaceId);

  // The row that is renamed is the one the LIVE slug names; renaming "an
  // alias" would be renaming a name that already moved.
  const row = await ConnectorDefinition.findOne({
    workspaceId: wsId,
    slug: from,
  });
  if (!row) {
    throw new RenameError(`No connector "${from}" in this workspace`, 404);
  }
  if (await ConnectorDefinition.exists({ workspaceId: wsId, slug: to })) {
    throw new RenameError(`A connector "${to}" already exists`, 409);
  }
  const claimant = await ConnectorDefinition.findOne({
    workspaceId: wsId,
    aliases: to,
    _id: { $ne: row._id },
  });
  if (claimant) {
    throw new RenameError(
      `"${to}" is a previous slug of the connector "${claimant.slug}"; connections typed ws:${to} would start running this one`,
      409,
    );
  }

  const repoDir = await requireWorkspaceRepo(ctx.workspaceId);
  await freshenBeforeMainWrite(ctx.workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) throw new RenameError("The workspace repo has no main yet", 412);
  const oldPrefix = `${CONNECTORS_DIR}/${from}/`;
  const newPrefix = `${CONNECTORS_DIR}/${to}/`;
  const tree = await listTree(repoDir, head);
  const oldPaths = tree.map(e => e.path).filter(p => p.startsWith(oldPrefix));
  if (!oldPaths.includes(`${oldPrefix}connector.yaml`)) {
    throw new RenameError(
      `connectors/${from}/connector.yaml is not on main (is the index stale? push and retry)`,
      404,
    );
  }
  if (tree.some(e => e.path.startsWith(newPrefix))) {
    throw new RenameError(`connectors/${to}/ already has files on main`, 409);
  }

  const blobs = await readBlobsBatch(repoDir, head, oldPaths);
  const yamlBuf = blobs.get(`${oldPrefix}connector.yaml`);
  const nextYaml =
    yamlBuf && !yamlBuf.includes(0)
      ? withConnectorAlias(yamlBuf.toString("utf8"), from)
      : null;
  if (nextYaml === null) {
    throw new RenameError(
      `connectors/${from}/connector.yaml does not parse; fix it before renaming so nothing is lost`,
      400,
    );
  }
  const writes: Record<string, string | Buffer> = {};
  for (const oldPath of oldPaths) {
    const buf = blobs.get(oldPath);
    if (!buf) continue;
    const newPath = `${newPrefix}${oldPath.slice(oldPrefix.length)}`;
    writes[newPath] = oldPath === `${oldPrefix}connector.yaml` ? nextYaml : buf;
  }
  const commit = await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes, deletes: oldPaths },
    {
      message: `Rename connector "${from}" -> "${to}"`,
      author: await authorForUser(ctx.userId),
    },
  );
  queueMirrorPush(ctx.workspaceId);

  // Re-key the index now (the push-time reconcile would find the same
  // rename through the alias and do nothing more), then move connections.
  const wasVerified = row.status === "verified";
  row.slug = to;
  row.aliases = [...new Set([...(row.aliases ?? []), from])].filter(
    a => a !== to,
  );
  row.sha = commit.commitOid;
  await row.save();
  const movedConnections = await migrateSourceConnectionType(
    ctx.workspaceId,
    from,
    to,
  );
  const remaining = await SourceConnection.countDocuments({
    workspaceId: wsId,
    type: `${WORKSPACE_TYPE_PREFIX}${from}`,
  });

  // connector.yaml changed, so the folder's content hash did: the next
  // index pass re-runs `spec` (in the sync box, not inline here — a rename
  // should not wait on a sandbox).
  void syncConnectorsFromRepo(ctx.workspaceId, ctx.userId).catch(error => {
    logger.warn("Connector re-index after rename failed", {
      workspaceId: ctx.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const warnings: string[] = [];
  if (movedConnections > 0) {
    warnings.push(
      `${movedConnections} connection${movedConnections === 1 ? "" : "s"} moved from ws:${from} to ws:${to}; flows reference connections by id and follow.`,
    );
  }
  if (remaining > 0) {
    warnings.push(
      `${remaining} connection${remaining === 1 ? "" : "s"} still typed ws:${from}; they keep working through the alias.`,
    );
  }
  if (wasVerified) {
    warnings.push(
      "The connector's spec is re-captured on the next index pass; its status is 'indexed' until the next successful connection test.",
    );
  }
  return {
    kind: "connector",
    id: String(row._id),
    before: {
      title: displayName(row),
      slug: from,
      path: oldPrefix,
    },
    after: {
      title: displayName(row),
      slug: to,
      path: newPrefix,
    },
    aliasesAdded: [from],
    commit: commit.commitOid,
    warnings,
  };
}
