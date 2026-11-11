/**
 * Resolving a workspace connector: repo -> files, Mongo -> definition.
 *
 * The repo is the truth and the `ConnectorDefinition` row is a derived index,
 * the same arrangement skills and flows use. Nothing here writes to the repo.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConnectorDefinition,
  type IConnectorDefinition,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  readBlobsBatch,
  repoDirFor,
  repoExists,
  resolveCommit,
  listTree,
} from "../../apps/repository.service";
import type { SandboxExecContext } from "../../apps/sandbox/provider";
import { ensureCommitLocally } from "../../apps/cloud-repo.service";
import {
  CONNECTOR_NODE_VERSION,
  hasConnectorRuntime,
  installConnectorRuntime,
} from "./sync-box";
import { loggers } from "../../logging";

const logger = loggers.connector();

/** Where connectors live in a workspace repo. */
export const CONNECTORS_DIR = "connectors";

/** The entry file a connector.yaml without an `entry:` means. */
export const DEFAULT_ENTRY = "connector.ts";

/**
 * How much of a connector folder Mako will load into the API process.
 *
 * Enforced from `git ls-tree`'s sizes, BEFORE any blob is read: the cap only
 * protects the heap if it is applied while the bytes are still on disk.
 * Summing as they arrive — which is what this used to do — has already
 * materialized the whole folder by the time it throws.
 */
const MAX_FOLDER_BYTES = 2 * 1024 * 1024;

export interface LoadedConnector {
  /** The definition's id: what a connection is bound to. */
  id: string;
  slug: string;
  /** Previous slugs; `ws:<alias>` resolves here while nothing live holds it. */
  aliases: string[];
  runtime: string;
  /** The file `connector.yaml` names, defaulted for rows written before it was indexed. */
  entry: string;
  sha: string;
  sourceSha: string;
  spec?: Record<string, unknown>;
  entities: string[];
  status: IConnectorDefinition["status"];
}

/** SandboxedConnector's WORKSPACE_TYPE_PREFIX; that module imports this one. */
const WORKSPACE_PREFIX = "ws:";

/**
 * A definition whose folder is on main. A row with `removedAt` is a
 * tombstone: kept so the same folder coming back is the same definition,
 * and resolved by nothing until then.
 */
export const LIVE_DEFINITION = { removedAt: null } as const;

/**
 * The definition a NAME means, for the catalog, links and new writes: the
 * live definition at that slug, else the ONE live definition that lists it
 * as an alias. A live name always wins over an alias, and an alias two
 * definitions list resolves to neither. Never use this for an existing
 * connection: that is {@link resolveConnectionBinding}.
 */
export async function findConnectorDefinitionRow(
  workspaceId: string,
  slug: string,
): Promise<{ row: IConnectorDefinition; via: "current" | "alias" } | null> {
  const current = await ConnectorDefinition.findOne({
    workspaceId,
    slug,
    ...LIVE_DEFINITION,
  });
  if (current) return { row: current, via: "current" };
  const claimants = await ConnectorDefinition.find({
    workspaceId,
    aliases: slug,
    ...LIVE_DEFINITION,
  }).limit(2);
  return claimants.length === 1 ? { row: claimants[0], via: "alias" } : null;
}

/** What a source connection carries that names its connector. */
export interface ConnectionBinding {
  type: string;
  /** `ISourceConnection.connectorDefinitionId`. */
  connectorDefinitionId?: unknown;
}

/**
 * Why a connection's binding resolves to nothing:
 *  - `definition-gone`: bound to a definition that no longer exists, whose
 *    folder is off main, or to none on purpose (the placeholder below);
 *  - `name-moved`: bound to a live definition while `type` names another;
 *  - `not-found`: not bound yet, and no live definition has its slug.
 */
export type ConnectionBindingProblem =
  "definition-gone" | "name-moved" | "not-found";

/** A connection whose connector cannot be resolved: what is wrong, and the fix. */
export class ConnectorBindingError extends Error {
  constructor(
    public readonly problem: ConnectionBindingProblem,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorBindingError";
  }
}

/**
 * The binding of a connection that is bound to NO definition on purpose:
 * one saved before bindings existed, typed by a slug that a different
 * definition has since taken. It was saved for whatever held that name
 * then, so it waits for a person to re-save it. No ObjectId Mongo mints is
 * all zeros.
 */
export const UNBOUND_CONNECTOR_DEFINITION_ID = "000000000000000000000000";

export type ConnectionBindingResolution =
  | { ok: true; row: IConnectorDefinition; via: "binding" | "current" }
  | { ok: false; problem: ConnectionBindingProblem; message: string };

function slugOfType(type: string): string {
  return type.startsWith(WORKSPACE_PREFIX)
    ? type.slice(WORKSPACE_PREFIX.length)
    : type;
}

/** How a person re-binds a connection, for every refusal below. */
function rebindHint(slug: string): string {
  return (
    `If ${CONNECTORS_DIR}/${slug}/ on main is the connector this connection is for, re-bind it on purpose: ` +
    `open the connection in Mako, keep "${slug}" selected and save ` +
    `(PUT the connection with {"type": "${WORKSPACE_PREFIX}${slug}"}). Otherwise delete the connection.`
  );
}

/**
 * The definition a CONNECTION resolves to: the only resolution a path that
 * reads its secret-field schema, decrypts it or runs it may use.
 *
 * Bound (`connectorDefinitionId`): that definition by id, live, and nothing
 * else. Not bound yet (saved before bindings existed): the live definition
 * whose CURRENT slug `type` names, never one that only lists it as an
 * alias. Anything else is refused with a message a person can act on.
 */
export async function resolveConnectionBinding(
  workspaceId: string,
  binding: ConnectionBinding,
): Promise<ConnectionBindingResolution> {
  const slug = slugOfType(binding.type);
  const id =
    binding.connectorDefinitionId == null
      ? null
      : String(binding.connectorDefinitionId);
  if (id === null) {
    const row = await ConnectorDefinition.findOne({
      workspaceId,
      slug,
      ...LIVE_DEFINITION,
    });
    if (row) return { ok: true, row, via: "current" };
    return {
      ok: false,
      problem: "not-found",
      message:
        `No connector "${slug}" in this workspace, and this connection is not bound to a connector by id. ` +
        `Push a folder at ${CONNECTORS_DIR}/${slug}/ to main. ${rebindHint(slug)}`,
    };
  }
  if (id === UNBOUND_CONNECTOR_DEFINITION_ID) {
    return {
      ok: false,
      problem: "definition-gone",
      message:
        `This connection was saved before connections were bound to their connector by id, and a different connector has since taken the name "${slug}", ` +
        `so the connection is not given to it automatically. ${rebindHint(slug)}`,
    };
  }
  const row = /^[0-9a-f]{24}$/i.test(id)
    ? await ConnectorDefinition.findOne({ workspaceId, _id: id })
    : null;
  if (!row || row.removedAt) {
    logger.warn("A source connection is bound to a connector that is gone", {
      workspaceId,
      type: binding.type,
      connectorDefinitionId: id,
    });
    return {
      ok: false,
      problem: "definition-gone",
      message: row
        ? `This connection was saved under the connector "${row.slug}", whose folder is no longer on main. ` +
          `Restoring ${CONNECTORS_DIR}/${row.slug}/ brings the connector back as it was and this connection works again; ` +
          `it stays closed if another connector takes that name first. ${rebindHint(slug)}`
        : `This connection was saved under a connector that no longer exists (definition ${id}); ` +
          `a connection is only ever used by the connector it was saved under. ${rebindHint(slug)}`,
    };
  }
  const named = await ConnectorDefinition.findOne({
    workspaceId,
    slug,
    ...LIVE_DEFINITION,
  });
  if (named && String(named._id) !== id) {
    logger.warn(
      "A source connection's type names another connector than the one it is bound to",
      { workspaceId, type: binding.type, connectorDefinitionId: id },
    );
    return {
      ok: false,
      problem: "name-moved",
      message:
        `This connection is bound to the connector "${row.slug}", but its type "${binding.type}" now names a different connector, ` +
        `and a connection is only ever used by the connector it was saved under. ` +
        `To keep it on its own connector, PUT the connection with {"type": "${WORKSPACE_PREFIX}${row.slug}"}. ` +
        `To use the connector now at ${CONNECTORS_DIR}/${slug}/, create a connection for it and enter the key there.`,
    };
  }
  return { ok: true, row, via: "binding" };
}

function loaded(row: IConnectorDefinition): LoadedConnector {
  if (row.status === "blocked") {
    throw new Error(
      `The connector "${row.slug}" is blocked: ${row.blockedReason ?? "it failed its last check"}`,
    );
  }
  return summary(row);
}

function summary(row: IConnectorDefinition): LoadedConnector {
  return {
    id: String(row._id),
    slug: row.slug,
    aliases: row.aliases ?? [],
    runtime: row.runtime,
    entry: row.entry || DEFAULT_ENTRY,
    sha: row.sha,
    sourceSha: row.sourceSha,
    spec: row.spec as Record<string, unknown> | undefined,
    entities: row.entities ?? [],
    status: row.status,
  };
}

/**
 * The definition a connection is bound to, or a {@link ConnectorBindingError}
 * saying why there is none and how to fix it.
 */
export async function loadConnectorDefinitionFor(
  workspaceId: string,
  binding: ConnectionBinding,
): Promise<LoadedConnector> {
  const resolved = await resolveConnectionBinding(workspaceId, binding);
  if (!resolved.ok) {
    throw new ConnectorBindingError(resolved.problem, resolved.message);
  }
  return loaded(resolved.row);
}

/**
 * The indexed definition a NAME means (current slug, else its one alias
 * claimant), or a refusal that says why. For the catalog and for new
 * writes; an existing connection uses {@link loadConnectorDefinitionFor}.
 *
 * A blocked connector throws rather than returning null: "this connector is
 * blocked because its spec failed to parse" is actionable, and "connector not
 * found" for a folder that plainly exists is not.
 */
export async function loadConnectorDefinition(
  workspaceId: string,
  slug: string,
): Promise<LoadedConnector> {
  const found = await findConnectorDefinitionRow(workspaceId, slug);
  if (!found) {
    throw new Error(
      `No connector "${slug}" in this workspace. Push a folder at ${CONNECTORS_DIR}/${slug}/ to main.`,
    );
  }
  return loaded(found.row);
}

/** Every indexed connector in a workspace, for the picker. */
export async function listConnectorDefinitions(
  workspaceId: string,
): Promise<LoadedConnector[]> {
  const rows = await ConnectorDefinition.find({
    workspaceId,
    ...LIVE_DEFINITION,
  }).sort({ slug: 1 });
  return rows.map(summary);
}

/**
 * Read one connector folder out of the bare repo at a commit.
 *
 * Reads a commit, never a branch name: a sync that began before a push must
 * keep running the code it began with, and re-reading `main` mid-run is how a
 * chunk would resume against a different connector than it started on.
 */
export async function readConnectorFolder(
  workspaceId: string,
  slug: string,
  commit: string,
): Promise<Map<string, Uint8Array>> {
  // Another replica may index a commit before this replica has fetched it.
  await ensureCommitLocally(workspaceId, commit);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) {
    throw new Error(`Workspace ${workspaceId} has no repository`);
  }
  const prefix = `${CONNECTORS_DIR}/${slug}/`;
  const entries = await listTree(repoDir, commit);
  const wanted = entries.filter(entry => entry.path.startsWith(prefix));

  if (wanted.length === 0) {
    throw new Error(`No files under ${prefix} at ${commit.slice(0, 8)}`);
  }

  const total = folderBytes(wanted);
  if (total > MAX_FOLDER_BYTES) {
    throw new Error(oversizedMessage(prefix, total));
  }

  const blobs = await readBlobsBatch(
    repoDir,
    commit,
    wanted.map(entry => entry.path),
  );
  const files = new Map<string, Uint8Array>();
  for (const [entryPath, buffer] of blobs) {
    files.set(entryPath.slice(prefix.length), new Uint8Array(buffer));
  }
  return files;
}

/** Bytes a set of tree entries would occupy, from git's own sizes. */
function folderBytes(entries: Array<{ size: number }>): number {
  return entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
}

function oversizedMessage(prefix: string, bytes: number): string {
  return (
    `The connector folder ${prefix} is ${bytes} bytes, over the ${MAX_FOLDER_BYTES} byte limit. ` +
    `A connector is code, not data; keep fixtures small.`
  );
}

/** List the connector slugs present on main, with the commit they were read at. */
export async function listConnectorFoldersAtMain(workspaceId: string): Promise<{
  commit: string | null;
  slugs: string[];
  filesBySlug: Map<string, Map<string, Uint8Array>>;
  /** Slugs left unread because they exceed the cap, with the refusal to show. */
  oversized: Map<string, string>;
}> {
  const empty = {
    commit: null,
    slugs: [],
    filesBySlug: new Map<string, Map<string, Uint8Array>>(),
    oversized: new Map<string, string>(),
  };
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return empty;

  const commit = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!commit) return empty;

  const entries = await listTree(repoDir, commit);
  const bySlug = new Map<string, Array<{ path: string; size: number }>>();
  for (const entry of entries) {
    if (!entry.path.startsWith(`${CONNECTORS_DIR}/`)) continue;
    const [, slug, ...rest] = entry.path.split("/");
    // `connectors/README.md` is documentation, not a connector; a folder needs
    // at least one file inside it to be one.
    if (!slug || rest.length === 0) continue;
    const list = bySlug.get(slug) ?? [];
    list.push({ path: entry.path, size: entry.size });
    bySlug.set(slug, list);
  }

  // This runs on EVERY push, for every folder under connectors/. One large
  // file committed there — a fixture dump, a stray node_modules — would
  // otherwise be read into the API process's heap each time. Oversized slugs
  // are reported rather than read, so the push still lands and the author
  // gets told which folder is too big.
  const oversized = new Map<string, string>();
  const readable: string[] = [];
  for (const [slug, files] of bySlug) {
    const bytes = folderBytes(files);
    if (bytes > MAX_FOLDER_BYTES) {
      oversized.set(
        slug,
        oversizedMessage(`${CONNECTORS_DIR}/${slug}/`, bytes),
      );
      continue;
    }
    readable.push(...files.map(file => file.path));
  }

  const blobs = await readBlobsBatch(repoDir, commit, readable);
  const filesBySlug = new Map<string, Map<string, Uint8Array>>();
  for (const [slug, entriesForSlug] of bySlug) {
    if (oversized.has(slug)) continue;
    const files = new Map<string, Uint8Array>();
    for (const { path: entryPath } of entriesForSlug) {
      const buffer = blobs.get(entryPath);
      if (!buffer) continue;
      files.set(
        entryPath.slice(`${CONNECTORS_DIR}/${slug}/`.length),
        new Uint8Array(buffer),
      );
    }
    filesBySlug.set(slug, files);
  }

  return {
    commit,
    slugs: [...bySlug.keys()].sort(),
    filesBySlug,
    oversized,
  };
}

/**
 * Make sure the box has the SDK.
 *
 * In a built E2B template this is a no-op after the first check. Uploading
 * from the API's own copy is what makes the path work in development and
 * under the local provider, where there is no template at all.
 */
export async function ensureConnectorRuntime(
  ctx: SandboxExecContext,
): Promise<string> {
  const files = await readSdkFiles();
  const runtimeId = sdkRuntimeId(files);
  if (await hasConnectorRuntime(ctx, runtimeId)) return runtimeId;
  await installConnectorRuntime(ctx, runtimeId, files);
  logger.info("Installed the connector SDK into a sync box", {
    files: files.size,
    runtimeId,
  });
  return runtimeId;
}

let sdkFilesCache: Map<string, Uint8Array> | null = null;
let sdkRuntimeIdCache: string | null = null;

/** Identity of every shipped SDK byte, used as the sandbox runtime directory. */
function sdkRuntimeId(files: Map<string, Uint8Array>): string {
  if (sdkRuntimeIdCache) return sdkRuntimeIdCache;
  const hash = createHash("sha256");
  // The executable is part of the runtime contract just as much as the SDK
  // bytes. Bumping it must create a fresh root instead of reusing a marker
  // written for an older Node installation.
  hash.update(`node:${CONNECTOR_NODE_VERSION}\0`);
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name) as Uint8Array);
    hash.update("\0");
  }
  sdkRuntimeIdCache = hash.digest("hex");
  return sdkRuntimeIdCache;
}

/** The SDK's shipped files, read from this repository's own package. */
async function readSdkFiles(): Promise<Map<string, Uint8Array>> {
  if (sdkFilesCache) return sdkFilesCache;
  const root = await findSdkRoot();
  const files = new Map<string, Uint8Array>();

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.endsWith(".test.mjs")) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "fixtures") continue;
        await walk(absolute, relative);
      } else {
        files.set(relative, new Uint8Array(await fs.readFile(absolute)));
      }
    }
  };

  await walk(path.join(root, "src"), "src");
  await walk(path.join(root, "bin"), "bin");
  for (const name of ["index.js", "index.d.ts", "package.json"]) {
    files.set(name, new Uint8Array(await fs.readFile(path.join(root, name))));
  }
  sdkFilesCache = files;
  return files;
}

/**
 * Where the SDK's files are in THIS deployment.
 *
 * The built image has no `packages/` at all — it ships `api/dist` and nothing
 * else of the monorepo — so the source-tree paths below only ever hit in
 * development. `pnpm api:build` copies the package to `dist/connector-sdk`
 * for exactly that reason, the same trick `apps/app-sdk-package.ts` uses, and
 * that copy is the candidate production resolves.
 */
async function findSdkRoot(): Promise<string> {
  const candidates = [
    // Built tree: api/dist/connectors/workspace -> api/dist/connector-sdk
    path.resolve(__dirname, "../../connector-sdk"),
    // Source tree: api/src/connectors/workspace -> packages/connector-sdk
    path.resolve(__dirname, "../../../../packages/connector-sdk"),
    path.resolve(process.cwd(), "dist/connector-sdk"),
    path.resolve(process.cwd(), "api/dist/connector-sdk"),
    path.resolve(process.cwd(), "../packages/connector-sdk"),
    path.resolve(process.cwd(), "packages/connector-sdk"),
    path.resolve(process.cwd(), "node_modules/@makoai/connector-sdk"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Cannot find @makoai/connector-sdk. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}
