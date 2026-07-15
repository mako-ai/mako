/**
 * Apps v2 data bindings — bindings-as-files (apps-v2.md decision log).
 *
 * Unlike v1's Mongo `dataBindings` array, a v2 binding is REPO CONTENT,
 * versioned and branchable with the app:
 *
 *   bindings/<name>.sql → front matter (-- connection:, -- schedule:, ...)
 *                         + the query; name = filename, discovery = glob
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
import mongoose, { Schema, Types } from "mongoose";
import {
  DatabaseConnection,
  type IAppProjectV2,
} from "../database/workspace-schema";

/**
 * Derived runtime state per binding (NOT source of truth — that is the repo).
 * Only what the scheduler needs: when the artifact was last built.
 */
export interface AppV2BindingRun {
  at: Date;
  status: "ready" | "error";
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
}

export interface AppV2BindingStateDoc {
  lastMaterializedAt?: Date;
  lastRowCount?: number;
  history?: AppV2BindingRun[];
}

const AppV2BindingState =
  mongoose.models.AppV2BindingState ??
  mongoose.model(
    "AppV2BindingState",
    new Schema(
      {
        projectId: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        lastMaterializedAt: { type: Date },
        lastRowCount: { type: Number },
        history: {
          type: [
            new Schema(
              {
                at: { type: Date, required: true },
                status: { type: String, enum: ["ready", "error"] },
                rowCount: { type: Number },
                durationMs: { type: Number },
                error: { type: String },
              },
              { _id: false },
            ),
          ],
          default: undefined,
        },
      },
      { collection: "app_v2_binding_state", timestamps: true },
    ).index({ projectId: 1, name: 1 }, { unique: true }),
  );

export async function getBindingState(
  projectId: string,
  name: string,
): Promise<AppV2BindingStateDoc | null> {
  return AppV2BindingState.findOne({
    projectId: new Types.ObjectId(projectId),
    name,
  }).lean() as Promise<AppV2BindingStateDoc | null>;
}

async function recordBindingRun(
  projectId: string,
  name: string,
  run: AppV2BindingRun,
): Promise<void> {
  await AppV2BindingState.updateOne(
    { projectId: new Types.ObjectId(projectId), name },
    {
      ...(run.status === "ready"
        ? {
            $set: {
              lastMaterializedAt: run.at,
              lastRowCount: run.rowCount ?? 0,
            },
          }
        : {}),
      // Newest first, keep the last 20 runs.
      $push: { history: { $each: [run], $position: 0, $slice: 20 } },
    },
    { upsert: true },
  );
}
import {
  buildQueryParquetFile,
  storeParquetArtifactFile,
} from "../services/parquet-build.service";
import { globFiles, readFile } from "./worktree.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface AppV2Binding {
  name: string;
  connectionId: string;
  /** Only "parquet" exists in v2 — live bindings are a later phase. */
  materialization: "parquet";
  /** Cron expression from `-- schedule:` front matter (Block 4 consumes it). */
  schedule?: string;
  /** From `-- dbt_project:` front matter ({{ dbt_schema }} rendering, later). */
  dbtProjectId?: string;
  sql: string;
}

export function bindingArtifactKey(projectId: string, name: string): string {
  return `apps-v2/${projectId}/${name}.parquet`;
}

/**
 * Parse a binding file's leading SQL-comment front matter:
 *
 *   -- connection: <workspace connection id>   (required)
 *   -- materialization: parquet                (default)
 *   -- schedule: 0 6 * * *                     (optional, cron)
 *   -- dbt_project: <id>                       (optional)
 *
 * The block ends at the first non-comment line; unknown keys are ignored.
 * Stays valid SQL for every editor/highlighter, and — unlike a central
 * manifest — two conversation branches adding bindings can never conflict.
 */
export function parseBindingFrontMatter(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "--") continue;
    const m = trimmed.match(/^--\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) {
      if (trimmed.startsWith("--")) continue; // plain comment inside block
      break; // first SQL line ends the front matter
    }
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Read the project's bindings from git at the given actor's view of the
 * tree. A binding is `bindings/<name>.sql` with front matter (name =
 * filename, discovery = glob) — no central manifest. Legacy fallback: a
 * mako.json `bindings[]` entry supplies connectionId for files without a
 * `-- connection:` line, until migrated.
 */
export async function readBindings(
  project: IAppProjectV2,
  actorId: string,
): Promise<AppV2Binding[]> {
  const legacyByName = new Map<string, string>();
  try {
    const raw = await readFile(project, "mako.json", actorId);
    const manifest = JSON.parse(raw.contents) as {
      bindings?: Array<{ name?: string; connectionId?: string }>;
    };
    for (const b of manifest.bindings ?? []) {
      if (b.name && b.connectionId) legacyByName.set(b.name, b.connectionId);
    }
  } catch {
    // No manifest — fine; front matter is the source of truth anyway.
  }

  const paths = await globFiles(project, "bindings/*.sql", actorId);
  const out: AppV2Binding[] = [];
  for (const path of paths) {
    const name = path.replace(/^bindings\//, "").replace(/\.sql$/, "");
    if (!NAME_RE.test(name)) {
      throw new Error(`Invalid binding filename: ${path}`);
    }
    const file = await readFile(project, path, actorId);
    const meta = parseBindingFrontMatter(file.contents);
    const connectionId = meta.connection ?? legacyByName.get(name);
    if (!connectionId) {
      throw new Error(
        `Binding "${name}" has no connection — add "-- connection: <id>" front matter to ${path}`,
      );
    }
    out.push({
      name,
      connectionId,
      materialization: "parquet",
      schedule: meta.schedule,
      dbtProjectId: meta.dbt_project,
      sql: file.contents,
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
      `No binding named "${name}" — create bindings/${name}.sql with "-- connection: <id>" front matter`,
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
  const startedAt = Date.now();
  let built;
  try {
    built = await buildQueryParquetFile({
      connection,
      executableQuery: binding.sql,
      filenameBase: `appv2-${projectId}-${binding.name}`,
      schemaProbe: "strict",
    });
  } catch (error) {
    await recordBindingRun(projectId, binding.name, {
      at: new Date(),
      status: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await storeParquetArtifactFile({
    filePath: built.filePath,
    artifactKey: bindingArtifactKey(projectId, binding.name),
    metadata: { appV2ProjectId: projectId, binding: binding.name },
  });
  await recordBindingRun(projectId, binding.name, {
    at: new Date(),
    status: "ready",
    rowCount: built.rowCount,
    durationMs: Date.now() - startedAt,
  });
  logger.info("Apps v2 binding materialized", {
    projectId,
    binding: binding.name,
    rowCount: built.rowCount,
  });
  return { rowCount: built.rowCount, byteSize: built.byteSize };
}
