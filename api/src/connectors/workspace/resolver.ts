/**
 * Resolving a workspace connector: repo -> files, Mongo -> definition.
 *
 * The repo is the truth and the `ConnectorDefinition` row is a derived index,
 * the same arrangement skills and flows use. Nothing here writes to the repo.
 */
import fs from "node:fs/promises";
import path from "node:path";
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
import { hasConnectorRuntime, installConnectorRuntime } from "./sync-box";
import { loggers } from "../../logging";

const logger = loggers.connector();

/** Where connectors live in a workspace repo. */
export const CONNECTORS_DIR = "connectors";

/** The files Mako will copy into the box. Anything else in the folder is ignored. */
const MAX_FOLDER_BYTES = 2 * 1024 * 1024;

export interface LoadedConnector {
  slug: string;
  runtime: string;
  sha: string;
  sourceSha: string;
  spec?: Record<string, unknown>;
  entities: string[];
  status: IConnectorDefinition["status"];
}

/**
 * The indexed definition for one slug, or a refusal that says why.
 *
 * A blocked connector throws rather than returning null: "this connector is
 * blocked because its spec failed to parse" is actionable, and "connector not
 * found" for a folder that plainly exists is not.
 */
export async function loadConnectorDefinition(
  workspaceId: string,
  slug: string,
): Promise<LoadedConnector> {
  const row = await ConnectorDefinition.findOne({ workspaceId, slug }).lean();
  if (!row) {
    throw new Error(
      `No connector "${slug}" in this workspace. Push a folder at ${CONNECTORS_DIR}/${slug}/ to main.`,
    );
  }
  if (row.status === "blocked") {
    throw new Error(
      `The connector "${slug}" is blocked: ${row.blockedReason ?? "it failed its last check"}`,
    );
  }
  return {
    slug: row.slug,
    runtime: row.runtime,
    sha: row.sha,
    sourceSha: row.sourceSha,
    spec: row.spec as Record<string, unknown> | undefined,
    entities: row.entities ?? [],
    status: row.status,
  };
}

/** Every indexed connector in a workspace, for the picker. */
export async function listConnectorDefinitions(
  workspaceId: string,
): Promise<LoadedConnector[]> {
  const rows = await ConnectorDefinition.find({ workspaceId })
    .sort({ slug: 1 })
    .lean();
  return rows.map(row => ({
    slug: row.slug,
    runtime: row.runtime,
    sha: row.sha,
    sourceSha: row.sourceSha,
    spec: row.spec as Record<string, unknown> | undefined,
    entities: row.entities ?? [],
    status: row.status,
  }));
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
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) {
    throw new Error(`Workspace ${workspaceId} has no repository`);
  }
  const prefix = `${CONNECTORS_DIR}/${slug}/`;
  const entries = await listTree(repoDir, commit);
  const paths = entries
    .map(entry => entry.path)
    .filter(entryPath => entryPath.startsWith(prefix));

  if (paths.length === 0) {
    throw new Error(`No files under ${prefix} at ${commit.slice(0, 8)}`);
  }

  const blobs = await readBlobsBatch(repoDir, commit, paths);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [entryPath, buffer] of blobs) {
    total += buffer.byteLength;
    if (total > MAX_FOLDER_BYTES) {
      throw new Error(
        `The connector folder ${prefix} is larger than ${MAX_FOLDER_BYTES} bytes. ` +
          `A connector is code, not data; keep fixtures small.`,
      );
    }
    files.set(entryPath.slice(prefix.length), new Uint8Array(buffer));
  }
  return files;
}

/** List the connector slugs present on main, with the commit they were read at. */
export async function listConnectorFoldersAtMain(workspaceId: string): Promise<{
  commit: string | null;
  slugs: string[];
  filesBySlug: Map<string, Map<string, Uint8Array>>;
}> {
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) {
    return { commit: null, slugs: [], filesBySlug: new Map() };
  }

  const commit = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!commit) return { commit: null, slugs: [], filesBySlug: new Map() };

  const entries = await listTree(repoDir, commit);
  const wanted = entries
    .map(entry => entry.path)
    .filter(entryPath => entryPath.startsWith(`${CONNECTORS_DIR}/`));

  const bySlug = new Map<string, string[]>();
  for (const entryPath of wanted) {
    const [, slug, ...rest] = entryPath.split("/");
    // `connectors/README.md` is documentation, not a connector; a folder needs
    // at least one file inside it to be one.
    if (!slug || rest.length === 0) continue;
    const list = bySlug.get(slug) ?? [];
    list.push(entryPath);
    bySlug.set(slug, list);
  }

  const blobs = await readBlobsBatch(repoDir, commit, wanted);
  const filesBySlug = new Map<string, Map<string, Uint8Array>>();
  for (const [slug, paths] of bySlug) {
    const files = new Map<string, Uint8Array>();
    for (const entryPath of paths) {
      const buffer = blobs.get(entryPath);
      if (!buffer) continue;
      files.set(
        entryPath.slice(`${CONNECTORS_DIR}/${slug}/`.length),
        new Uint8Array(buffer),
      );
    }
    filesBySlug.set(slug, files);
  }

  return { commit, slugs: [...bySlug.keys()].sort(), filesBySlug };
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
): Promise<void> {
  if (await hasConnectorRuntime(ctx)) return;
  const files = await readSdkFiles();
  await installConnectorRuntime(ctx, files);
  logger.info("Installed the connector SDK into a sync box", {
    files: files.size,
  });
}

let sdkFilesCache: Map<string, Uint8Array> | null = null;

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

async function findSdkRoot(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "../../../../packages/connector-sdk"),
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
