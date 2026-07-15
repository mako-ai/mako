/**
 * Apps v2 data bindings — bindings-as-files (apps-v2.md decision log).
 *
 * Unlike v1's Mongo `dataBindings` array, a v2 binding is REPO CONTENT,
 * versioned and branchable with the app:
 *
 *   mako.json      → `bindings: [{ name, connectionId, materialization? }]`
 *   bindings/<name>.sql → the query itself
 *
 * The agent authors bindings with the ordinary file tools (app2_write_file /
 * app2_edit_file) — no bespoke binding CRUD. Materialization reuses v1's
 * parquet pipeline (buildQueryParquetFile + artifact store) with artifacts
 * keyed `apps-v2/<projectId>/<name>.parquet`; the preview runtime serves
 * them at the app-relative path `__data/<name>.parquet`, which resolves
 * under the token prefix in BOTH static and dev previews, so app code just
 * fetches a relative URL and reads it with DuckDB-WASM (v1's useRows
 * pattern ports over with a one-line URL change).
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IAppProjectV2,
} from "../database/workspace-schema";
import {
  buildQueryParquetFile,
  storeParquetArtifactFile,
} from "../services/parquet-build.service";
import { readFile } from "./worktree.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface AppV2Binding {
  name: string;
  connectionId: string;
  /** Only "parquet" exists in v2 — live bindings are a later phase. */
  materialization: "parquet";
  sql: string;
}

export function bindingArtifactKey(projectId: string, name: string): string {
  return `apps-v2/${projectId}/${name}.parquet`;
}

/**
 * Read the project's bindings from git (mako.json + bindings/*.sql) at the
 * given actor's view of the tree. Throws with an actionable message on
 * malformed declarations; an app without mako.json bindings has none.
 */
export async function readBindings(
  project: IAppProjectV2,
  actorId: string,
): Promise<AppV2Binding[]> {
  let manifest: {
    bindings?: Array<{
      name?: string;
      connectionId?: string;
      materialization?: string;
    }>;
  };
  try {
    const raw = await readFile(project, "mako.json", actorId);
    manifest = JSON.parse(raw.contents) as typeof manifest;
  } catch {
    return [];
  }
  const declared = manifest.bindings ?? [];
  const out: AppV2Binding[] = [];
  for (const b of declared) {
    if (!b.name || !NAME_RE.test(b.name)) {
      throw new Error(`Invalid binding name: ${JSON.stringify(b.name)}`);
    }
    if (!b.connectionId) {
      throw new Error(`Binding "${b.name}" is missing connectionId`);
    }
    const sqlFile = await readFile(project, `bindings/${b.name}.sql`, actorId);
    out.push({
      name: b.name,
      connectionId: b.connectionId,
      materialization: "parquet",
      sql: sqlFile.contents,
    });
  }
  return out;
}

/**
 * Build the parquet artifact for one binding, synchronously. Reuses v1's
 * read-only-enforced parquet pipeline; the artifact overwrites in place, so
 * previews pick up fresh data on the next fetch.
 */
export async function materializeAppV2Binding(
  project: IAppProjectV2,
  name: string,
  actorId: string,
): Promise<{ rowCount: number; byteSize: number }> {
  const bindings = await readBindings(project, actorId);
  const binding = bindings.find(b => b.name === name);
  if (!binding) {
    throw new Error(
      `No binding named "${name}" — declare it in mako.json and put the SQL in bindings/${name}.sql`,
    );
  }
  const connection = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(binding.connectionId),
    workspaceId: project.workspaceId,
  });
  if (!connection) {
    throw new Error(`Connection ${binding.connectionId} not found`);
  }
  const projectId = project._id.toString();
  const built = await buildQueryParquetFile({
    connection,
    executableQuery: binding.sql,
    filenameBase: `appv2-${projectId}-${binding.name}`,
    schemaProbe: "strict",
  });
  await storeParquetArtifactFile({
    filePath: built.filePath,
    artifactKey: bindingArtifactKey(projectId, binding.name),
    metadata: { appV2ProjectId: projectId, binding: binding.name },
  });
  logger.info("Apps v2 binding materialized", {
    projectId,
    binding: binding.name,
    rowCount: built.rowCount,
  });
  return { rowCount: built.rowCount, byteSize: built.byteSize };
}
