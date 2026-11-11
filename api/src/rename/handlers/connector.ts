/**
 * Workspace connector rename handler (see ../types.ts for the contract).
 *
 * A workspace connector is `connectors/<slug>/` in the workspace repo; its
 * connections are typed `ws:<slug>` and bound to its definition by id
 * (connectors/workspace/resolver.ts). A rename:
 *
 *   1. moves the folder to `connectors/<new>/` and writes the old slug
 *      into connector.yaml `aliases`, in ONE compare-and-swap commit on
 *      main (the file is the record: a clone or a laptop `git mv` that
 *      keeps it behaves the same, and the index sync detects a bare move);
 *   2. sets `type` to `ws:<new>` on the connections bound to the
 *      definition (and binds the ones saved before bindings existed);
 *   3. re-keys the definition in place: same id, same status, the old
 *      slug kept as an alias, so `ws:<old>` keeps resolving for the
 *      catalog, links and new writes.
 *
 * In that order: a crash after the commit leaves every connection bound by
 * id to a definition the next index sync re-keys (it finds the alias in
 * the file), and they keep running it meanwhile.
 *
 * The display name (`defineConnector({ name })`) lives in the connector's
 * code, not in a file Mako edits, so `title` is read-only here. Who may
 * rename: a workspace editor (owner, admin or member), the rule of the
 * route that restores a connector's folder; a viewer is refused. On agent
 * surfaces `rename_object` also needs the `git-write` grant.
 */
import { connectorSlugError, looksLikeObjectId } from "@mako/schemas";
import { Types } from "mongoose";
import {
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOidAt,
  commitBlobsOnBranch,
  listTree,
  readBlobsBatch,
  resolveCommit,
  type IndexEntry,
  type IndexMode,
} from "../../apps/repository.service";
import { canOrganizeWorkspaceTree } from "../../apps/app-authorization";
import { authorForUser } from "../../apps/workspace-consoles.service";
import { requireWorkspaceRepo } from "../../apps/workspace-repo-required";
import { withConnectorAlias } from "../../connectors/workspace/connector-file";
import {
  migrateSourceConnectionType,
  rekeyDefinition,
  retypeBoundElsewhere,
  syncConnectorsFromRepo,
} from "../../connectors/workspace/reconcile.service";
import {
  CONNECTORS_DIR,
  LIVE_DEFINITION,
  findConnectorDefinitionRow,
} from "../../connectors/workspace/resolver";
import {
  WORKSPACE_TYPE_PREFIX,
  isWorkspaceConnectorType,
  slugFromType,
} from "../../connectors/workspace/SandboxedConnector";
import {
  ConnectorDefinition,
  SourceConnection,
  type IConnectorDefinition,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type RenameResult,
  type ResolvedRef,
} from "../types";

const logger = loggers.connector();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

export const CONNECTOR_RENAME_REFUSAL =
  "Only workspace editors (owner, admin or member) can rename a connector.";

/** `ws:acme` or `acme` → `acme`. */
function slugOfRef(ref: string): string {
  const clean = ref.trim();
  return isWorkspaceConnectorType(clean) ? slugFromType(clean) : clean;
}

function locationOf(
  row: IConnectorDefinition,
  slug = row.slug,
): RenameLocation {
  const name = (row.spec as { mako?: { name?: unknown } } | undefined)?.mako
    ?.name;
  return {
    title: typeof name === "string" ? name : row.slug,
    slug,
    path: `${CONNECTORS_DIR}/${slug}/`,
  };
}

/**
 * The live definition `ref` means: its id, its current slug (`ws:` or
 * bare), or an old slug only it answers to.
 */
async function findConnector(
  ctx: RenameContext,
  ref: string,
): Promise<{ row: IConnectorDefinition; via: "current" | "alias" } | null> {
  if (!Types.ObjectId.isValid(ctx.workspaceId)) return null;
  if (looksLikeObjectId(ref)) {
    const row = await ConnectorDefinition.findOne({
      workspaceId: ctx.workspaceId,
      _id: new Types.ObjectId(ref),
      ...LIVE_DEFINITION,
    });
    if (row) return { row, via: "current" };
  }
  return findConnectorDefinitionRow(ctx.workspaceId, slugOfRef(ref));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function renameConnector(
  ctx: RenameContext,
  ref: string,
  rawSlug: string,
): Promise<RenameResult> {
  // The rule of the one Mako route that writes connectors/<slug>/ (restore,
  // routes/connector-definitions.ts): a workspace editor, on every surface.
  // An API key acts with the role of the person who created it.
  if (!ctx.userId || !canOrganizeWorkspaceTree(ctx.role)) {
    throw new RenameError(CONNECTOR_RENAME_REFUSAL, 403);
  }
  const to = slugOfRef(rawSlug);
  const problem = connectorSlugError(to);
  if (problem) throw new RenameError(problem);
  const found = await findConnector(ctx, ref);
  if (!found) {
    throw new RenameError(`No connector "${ref}" in this workspace`, 404);
  }
  const { row } = found;
  const from = row.slug;
  const before = locationOf(row);
  if (from === to) {
    return {
      kind: "connector",
      id: String(row._id),
      before,
      after: before,
      aliasesAdded: [],
      warnings: ["Nothing to change: it already has that name."],
    };
  }
  const workspaceId = new Types.ObjectId(ctx.workspaceId);
  const holders = await ConnectorDefinition.find({
    workspaceId,
    _id: { $ne: row._id },
    $or: [{ slug: to }, { aliases: to }],
  });
  const holder = holders.find(other => !other.removedAt);
  if (holder) {
    throw new RenameError(
      holder.slug === to
        ? `A connector "${to}" already exists`
        : `"${to}" is a previous slug of the connector "${holder.slug}", and still names it`,
      409,
    );
  }
  // Connections typed ws:<to> bound to another live connector are that
  // connector's: their type is corrected first. What is left typed
  // ws:<to>, or bound to a removed connector that had this slug, was saved
  // for something else; taking the name would leave it closed for good, or
  // point at this connector by name. Refused until those are gone.
  await retypeBoundElsewhere(ctx.workspaceId, to, String(row._id));
  const tombstone = holders.find(other => other.slug === to) ?? null;
  const others = await SourceConnection.countDocuments({
    workspaceId,
    connectorDefinitionId: { $ne: row._id },
    $or: [
      { type: `${WORKSPACE_TYPE_PREFIX}${to}` },
      ...(tombstone ? [{ connectorDefinitionId: tombstone._id }] : []),
    ],
  });
  if (others > 0) {
    throw new RenameError(
      `${plural(others, "connection still belongs", "connections still belong")} to a removed connector called "${to}"; delete or re-point them first`,
      409,
    );
  }

  const repoDir = await requireWorkspaceRepo(ctx.workspaceId);
  await freshenBeforeMainWrite(ctx.workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) throw new RenameError("The workspace repo has no main yet", 412);
  const oldPrefix = `${CONNECTORS_DIR}/${from}/`;
  const newPrefix = `${CONNECTORS_DIR}/${to}/`;
  const yamlPath = `${oldPrefix}connector.yaml`;
  const tree = await listTree(repoDir, head);
  const moved = tree.filter(entry => entry.path.startsWith(oldPrefix));
  if (!moved.some(entry => entry.path === yamlPath)) {
    throw new RenameError(
      `${yamlPath} is not on main (is the index stale? push and retry)`,
      404,
    );
  }
  if (tree.some(entry => entry.path.startsWith(newPrefix))) {
    throw new RenameError(`${newPrefix} already has files on main`, 409);
  }
  const yamlBytes = (await readBlobsBatch(repoDir, head, [yamlPath])).get(
    yamlPath,
  );
  let yamlText: string | null = null;
  try {
    yamlText = yamlBytes
      ? new TextDecoder("utf-8", { fatal: true }).decode(yamlBytes)
      : null;
  } catch {
    // Not UTF-8: editing it would change bytes the author wrote.
  }
  const nextYaml =
    yamlText === null ? null : withConnectorAlias(yamlText, from);
  if (nextYaml === null) {
    throw new RenameError(
      `${yamlPath} could not be edited in place, so nothing was changed. Rename with git instead: move the folder and add \`aliases: [${from}]\` to connector.yaml.`,
      409,
    );
  }
  // Every other file moves by oid with its mode (an executable stays
  // executable, a symlink a symlink); only connector.yaml is rewritten.
  const writes: Record<string, string> = {};
  const modes: Record<string, IndexMode> = {};
  const entries: IndexEntry[] = [];
  for (const entry of moved) {
    const path = `${newPrefix}${entry.path.slice(oldPrefix.length)}`;
    if (entry.path === yamlPath) {
      writes[path] = nextYaml;
      modes[path] = entry.mode as IndexMode;
    } else {
      entries.push({ path, oid: entry.oid, mode: entry.mode as IndexMode });
    }
  }
  let commit: Awaited<ReturnType<typeof commitBlobsOnBranch>>;
  try {
    commit = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes, modes, entries, deletes: moved.map(entry => entry.path) },
      {
        message: `Rename connector "${from}" -> "${to}"`,
        author: await authorForUser(ctx.userId),
        // The old folder exactly as it was listed, and the new one absent:
        // an edit, an added file or a delete in the window refuses the
        // rename, so nothing is dropped or left behind.
        expectBlobs: {
          [`${CONNECTORS_DIR}/${from}`]: await blobOidAt(
            repoDir,
            head,
            `${CONNECTORS_DIR}/${from}`,
          ),
          [`${CONNECTORS_DIR}/${to}`]: null,
        },
      },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new RenameError(
        `${error.path} changed on main while renaming; retry.`,
        409,
      );
    }
    throw error;
  }
  queueMirrorPush(ctx.workspaceId);

  // Connections FIRST, the definition LAST (see the header).
  const movedConnections = await migrateSourceConnectionType(
    ctx.workspaceId,
    from,
    to,
    { definitionId: String(row._id), includeUnbound: true },
  );
  if (tombstone) await ConnectorDefinition.deleteOne({ _id: tombstone._id });
  // `sourceSha` stays: the content hash ignores `aliases`, so a verified
  // connector stays verified. A rename is not new code.
  rekeyDefinition(row, to, commit.commitOid);
  await row.save().catch(error => {
    // An index sync saved this definition meanwhile: the pass below reads
    // the alias in the file and finishes the re-key.
    if ((error as Error | null)?.name !== "VersionError") throw error;
  });

  // Let the index see the new tree now, awaited: the definition is already
  // re-keyed and the hash ignores aliases, so the pass runs no spec.
  await syncConnectorsFromRepo(ctx.workspaceId, ctx.userId).catch(error =>
    logger.warn("Connector re-index after rename failed", {
      workspaceId: ctx.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return {
    kind: "connector",
    id: String(row._id),
    before,
    after: locationOf(row, to),
    aliasesAdded: [from],
    commit: commit.commitOid,
    warnings:
      movedConnections > 0
        ? [
            `${plural(movedConnections, "connection", "connections")} moved from ws:${from} to ws:${to}; flows reference connections by id and follow.`,
          ]
        : [],
  };
}

export const connectorRenameHandler: RenameHandler = {
  kind: "connector",
  describe:
    "`ref` = the workspace connector's slug (or `ws:<slug>`, an old slug, or its id); `slug` = the new folder slug (lowercase letters, digits and dashes, starting with a letter). Moves connectors/<old>/ to connectors/<new>/ and records the old slug in connector.yaml `aliases` (one commit on main); the connector keeps its id and its connections, which are bound to it by id and move from ws:<old> to ws:<new>. `ws:<old>` keeps naming it. `title` is read-only (the display name is `defineConnector({ name })` in the connector's code).",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const found = await findConnector(ctx, ref);
    return found
      ? {
          kind: "connector",
          id: String(found.row._id),
          via: found.via,
          current: locationOf(found.row),
        }
      : null;
  },

  async rename(ctx, request) {
    if (!request.slug) {
      throw new RenameError(
        request.title
          ? "A connector's display name is declared in its code (defineConnector({ name })); give `slug` to rename the folder."
          : "Give the new connector slug as slug.",
      );
    }
    return renameConnector(ctx, request.ref, request.slug);
  },
};
