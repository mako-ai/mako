/**
 * Apps data bindings — bindings-as-files (apps.md decision log).
 *
 * Unlike v1's Mongo `dataBindings` array, a v2 binding is REPO CONTENT,
 * versioned and branchable with the app:
 *
 *   bindings/<name>.sql → front matter (-- connection:, -- schedule:, ...)
 *                         + the query; name = filename, discovery = glob
 *
 * The agent authors bindings with the ordinary file tools (app_write_file /
 * app_edit_file) — no bespoke binding CRUD. Materialization reuses v1's
 * parquet pipeline (buildQueryParquetFile + artifact store) with artifacts
 * keyed `apps/<projectId>/<name>.parquet`; the preview runtime serves
 * them at the app-relative path `__data/<name>.parquet`, which resolves
 * under the token prefix in BOTH static and dev previews, so app code just
 * fetches a relative URL and reads it with DuckDB-WASM (v1's useRows
 * pattern ports over with a one-line URL change).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import mongoose, { Schema, Types } from "mongoose";
import {
  bindingActorLabels,
  withDefaultQueryLabels,
  withQueryLabels,
} from "../services/bigquery-labels";
import {
  getArtifactStore,
  getArtifactSourceStore,
  storeArtifact,
} from "../services/artifact-store.service";
import {
  PARQUET_CODECS,
  appBindingParquetWriteOptions,
  parquetWriteArtifactMetadata,
  type ParquetCodec,
} from "../utils/parquet-compression";
import {
  snapshotFromParquetBestEffort,
  storeParquetWithSnapshot,
} from "../services/binding-snapshot";
import {
  DatabaseConnection,
  type IAppProject,
  type IDatabaseConnection,
} from "../database/workspace-schema";

/**
 * Derived runtime state per binding (NOT source of truth — that is the repo).
 * Only what the scheduler needs: when the artifact was last built, and
 * which artifact that was.
 */
export interface AppBindingRun {
  at: Date;
  status: "ready" | "error";
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
  /**
   * The content-addressed artifact this run built. State is per binding
   * NAME while artifacts are per DEFINITION, so without this a run says
   * "fr_demos was built this morning" but not of which query — which is
   * what made #992 impossible to see in the history. Recorded for
   * observability; absent on runs recorded before the field existed.
   */
  artifactKey?: string | null;
  /** Artifact bytes after compression. Absent on older runs. */
  byteSize?: number | null;
  /** Parquet codec of this build. Absent on older runs (all SNAPPY). */
  compression?: ParquetCodec | null;
}

export interface AppBindingStateDoc {
  lastMaterializedAt?: Date;
  lastRowCount?: number;
  history?: AppBindingRun[];
  /** Throttle marker for anonymous on-demand refreshes (public shares). */
  publicRefreshAt?: Date;
}

const AppBindingState =
  mongoose.models.AppBindingState ??
  mongoose.model(
    "AppBindingState",
    new Schema(
      {
        projectId: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        lastMaterializedAt: { type: Date },
        lastRowCount: { type: Number },
        publicRefreshAt: { type: Date },
        history: {
          type: [
            new Schema(
              {
                at: { type: Date, required: true },
                status: { type: String, enum: ["ready", "error"] },
                rowCount: { type: Number },
                durationMs: { type: Number },
                error: { type: String },
                artifactKey: { type: String },
                byteSize: { type: Number },
                compression: { type: String, enum: [...PARQUET_CODECS] },
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
): Promise<AppBindingStateDoc | null> {
  return AppBindingState.findOne({
    projectId: new Types.ObjectId(projectId),
    name,
  }).lean() as Promise<AppBindingStateDoc | null>;
}

export async function recordBindingRun(
  projectId: string,
  name: string,
  run: AppBindingRun,
): Promise<void> {
  await AppBindingState.updateOne(
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

/**
 * Claim the right to refresh a binding on behalf of an anonymous viewer:
 * succeeds at most once per `cooldownMs` per binding, atomically, so a
 * public page full of concurrent viewers cannot queue duplicate warehouse
 * queries. Returns
 * how long to wait when the slot is taken.
 *
 * One upsert does the whole thing: the filter admits a row that has never
 * been claimed (no marker) or whose marker is older than the cooldown; a row
 * that exists but is cooling down fails the filter, so the upsert tries to
 * INSERT a duplicate and the unique (projectId, name) index rejects it —
 * that rejection IS the "cooling down" answer, with no read-then-write gap.
 */
export async function claimPublicBindingRefresh(
  projectId: string,
  name: string,
  cooldownMs: number,
): Promise<{ claimed: true } | { claimed: false; retryAfterMs: number }> {
  const now = new Date();
  const filter = { projectId: new Types.ObjectId(projectId), name };
  try {
    await AppBindingState.updateOne(
      {
        ...filter,
        publicRefreshAt: {
          $not: { $gt: new Date(now.getTime() - cooldownMs) },
        },
      },
      { $set: { publicRefreshAt: now } },
      { upsert: true },
    );
    return { claimed: true };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const existing = (await AppBindingState.findOne(filter).lean()) as {
    publicRefreshAt?: Date;
  } | null;
  const last = existing?.publicRefreshAt?.getTime() ?? now.getTime();
  return {
    claimed: false,
    retryAfterMs: Math.max(1000, cooldownMs - (now.getTime() - last)),
  };
}

import {
  buildQueryParquetFile,
  storeParquetArtifactFile,
  assertReadOnlyMaterializationQuery,
  type BuiltParquetFile,
} from "../services/parquet-build.service";
import { globFiles, readFile } from "./worktree.service";
import { ParquetRowLimitError } from "../utils/streaming-parquet-builder";
import {
  bindingRowLimitMessage,
  parquetRowLimits,
  resolveBindingRowLimit,
} from "../utils/parquet-row-limit";
import { resolveDbtBoundCode } from "../dbt/dbt-environments.service";
import { reportBindingPhase } from "./binding-progress";
import { loggers } from "../logging";

const logger = loggers.api("apps");
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface AppBinding {
  name: string;
  connectionId: string;
  /**
   * "parquet" = materialized to a stored artifact (default, scheduled).
   * "live" = re-queried on demand and served fresh, no artifact. Live is
   * dev/edit-mode only for now (a published app has no authorized data
   * path yet — apps.md §13.4.1).
   */
  materialization: "parquet" | "live";
  /** Cron expression from `-- schedule:` front matter (Block 4 consumes it). */
  schedule?: string;
  /** IANA timezone for the schedule (`-- timezone:`), when the source had one. */
  timezone?: string;
  /** From `-- dbt_project:` front matter ({{ dbt_schema }} rendering, later). */
  dbtProjectId?: string;
  /** `-- database:` / `-- database_name:` for connections that need one selected. */
  databaseId?: string;
  databaseName?: string;
  /**
   * `-- row_limit:` as written (e.g. `3000000`, `3M`). Resolved and checked
   * against PARQUET_MAX_ROW_LIMIT at build time (resolveBindingRowLimit), so
   * a typo fails that binding's build with a message, never its serving.
   * Absent = PARQUET_ROW_LIMIT. Not part of the artifact identity: a build
   * that succeeds holds the whole result whatever the limit was.
   */
  rowLimit?: string;
  /** The whole file, front matter included. */
  sql: string;
  /** The executable part: the file with its leading comment block removed. */
  code: string;
}

/** The parts of a binding that determine its result — and thus its artifact. */
export interface BindingArtifactIdentity {
  connectionId: string;
  databaseId?: string;
  databaseName?: string;
  /** SQL with front matter already stripped (AppBinding.code). */
  code: string;
}

/**
 * A hash of a binding's DEFINITION (connection + database + query), not its
 * data. Stable while the query is unchanged; changes the moment the query
 * does.
 */
export function bindingDefinitionHash(b: BindingArtifactIdentity): string {
  const canon = [
    b.connectionId,
    b.databaseId ?? "",
    b.databaseName ?? "",
    b.code.trim(),
  ].join("\u0000");
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/**
 * Content-addressed artifact key: identical queries (same connection, same
 * SQL) resolve to the SAME parquet file, wherever they live. So two apps — or
 * a v1 app and its v2 migration, or two branches of one app — that run the
 * same binding share ONE artifact (materialize once, no duplication, no double
 * cost), and a query EDIT lands at a new key rather than overwriting the file
 * an older commit still reads. This replaced the per-(project,name) key, which
 * duplicated data and could serve a stale build after an edit.
 */
export function bindingArtifactKey(b: BindingArtifactIdentity): string {
  return `apps/bindings/${b.connectionId}/${bindingDefinitionHash(b)}.parquet`;
}

/**
 * The artifact key for a binding addressed by name — resolves the binding from
 * the project (repo) to get its definition. Returns null when no such binding
 * exists. For callers (preview/publish/serve) that hold only a name.
 */
export async function bindingArtifactKeyByName(
  project: IAppProject,
  name: string,
  actorId: string,
  /** Resolve the binding as of this commit (published serving). */
  at?: string,
): Promise<string | null> {
  if (!NAME_RE.test(name)) return null;
  // ONE binding file, not every binding in the app. This is the serving path
  // — each `__data/<name>.parquet` request resolves its key here — and every
  // file read re-resolves the actor's source, which asks the sandbox provider
  // whether a live box should answer instead of the commit. Reading all N
  // bindings therefore cost N of those probes, so a 16-binding app spent ~30s
  // of round trips before streaming a parquet whose bytes take milliseconds.
  // Reading only what was asked for also means a malformed NEIGHBOUR (no
  // connection, bad filename) no longer 500s a healthy binding's data.
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId, at);
  } catch {
    return null;
  }
  const meta = parseBindingFrontMatter(file.contents);
  const connectionId =
    meta.connection ??
    (await legacyConnectionIds(project, actorId, at)).get(name);
  if (!connectionId) {
    throw new Error(
      `Binding "${name}" has no connection — add "-- connection: <id>" front matter to bindings/${name}.sql`,
    );
  }
  return bindingArtifactKey({
    connectionId,
    databaseId: meta.database,
    databaseName: meta.database_name,
    code: stripBindingFrontMatter(file.contents),
  });
}

/**
 * ONE committed binding, parsed — the same narrow single-file read as
 * bindingArtifactKeyByName. Null when there is no such file or it names no
 * connection.
 */
export async function readCommittedBinding(
  project: IAppProject,
  name: string,
  actorId: string,
): Promise<AppBinding | null> {
  if (!NAME_RE.test(name)) return null;
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId);
  } catch {
    return null;
  }
  const legacy = parseBindingFrontMatter(file.contents).connection
    ? undefined
    : (await legacyConnectionIds(project, actorId)).get(name);
  return bindingFromSource(name, file.contents, legacy);
}

/** CRLF/CR → LF, no trailing whitespace at the end — not part of a query. */
export function normalizeBindingText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

/**
 * Do two bindings produce the same data? Everything that decides the result
 * (connection, database, dbt link, materialization mode, the query), with line
 * endings normalised so a CRLF checkout of the same file still matches. The
 * row limit counts too: it decides whether a build succeeds, so a draft that
 * only raises it must build with its own limit, not the committed one.
 * Scheduling fields do not change the data and are ignored.
 */
export function sameBindingDefinition(a: AppBinding, b: AppBinding): boolean {
  return (
    a.connectionId === b.connectionId &&
    (a.rowLimit?.trim() ?? "") === (b.rowLimit?.trim() ?? "") &&
    (a.databaseId ?? "") === (b.databaseId ?? "") &&
    (a.databaseName ?? "") === (b.databaseName ?? "") &&
    (a.dbtProjectId ?? "") === (b.dbtProjectId ?? "") &&
    a.materialization === b.materialization &&
    normalizeBindingText(a.code).trim() === normalizeBindingText(b.code).trim()
  );
}

/**
 * How ONE binding is materialized, from its file alone — the same narrow
 * single-file read the serving path uses, for the same reason (a malformed
 * neighbour must not decide this binding's fate). Null when there is no such
 * binding.
 */
export async function readBindingMaterialization(
  project: IAppProject,
  name: string,
  actorId: string,
  at?: string,
): Promise<AppBinding["materialization"] | null> {
  if (!NAME_RE.test(name)) return null;
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId, at);
  } catch {
    return null;
  }
  const meta = parseBindingFrontMatter(file.contents);
  return meta.materialization === "live" ? "live" : "parquet";
}

/**
 * v1 kept each binding's connection in mako.json. Front matter is the source
 * of truth now; this is the fallback for files written before it, read only
 * when a binding has no `-- connection:` line.
 */
async function legacyConnectionIds(
  project: IAppProject,
  actorId: string,
  at?: string,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  try {
    const raw = await readFile(project, "mako.json", actorId, at);
    const manifest = JSON.parse(raw.contents) as {
      bindings?: Array<{ name?: string; connectionId?: string }>;
    };
    for (const b of manifest.bindings ?? []) {
      if (b.name && b.connectionId) byName.set(b.name, b.connectionId);
    }
  } catch {
    // No manifest — fine; front matter is the source of truth anyway.
  }
  return byName;
}

/**
 * Parse a binding file's leading SQL-comment front matter:
 *
 *   -- connection: <workspace connection id>   (required)
 *   -- materialization: parquet                (default)
 *   -- schedule: 0 6 * * *                     (optional, cron)
 *   -- dbt_project: <id>                       (optional)
 *   -- row_limit: 3000000                      (optional, rows; also 3M)
 *
 * The block ends at the first non-comment line; unknown keys are ignored.
 * Stays valid SQL for every editor/highlighter, and — unlike a central
 * manifest — two conversation branches adding bindings can never conflict.
 */
/**
 * Front matter is the leading block of comment lines, `-- key: value` in SQL
 * files and `// key: value` in JavaScript (MongoDB) files. The first
 * non-comment line ends it.
 */
export function parseBindingFrontMatter(
  source: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "--" || trimmed === "//") continue;
    const m = trimmed.match(
      /^(?:--|\/\/)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/,
    );
    if (!m) {
      if (trimmed.startsWith("--") || trimmed.startsWith("//")) continue;
      break;
    }
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** The file without its leading comment block — what actually executes. */
export function stripBindingFrontMatter(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("--") || t.startsWith("//")) i++;
    else break;
  }
  return lines.slice(i).join("\n");
}

/**
 * Read the project's bindings from git at the given actor's view of the
 * tree. A binding is `bindings/<name>.sql` with front matter (name =
 * filename, discovery = glob) — no central manifest. Legacy fallback: a
 * mako.json `bindings[]` entry supplies connectionId for files without a
 * `-- connection:` line, until migrated.
 */
export async function readBindings(
  project: IAppProject,
  actorId: string,
  /**
   * Read the bindings as of this commit rather than the actor's view. A
   * published deployment is a build of one commit; its data is defined by
   * the binding files at that same commit.
   */
  at?: string,
): Promise<AppBinding[]> {
  const { bindings, skipped } = await readBindingsTolerant(
    project,
    actorId,
    at,
  );
  if (skipped.length > 0) throw new Error(skipped[0].error);
  return bindings;
}

export interface BindingsReadResult {
  bindings: AppBinding[];
  /** Files under bindings/ that are not servable bindings, and why. */
  skipped: Array<{ path: string; error: string }>;
}

/**
 * readBindings that reports malformed files instead of refusing the whole
 * set. The serving path already isolates a malformed neighbour (a bad
 * filename or a missing connection only breaks ITS data URL); publish must
 * match, or a stray `bindings/draft (copy).sql` committed alongside a code
 * fix pins the app at its previous deployment — every publish, every
 * rollback to any sha containing the file, and the hourly reconcile
 * re-enqueuing the same failure.
 */
export async function readBindingsTolerant(
  project: IAppProject,
  actorId: string,
  at?: string,
): Promise<BindingsReadResult> {
  const legacyByName = await legacyConnectionIds(project, actorId, at);

  const paths = await globFiles(
    project,
    "bindings/*.sql",
    actorId,
    undefined,
    at,
  );
  const out: AppBinding[] = [];
  const skipped: BindingsReadResult["skipped"] = [];
  for (const path of paths) {
    const name = path.replace(/^bindings\//, "").replace(/\.sql$/, "");
    if (!NAME_RE.test(name)) {
      skipped.push({ path, error: `Invalid binding filename: ${path}` });
      continue;
    }
    const file = await readFile(project, path, actorId, at);
    const binding = bindingFromSource(
      name,
      file.contents,
      legacyByName.get(name),
    );
    if (!binding) {
      skipped.push({
        path,
        error: `Binding "${name}" has no connection — add "-- connection: <id>" front matter to ${path}`,
      });
      continue;
    }
    out.push(binding);
  }
  return { bindings: out, skipped };
}

/**
 * One binding from its file's text. Null when neither the front matter nor
 * the legacy manifest names a connection. Shared by the repo read and the
 * dev build (which receives the text from a laptop instead of the repo), so
 * both parse a binding identically.
 */
export function bindingFromSource(
  name: string,
  source: string,
  legacyConnectionId?: string,
): AppBinding | null {
  const meta = parseBindingFrontMatter(source);
  const connectionId = meta.connection ?? legacyConnectionId;
  if (!connectionId) return null;
  return {
    name,
    connectionId,
    materialization: meta.materialization === "live" ? "live" : "parquet",
    schedule: meta.schedule,
    timezone: meta.timezone,
    dbtProjectId: meta.dbt_project,
    databaseId: meta.database,
    databaseName: meta.database_name,
    rowLimit: meta.row_limit ?? meta.rowlimit,
    sql: source,
    code: stripBindingFrontMatter(source),
  };
}

/**
 * Build the parquet artifact for one binding, synchronously. Reuses v1's
 * read-only-enforced parquet pipeline; the artifact overwrites in place, so
 * previews pick up fresh data on the next fetch.
 */
async function resolveBindingForBuild(
  project: IAppProject,
  name: string,
  actorId: string,
  at?: string,
): Promise<{ binding: AppBinding; connection: IDatabaseConnection }> {
  const bindings = await readBindings(project, actorId, at);
  const binding = bindings.find(b => b.name === name);
  if (!binding) {
    throw new Error(
      `No binding named "${name}" — create bindings/${name}.sql with "-- connection: <id>" front matter`,
    );
  }
  return { binding, connection: await bindingConnection(project, binding) };
}

/** The binding's connection, which must belong to the app's workspace. */
async function bindingConnection(
  project: IAppProject,
  binding: AppBinding,
): Promise<IDatabaseConnection> {
  const connection = Types.ObjectId.isValid(binding.connectionId)
    ? await DatabaseConnection.findOne({
        _id: new Types.ObjectId(binding.connectionId),
        workspaceId: project.workspaceId,
      })
    : null;
  if (!connection) {
    throw new Error(`Connection ${binding.connectionId} not found`);
  }
  return connection;
}

/**
 * A binding defined by text the caller sent rather than by the repo — the
 * laptop dev loop's uncommitted `bindings/<name>.sql`. The connection still
 * comes from its front matter (or the legacy manifest) and must belong to
 * this workspace, exactly as for a committed binding.
 */
export async function resolveDraftBinding(
  project: IAppProject,
  name: string,
  source: string,
  actorId: string,
): Promise<{ binding: AppBinding; connection: IDatabaseConnection }> {
  const legacy = parseBindingFrontMatter(source).connection
    ? undefined
    : (await legacyConnectionIds(project, actorId)).get(name);
  const binding = bindingFromSource(name, source, legacy);
  if (!binding) {
    throw new Error(
      `Binding "${name}" has no connection — add "-- connection: <id>" front matter to bindings/${name}.sql`,
    );
  }
  return { binding, connection: await bindingConnection(project, binding) };
}

/**
 * Run a binding's query NOW and return the parquet on disk — no store, no run
 * record. This is the shared core of both materialize (which stores it) and
 * the live path (which streams it and throws it away). Same read-only gate
 * and same builder v1 used, so a MongoDB source flattens to tabular exactly
 * as it did there.
 */
export async function buildBindingParquet(
  project: IAppProject,
  name: string,
  actorId: string,
  /**
   * Build the binding as defined AT this commit rather than in the actor's
   * view. A published app serves the bindings of its published commit, so
   * refreshing its data must rebuild those — not whatever the working
   * branch says today, which is keyed to a different artifact entirely.
   */
  at?: string,
  /**
   * Build THIS already-resolved binding instead of reading it again: a caller
   * that decided what to build from one read must not build a different
   * definition committed in between.
   */
  resolved?: { binding: AppBinding; connection: IDatabaseConnection },
): Promise<BuiltParquetFile & { binding: AppBinding }> {
  // The actor is the fallback trigger: an entry point that knows better
  // (viewer refresh, live binding, dev build) set mako_trigger already.
  return withDefaultQueryLabels(bindingActorLabels(actorId), async () => {
    const { binding, connection } =
      resolved ?? (await resolveBindingForBuild(project, name, actorId, at));
    // A dbt-linked binding (`-- dbt_project:` front matter) writes
    // `{{ dbt_schema }}` and expects the project's prod-like schema in its
    // place — exactly what v1 did for these same queries. Without this the
    // warehouse was asked for a literal `{{ dbt_schema }}` dataset, so every
    // former v1 "live" binding failed to materialize.
    const code = await resolveDbtBoundCode({
      workspaceId: project.workspaceId,
      dbtProjectId: binding.dbtProjectId,
      code: binding.code,
    });
    const built = await buildResolvedBindingParquet(
      project,
      binding,
      connection,
      code,
    );
    return { ...built, binding };
  });
}

/**
 * The build itself, for a binding already resolved and rendered: the
 * read-only gate, the schema probe and the parquet writer. Every binding
 * build — committed, published, scheduled or a laptop draft — runs through
 * here, so none of them can skip a gate the others apply.
 */
export async function buildResolvedBindingParquet(
  project: IAppProject,
  binding: AppBinding,
  connection: IDatabaseConnection,
  /** binding.code with `{{ dbt_schema }}` already rendered. */
  code: string,
): Promise<BuiltParquetFile> {
  // The CONNECTION decides how the query runs and how it is gated: a Mongo
  // connection runs a pipeline (validated by its driver, columns inferred at
  // runtime), a SQL connection runs SELECT (lexically gated, schema probed).
  // The binding file is language-agnostic; only its target matters.
  const isMongo = connection.type === "mongodb";
  assertReadOnlyMaterializationQuery(code, isMongo ? "mongodb" : undefined);
  const labels = {
    mako_source: "app_binding",
    mako_app: project.slug || project._id.toString(),
    mako_app_id: project._id.toString(),
    mako_binding: binding.name,
    mako_workspace: project.workspaceId?.toString(),
  };
  const limits = parquetRowLimits();
  // Before any query runs: a bad `-- row_limit:` fails here, by name.
  const rowLimit = resolveBindingRowLimit(
    binding.name,
    binding.rowLimit,
    limits,
  );
  try {
    return await withQueryLabels(labels, () =>
      buildQueryParquetFile({
        connection,
        executableQuery: code,
        databaseId: binding.databaseId,
        databaseName: binding.databaseName,
        filenameBase: `appv2-${project._id.toString()}-${binding.name}`,
        schemaProbe: isMongo ? "lenient" : "strict",
        rowLimit,
        // An app reads its binding as the WHOLE result: DuckDB in the page
        // sums it, so a parquet cut at the row limit would be summed as if
        // complete (a 526,470-row binding was served as exactly 500,000 rows
        // and every total on the page read ~5% short). Fail the build
        // instead; the binding keeps serving its previous artifact and the
        // run records why.
        onRowLimit: "fail",
        // Past the limit, keep counting (nothing more is written) up to the
        // hard maximum, so the error says how many rows the query returned
        // and which `-- row_limit:` would fit them.
        countRowsUpTo: limits.maxRowLimit,
        // Only app bindings take the configurable codec (default ZSTD). The
        // CDC and sync loaders call the builder without it and stay SNAPPY.
        writeOptions: appBindingParquetWriteOptions(),
      }),
    );
  } catch (error) {
    if (error instanceof ParquetRowLimitError) {
      throw new BindingRowLimitError(
        bindingRowLimitMessage({
          bindingName: binding.name,
          rowLimit,
          rowCount: error.rowCount,
          exact: error.exact,
          maxRowLimit: limits.maxRowLimit,
        }),
        error,
      );
    }
    throw error;
  }
}

/**
 * A binding's query returned more rows than its row limit. The message names
 * the binding, its row count and the fix; `cause` keeps the builder's numbers.
 */
export class BindingRowLimitError extends Error {
  readonly rowLimit: number;
  readonly rowCount: number;
  readonly exact: boolean;
  constructor(message: string, cause: ParquetRowLimitError) {
    super(message, { cause });
    this.name = "BindingRowLimitError";
    this.rowLimit = cause.rowLimit;
    this.rowCount = cause.rowCount;
    this.exact = cause.exact;
  }
}

export interface MaterializeOptions {
  /** Build the binding as of this commit (see buildBindingParquet). */
  at?: string;
  /**
   * Leave the built parquet on disk and return its path — for a caller that
   * streams the bytes on after storing them (the sandbox's on-demand refresh
   * does: one query serves both the artifact store and the box). The caller
   * owns the file from then on.
   */
  keepFile?: boolean;
  /** Build this resolved binding rather than re-reading it (see buildBindingParquet). */
  resolved?: { binding: AppBinding; connection: IDatabaseConnection };
}

export interface MaterializeResult {
  /** Where the build was stored (content-addressed; see bindingArtifactKey). */
  artifactKey: string;
  rowCount: number;
  byteSize: number;
  materializedAt: Date;
  /** Only with `keepFile`. */
  filePath?: string;
}

export async function materializeAppBinding(
  project: IAppProject,
  name: string,
  actorId: string,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const projectId = project._id.toString();
  const startedAt = Date.now();
  let built;
  try {
    built = await buildBindingParquet(
      project,
      name,
      actorId,
      opts.at,
      opts.resolved,
    );
  } catch (error) {
    await recordBindingRun(projectId, name, {
      at: new Date(),
      status: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const artifactKey = bindingArtifactKey(built.binding);
  const metadata = {
    appProjectId: projectId,
    binding: name,
    ...parquetWriteArtifactMetadata(built),
  };
  reportBindingPhase("uploading", {
    rowsWritten: built.rowCount,
    bytes: built.byteSize,
  });
  // The preview rows for useQuery(name, { snapshot: true }), read back from
  // the file about to be stored (binding-snapshot.ts).
  const snapshot = await snapshotFromParquetBestEffort(
    built.filePath,
    built.rowCount,
    { projectId, binding: name },
  );
  await storeParquetWithSnapshot({
    parquetKey: artifactKey,
    snapshot,
    context: { projectId, binding: name },
    uploadParquet: () =>
      opts.keepFile
        ? storeArtifact(built.filePath, artifactKey, metadata)
        : storeParquetArtifactFile({
            filePath: built.filePath,
            artifactKey,
            metadata,
          }),
  });
  const materializedAt = new Date();
  await recordBindingRun(projectId, name, {
    at: materializedAt,
    status: "ready",
    rowCount: built.rowCount,
    byteSize: built.byteSize,
    compression: built.compression,
    durationMs: Date.now() - startedAt,
    artifactKey,
  });
  logger.info("Apps binding materialized", {
    projectId,
    binding: name,
    rowCount: built.rowCount,
    byteSize: built.byteSize,
    compression: built.compression,
    encodeDurationMs: built.encodeDurationMs,
  });
  return {
    artifactKey,
    rowCount: built.rowCount,
    byteSize: built.byteSize,
    materializedAt,
    ...(opts.keepFile ? { filePath: built.filePath } : {}),
  };
}

/**
 * Adopt an existing parquet artifact as this binding's current build — the
 * v1 → v2 migration uses it so an app arrives with the data it had, and the
 * scheduler sees a real last run instead of "never built".
 */
export async function adoptBindingArtifact(input: {
  projectId: string;
  name: string;
  /** The v2 binding's definition — decides the content-addressed target key. */
  binding: BindingArtifactIdentity;
  fromKey: string;
  builtAt: Date;
  rowCount?: number;
  byteSize?: number;
}): Promise<boolean> {
  const store = getArtifactStore();
  // Read the v1 artifact from the SOURCE store when one is configured (a dev
  // rehearsal reading prod's GCS); otherwise from the same store we write to
  // (prod: an in-store copy). Written artifacts always go to the live store.
  const source = getArtifactSourceStore() ?? store;
  if (!(await source.exists(input.fromKey))) return false;
  const toKey = bindingArtifactKey(input.binding);
  // Already the same file in the SAME store (another app/branch with the same
  // query built it): nothing to copy — the content-addressed key shares it.
  if (input.fromKey === toKey && source === store) {
    await recordBindingRun(input.projectId, input.name, {
      at: input.builtAt,
      status: "ready",
      rowCount: input.rowCount,
      durationMs: 0,
      artifactKey: toKey,
    });
    return true;
  }
  const stream = await source.openReadStream(input.fromKey);
  if (!stream) return false;
  const tmp = path.join(
    os.tmpdir(),
    `mako-adopt-${input.projectId}-${input.name}-${Date.now()}.parquet`,
  );
  try {
    await pipeline(stream, fs.createWriteStream(tmp));
    await store.put(tmp, toKey, {
      appProjectId: input.projectId,
      binding: input.name,
      adoptedFrom: input.fromKey,
    });
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
  await recordBindingRun(input.projectId, input.name, {
    at: input.builtAt,
    status: "ready",
    rowCount: input.rowCount,
    durationMs: 0,
    artifactKey: toKey,
  });
  return true;
}
