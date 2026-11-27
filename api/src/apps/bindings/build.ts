/**
 * Building a binding: resolving its connection, running the read-only query
 * to parquet, and materializing (storing) the result.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Types } from "mongoose";
import {
  bindingActorLabels,
  withDefaultQueryLabels,
  withQueryLabels,
} from "../../services/bigquery-labels";
import {
  getArtifactStore,
  getArtifactSourceStore,
  storeArtifact,
} from "../../services/artifact-store.service";
import {
  appBindingParquetWriteOptions,
  parquetWriteArtifactMetadata,
} from "../../utils/parquet-compression";
import {
  snapshotFromParquetBestEffort,
  storeParquetWithSnapshot,
} from "../../services/binding-snapshot";
import {
  type IAppProject,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { connectionsRepo } from "../../repositories/connections";
import {
  buildQueryParquetFile,
  storeParquetArtifactFile,
  assertReadOnlyMaterializationQuery,
  type BuiltParquetFile,
} from "../../services/parquet-build.service";
import { ParquetRowLimitError } from "../../utils/streaming-parquet-builder";
import {
  bindingRowLimitMessage,
  parquetRowLimits,
  resolveBindingRowLimit,
} from "../../utils/parquet-row-limit";
import { resolveDbtBoundCode } from "../../dbt/dbt-environments.service";
import { reportBindingPhase } from "../binding-progress";
import { loggers } from "../../logging";
import { recordBindingRun } from "./state";
import {
  AppBinding,
  BindingArtifactIdentity,
  bindingArtifactKey,
  readMainBinding,
  BindingNotFoundError,
  legacyConnectionIds,
  parseBindingFrontMatter,
  readBindings,
  bindingFromSource,
} from "./definition";

const logger = loggers.api("apps");

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
    throw new BindingNotFoundError(
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
    ? await connectionsRepo.findDatabaseConnectionById(
        binding.connectionId,
        project.workspaceId.toString(),
      )
    : null;
  if (!connection) {
    throw new Error(`Connection ${binding.connectionId} not found`);
  }
  return connection as unknown as IDatabaseConnection;
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
): Promise<{ binding: AppBinding; connection: IDatabaseConnection }> {
  // The legacy manifest, when the text names no connection, comes from main
  // in git: the text came from a laptop, never from the caller's sandbox.
  const legacy = parseBindingFrontMatter(source).connection
    ? undefined
    : (await legacyConnectionIds(project, undefined)).get(name);
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
  // The gate reads quotes by the connection's own rules: with no dialect it
  // demands one statement under every reading, and refuses valid BigQuery
  // such as 'it\'s; ok' (2026-11-18: 2 pro-funnel-health bindings stopped
  // rebuilding and served stale numbers).
  const isMongo = connection.type === "mongodb";
  assertReadOnlyMaterializationQuery(code, connection.type);
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
  /**
   * The binding, already read by the caller. Without it a build reads every
   * file under bindings/ to find its own: 134 files cost 13 s per build on
   * 2026-11-03, against 1.5-3 s for small apps.
   */
  binding?: AppBinding;
  /**
   * Where to read the binding when neither `resolved` nor `binding` is given:
   * "view" (default) = the actor's view (live sandbox, else their branch),
   * falling back to main when that view has no such binding; "main" = main
   * in git only, never a sandbox (a laptop checkout's committed binding).
   * Ignored with `at`.
   */
  from?: "view" | "main";
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
    const resolveFromMain = async () => {
      const binding = await readMainBinding(project, name);
      if (!binding) {
        throw new BindingNotFoundError(
          `No binding named "${name}" on ${project.defaultBranch || "main"} — commit and push bindings/${name}.sql with "-- connection: <id>" front matter`,
        );
      }
      return { binding, connection: await bindingConnection(project, binding) };
    };
    const resolved =
      opts.resolved ??
      (opts.binding
        ? {
            binding: opts.binding,
            connection: await bindingConnection(project, opts.binding),
          }
        : opts.from === "main" && !opts.at
          ? await resolveFromMain()
          : undefined);
    try {
      built = await buildBindingParquet(
        project,
        name,
        actorId,
        opts.at,
        resolved,
      );
    } catch (error) {
      // The actor's view (a sandbox that has not pulled, a branch behind
      // main) lacks a binding main has: build main's, rather than fail on
      // a checkout the caller may not even be using.
      if (resolved || opts.at || !(error instanceof BindingNotFoundError)) {
        throw error;
      }
      built = await buildBindingParquet(
        project,
        name,
        actorId,
        undefined,
        await resolveFromMain().catch(mainError => {
          throw mainError instanceof BindingNotFoundError ? error : mainError;
        }),
      );
    }
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
