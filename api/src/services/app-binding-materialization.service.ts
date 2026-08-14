/**
 * App data-binding materialization.
 *
 * Materializes a React App binding's query into a Parquet artifact using the
 * SAME pipeline as dashboards: stream query batches -> build Parquet with the
 * node DuckDB builder -> store on the configured artifact backend
 * (filesystem/GCS/S3). The browser then loads the artifact into DuckDB-WASM.
 *
 * Reuses `buildParquetFromBatches`, the artifact store, and the streaming query
 * APIs verbatim; only the artifact key/hash and Mongo writes are app-specific.
 */

import { Types } from "mongoose";
import {
  MakoApp,
  DatabaseConnection,
  type IMakoApp,
  type IMakoAppDataBinding,
} from "../database/workspace-schema";
import {
  artifactExists,
  withArtifactBuildLock,
  getArtifactPrefix,
} from "./dashboard-cache.service";
import {
  buildQueryParquetFile,
  storeParquetArtifactFile,
  assertReadOnlyMaterializationQuery,
  PARQUET_ROW_LIMIT,
} from "./parquet-build.service";
import { inngest } from "../inngest/client";
import { publishRealtimeEvent } from "./realtime.service";
import { loggers } from "../logging";
import {
  assertSafeEnvironmentName,
  buildAppBindingArtifactKeyWithPrefix,
  envCachePath,
  isEnvironmentBuildActive,
  BUILD_STALE_THRESHOLD_MS,
} from "./app-binding-artifact-paths";

// Artifact addressing lives in a side-effect-free module so it stays unit
// testable; re-exported here so callers keep one import site.
export {
  assertSafeEnvironmentName,
  buildAppBindingArtifactPath,
  envCachePath,
  hydrateAppBindingUrls,
  isEnvironmentBuildActive,
  BUILD_STALE_THRESHOLD_MS,
} from "./app-binding-artifact-paths";

const logger = loggers.api("app-materialization");

/** How often a running build refreshes its heartbeat (`parquetBuildStatusAt`). */
const BUILD_HEARTBEAT_INTERVAL_MS = 30 * 1000;

export interface AppBindingMaterializationStatus {
  bindingId: string;
  status: "ready" | "error";
  rowCount?: number;
  byteSize?: number;
  artifactRevision?: string;
  error?: string;
}

export interface AppBindingQueueResult {
  bindingId: string;
  /** `ready` means the existing artifact was reused (cache hit). */
  status: "ready" | "queued" | "building" | "error";
  /** True when a new background build was enqueued by this call. */
  queued: boolean;
  /** True when a build was already in flight for this binding. */
  alreadyRunning?: boolean;
  rowCount?: number;
  byteSize?: number;
  artifactRevision?: string;
  error?: string;
}

/** Definition fields feeding the artifact hash (code substituted by callers). */
function bindingHashFields(binding: IMakoAppDataBinding) {
  return {
    connectionId: binding.connectionId,
    language: binding.language,
    code: binding.code,
    databaseId: binding.databaseId,
    databaseName: binding.databaseName,
    dbtProjectId: binding.dbtProjectId,
  };
}

/** Stable hash of a binding's query definition; changing it invalidates cache. */
export function buildAppBindingDefinitionHash(
  binding: Pick<
    IMakoAppDataBinding,
    | "connectionId"
    | "language"
    | "code"
    | "databaseId"
    | "databaseName"
    | "dbtProjectId"
  >,
): string {
  const payload = JSON.stringify({
    connectionId: String(binding.connectionId),
    language: binding.language,
    code: binding.code,
    databaseId: binding.databaseId ?? null,
    databaseName: binding.databaseName ?? null,
    // Only included when set so legacy (non-dbt) binding hashes — and their
    // already-built artifacts — stay stable.
    ...(binding.dbtProjectId ? { dbtProjectId: binding.dbtProjectId } : {}),
  });
  // djb2 — matches the lightweight (non-crypto) hashing used for dashboards.
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 33) ^ payload.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function buildAppBindingArtifactKey(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  definitionHash: string;
  environment?: string;
}): string {
  return buildAppBindingArtifactKeyWithPrefix({
    prefix: getArtifactPrefix(),
    ...input,
  });
}

/** Whether a queued/building status is genuinely in flight (fresh heartbeat). */
export function isAppBindingBuildActive(
  cache:
    | {
        parquetBuildStatus?: string | null;
        parquetBuildStatusAt?: Date | string | null;
      }
    | undefined,
): boolean {
  if (
    cache?.parquetBuildStatus !== "queued" &&
    cache?.parquetBuildStatus !== "building"
  ) {
    return false;
  }
  const at = cache.parquetBuildStatusAt
    ? new Date(cache.parquetBuildStatusAt).getTime()
    : 0;
  return Date.now() - at < BUILD_STALE_THRESHOLD_MS;
}

const BUILD_STALLED_MESSAGE =
  "Materialization stalled (worker stopped reporting progress). Re-run materialize to retry.";

/** Serializable per-environment build status returned by the status route. */
export interface AppBindingEnvironmentStatus {
  status: "missing" | "queued" | "building" | "ready" | "error";
  error?: string | null;
  stale: boolean;
  rowCount?: number;
  byteSize?: number;
  artifactRevision?: string;
  sourceSchema?: string;
  builtAt?: Date;
  updatedAt?: Date | null;
}

/**
 * Serializable materialization status for one binding, with stale
 * queued/building states surfaced as errors so pollers always terminate.
 */
export function buildAppBindingMaterializationStatus(
  app: IMakoApp,
  bindingId: string,
): {
  bindingId: string;
  materialization: "live" | "parquet";
  status: "missing" | "queued" | "building" | "ready" | "error";
  error?: string | null;
  stale: boolean;
  rowCount?: number;
  byteSize?: number;
  artifactRevision?: string;
  lastRefreshedAt?: Date;
  parquetBuiltAt?: Date;
  updatedAt?: Date | null;
  environments?: Record<string, AppBindingEnvironmentStatus>;
} | null {
  const binding = app.dataBindings.find(b => b.id === bindingId);
  if (!binding) return null;
  const cache = binding.cache;
  const rawStatus = cache?.parquetBuildStatus ?? "missing";
  const inFlight = rawStatus === "queued" || rawStatus === "building";
  const stale = inFlight && !isAppBindingBuildActive(cache);

  // Per-environment status, with the same stale-build handling as prod so a
  // crashed dev build reports as an error instead of polling forever.
  const environments: Record<string, AppBindingEnvironmentStatus> = {};
  for (const [envName, envArtifact] of Object.entries(
    cache?.environments ?? {},
  )) {
    const envRawStatus = envArtifact?.status ?? "missing";
    const envInFlight =
      envRawStatus === "queued" || envRawStatus === "building";
    const envStale = envInFlight && !isEnvironmentBuildActive(envArtifact);
    environments[envName] = {
      status: envStale ? "error" : envRawStatus,
      error: envStale ? BUILD_STALLED_MESSAGE : envArtifact?.error,
      stale: envStale,
      rowCount: envArtifact?.rowCount,
      byteSize: envArtifact?.byteSize,
      artifactRevision: envArtifact?.artifactRevision,
      sourceSchema: envArtifact?.sourceSchema,
      builtAt: envArtifact?.builtAt,
      updatedAt: envArtifact?.statusAt,
    };
  }

  return {
    bindingId,
    materialization: binding.materialization,
    status: stale ? "error" : rawStatus,
    error: stale ? BUILD_STALLED_MESSAGE : cache?.parquetLastError,
    stale,
    rowCount: cache?.rowCount,
    byteSize: cache?.byteSize,
    artifactRevision: cache?.artifactRevision,
    lastRefreshedAt: cache?.lastRefreshedAt,
    parquetBuiltAt: cache?.parquetBuiltAt,
    updatedAt: cache?.parquetBuildStatusAt,
    environments:
      Object.keys(environments).length > 0 ? environments : undefined,
  };
}

/**
 * Queue a binding materialization to run in the background and return
 * immediately. This is the only entry point HTTP handlers should use — the
 * build itself runs in an Inngest worker (or, if enqueueing fails, in-process
 * detached from the request) so callers never block on the query + Parquet
 * build and the build survives client disconnects.
 *
 * Returns `ready` without queueing on a cache hit, and dedupes against builds
 * that are already genuinely in flight. Stale queued/building states (crashed
 * workers) are reclaimed atomically.
 */
export async function queueAppBindingMaterialization(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  force?: boolean;
}): Promise<AppBindingQueueResult> {
  const { workspaceId, appId, bindingId, force } = input;

  const appDoc = await MakoApp.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!appDoc) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "App not found",
    };
  }
  const binding = appDoc.dataBindings.find(b => b.id === bindingId);
  if (!binding) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "Binding not found",
    };
  }
  if (binding.materialization !== "parquet") {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "Binding is not configured for parquet materialization",
    };
  }

  // Validate the query up front so obvious failures (unsupported language,
  // unsafe SQL, broken dbt link) are reported synchronously instead of from
  // the background run.
  let executableQuery: string;
  try {
    executableQuery = await buildExecutableQuery(binding, workspaceId);
  } catch (error) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: error instanceof Error ? error.message : "Invalid binding query",
    };
  }

  // Hash the RESOLVED query so re-pointing the dbt prod environment at a new
  // schema is a cache miss (the artifact must be rebuilt from the new schema).
  const definitionHash = buildAppBindingDefinitionHash({
    ...bindingHashFields(binding),
    code: executableQuery,
  });
  const artifactKey = buildAppBindingArtifactKey({
    workspaceId,
    appId,
    bindingId,
    definitionHash,
  });

  // Cache hit — reuse the existing artifact without queueing anything.
  if (
    !force &&
    binding.cache?.parquetArtifactKey === artifactKey &&
    binding.cache?.definitionHash === definitionHash &&
    binding.cache?.parquetBuildStatus === "ready" &&
    (await artifactExists(artifactKey))
  ) {
    return {
      bindingId,
      status: "ready",
      queued: false,
      rowCount: binding.cache?.rowCount,
      byteSize: binding.cache?.byteSize,
      artifactRevision: binding.cache?.artifactRevision,
    };
  }

  if (isAppBindingBuildActive(binding.cache)) {
    return {
      bindingId,
      status:
        binding.cache?.parquetBuildStatus === "building"
          ? "building"
          : "queued",
      queued: false,
      alreadyRunning: true,
    };
  }

  // Atomically claim the binding: only one caller can flip it to "queued"
  // unless the previous build's heartbeat has gone stale.
  const staleCutoff = new Date(Date.now() - BUILD_STALE_THRESHOLD_MS);
  const claim = await MakoApp.updateOne(
    {
      _id: appDoc._id,
      dataBindings: {
        $elemMatch: {
          id: bindingId,
          $or: [
            { "cache.parquetBuildStatus": { $nin: ["queued", "building"] } },
            { "cache.parquetBuildStatusAt": { $lt: staleCutoff } },
            { "cache.parquetBuildStatusAt": null },
          ],
        },
      },
    },
    {
      $set: {
        "dataBindings.$.cache.parquetBuildStatus": "queued",
        "dataBindings.$.cache.parquetBuildStatusAt": new Date(),
        "dataBindings.$.cache.parquetLastError": null,
      },
    },
  );
  if (claim.modifiedCount === 0) {
    return { bindingId, status: "queued", queued: false, alreadyRunning: true };
  }

  const eventData = {
    workspaceId,
    appId,
    bindingId,
    force: force === true,
    dedupeKey: `${appId}:${bindingId}`,
  };
  try {
    await inngest.send({ name: "app/binding.materialize", data: eventData });
  } catch (error) {
    // Inngest unavailable — fall back to an in-process background build so
    // materialization still completes. The request never blocks on it.
    logger.warn(
      "Failed to enqueue app binding materialization; running in-process",
      { workspaceId, appId, bindingId, error },
    );
    void materializeAppBinding({ workspaceId, appId, bindingId, force }).catch(
      err => {
        logger.error("In-process app binding materialization failed", {
          workspaceId,
          appId,
          bindingId,
          error: err,
        });
      },
    );
  }

  logger.info("Queued app binding materialization", {
    workspaceId,
    appId,
    bindingId,
    force: force === true,
  });
  return { bindingId, status: "queued", queued: true };
}

// SQL and MongoDB bindings execute their raw code. App bindings store the query
// as a single string (no structured collection/operation metadata), so a
// MongoDB binding's `code` is a JS shell query (e.g. `db.users.aggregate([...])`)
// that runs through the same streaming/execution path as live mode.
//
// dbt-linked bindings resolve their `{{ dbt_schema }}` token against the
// project's PROD-like environment first — materialized artifacts always
// contain production data, never a developer's preview schema.
//
// The binding code is user/agent-editable; the shared read-only safety gate
// (a SQL analyzer, also enforced inside the build core) is applied here too so
// queue-time validation reports unsafe SQL synchronously. It is intentionally
// skipped for non-SQL sources (see `assertReadOnlyMaterializationQuery`).
async function buildExecutableQuery(
  binding: IMakoAppDataBinding,
  workspaceId: string | Types.ObjectId,
): Promise<string> {
  if (binding.language !== "sql" && binding.language !== "mongodb") {
    throw new Error(
      `Materialization is not supported for ${binding.language} bindings yet`,
    );
  }
  const { resolveDbtBoundCode } = await import(
    "../dbt/dbt-environments.service"
  );
  const code = await resolveDbtBoundCode({
    workspaceId,
    dbtProjectId: binding.dbtProjectId,
    code: binding.code,
  });
  assertReadOnlyMaterializationQuery(
    code,
    binding.language === "mongodb" ? "mongodb" : undefined,
  );
  return code;
}

/**
 * SQL probes execute the query with `LIMIT 1`, so a probe failure means the SQL
 * itself is broken (fail fast). MongoDB has no reliable schema probe, so fall
 * back to runtime column inference — matching the dashboard pipeline.
 */
function schemaProbeMode(binding: IMakoAppDataBinding): "strict" | "lenient" {
  return binding.language === "sql" ? "strict" : "lenient";
}

/**
 * Materialize one binding to Parquet and persist its cache metadata. Returns
 * the resulting status. Concurrent builds of the same artifact are de-duped via
 * the shared build lock.
 */
export async function materializeAppBinding(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  force?: boolean;
}): Promise<AppBindingMaterializationStatus> {
  const { workspaceId, appId, bindingId, force } = input;

  const appDoc = await MakoApp.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!appDoc) {
    return { bindingId, status: "error", error: "App not found" };
  }
  const binding = appDoc.dataBindings.find(b => b.id === bindingId);
  if (!binding) {
    return { bindingId, status: "error", error: "Binding not found" };
  }
  if (binding.materialization !== "parquet") {
    return {
      bindingId,
      status: "error",
      error: "Binding is not configured for parquet materialization",
    };
  }

  let executableQuery: string;
  try {
    executableQuery = await buildExecutableQuery(binding, workspaceId);
  } catch (error) {
    return {
      bindingId,
      status: "error",
      error: error instanceof Error ? error.message : "Invalid binding query",
    };
  }

  const definitionHash = buildAppBindingDefinitionHash({
    ...bindingHashFields(binding),
    code: executableQuery,
  });
  const artifactKey = buildAppBindingArtifactKey({
    workspaceId,
    appId,
    bindingId,
    definitionHash,
  });

  return withArtifactBuildLock(artifactKey, async () => {
    // Cache hit — reuse existing artifact.
    if (
      !force &&
      binding.cache?.parquetArtifactKey === artifactKey &&
      binding.cache?.definitionHash === definitionHash &&
      binding.cache?.parquetBuildStatus === "ready" &&
      (await artifactExists(artifactKey))
    ) {
      return {
        bindingId,
        status: "ready" as const,
        rowCount: binding.cache?.rowCount,
        byteSize: binding.cache?.byteSize,
        artifactRevision: binding.cache?.artifactRevision,
      };
    }

    await MakoApp.updateOne(
      { _id: appDoc._id, "dataBindings.id": bindingId },
      {
        $set: {
          "dataBindings.$.cache.parquetBuildStatus": "building",
          "dataBindings.$.cache.parquetBuildStatusAt": new Date(),
          "dataBindings.$.cache.parquetLastError": null,
        },
      },
    );

    // Heartbeat while the build runs so stuck "building" states are
    // detectable: if the worker dies, the heartbeat stops and the status is
    // treated as stale (reclaimable + reported as an error to pollers).
    const heartbeat = setInterval(() => {
      void MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $set: { "dataBindings.$.cache.parquetBuildStatusAt": new Date() },
        },
      ).catch(() => undefined);
    }, BUILD_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const startedAt = Date.now();
    const recordRun = async (run: {
      status: "ready" | "error";
      rowCount?: number;
      byteSize?: number;
      error?: string;
    }) => {
      // Newest first, keep the last 20 runs.
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $push: {
            "dataBindings.$.cache.history": {
              $each: [
                { ...run, at: new Date(), durationMs: Date.now() - startedAt },
              ],
              $position: 0,
              $slice: 20,
            },
          },
        },
      );
    };

    try {
      const connection = await DatabaseConnection.findById(
        binding.connectionId,
      );
      if (!connection) throw new Error("Connection not found");

      // Shared core: schema probe + streaming + Parquet build + upload.
      // SQL uses a strict probe (a failure means the query is broken, so fail
      // fast); MongoDB has no reliable probe and falls back to runtime column
      // inference (lenient) — see schemaProbeMode.
      const parquet = await buildQueryParquetFile({
        connection,
        executableQuery,
        databaseId: binding.databaseId,
        databaseName: binding.databaseName,
        rowLimit: PARQUET_ROW_LIMIT,
        filenameBase: `app-${appId}-${bindingId}`,
        schemaProbe: schemaProbeMode(binding),
      });
      await storeParquetArtifactFile({
        filePath: parquet.filePath,
        artifactKey,
        metadata: { appId, bindingId, definitionHash },
      });

      const builtAt = new Date();
      const artifactRevision = String(builtAt.getTime());
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $set: {
            "dataBindings.$.cache.parquetArtifactKey": artifactKey,
            "dataBindings.$.cache.definitionHash": definitionHash,
            "dataBindings.$.cache.artifactRevision": artifactRevision,
            "dataBindings.$.cache.rowCount": parquet.rowCount,
            "dataBindings.$.cache.byteSize": parquet.byteSize,
            "dataBindings.$.cache.parquetBuiltAt": builtAt,
            "dataBindings.$.cache.lastRefreshedAt": builtAt,
            "dataBindings.$.cache.parquetBuildStatus": "ready",
            "dataBindings.$.cache.parquetBuildStatusAt": builtAt,
            "dataBindings.$.cache.parquetLastError": null,
          },
        },
      );

      await recordRun({
        status: "ready",
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
      });

      // Bump the doc version + poke so open tabs refetch and load the fresh
      // artifact. Foreground callers (the agent tool, the browser's status
      // poller) converge on their own, but background builds — scheduled
      // refreshes and the serve route's missing-artifact self-heal — would
      // otherwise complete silently, leaving open tabs on the broken state.
      const bumped = await MakoApp.findByIdAndUpdate(
        appDoc._id,
        { $inc: { version: 1 } },
        { new: true },
      );
      publishRealtimeEvent(workspaceId, {
        type: "app.updated",
        appId,
        version: bumped?.version ?? appDoc.version + 1,
        updatedBy: "system",
        origin: "save",
      });

      logger.info("Materialized app binding", {
        workspaceId,
        appId,
        bindingId,
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
      });

      return {
        bindingId,
        status: "ready" as const,
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
        artifactRevision,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Materialization failed";
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $set: {
            "dataBindings.$.cache.parquetBuildStatus": "error",
            "dataBindings.$.cache.parquetBuildStatusAt": new Date(),
            "dataBindings.$.cache.parquetLastError": message,
          },
        },
      );
      await recordRun({ status: "error", error: message });
      logger.error("Failed to materialize app binding", {
        workspaceId,
        appId,
        bindingId,
        error: message,
      });
      return { bindingId, status: "error" as const, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  });
}

/** Resolve a binding's stored artifact key (for the serve route). */
export function getBindingArtifactInfo(
  app: IMakoApp,
  bindingId: string,
  environment?: string,
): {
  artifactKey: string;
  rowCount?: number;
  revision?: string;
  sourceSchema?: string;
} | null {
  const binding = app.dataBindings.find(b => b.id === bindingId);
  if (!binding?.cache) return null;

  let artifactKey: string | undefined;
  let rowCount: number | undefined;
  let revision: string | undefined;
  let sourceSchema: string | undefined;

  if (environment && binding.cache.environments?.[environment]) {
    const envArtifact = binding.cache.environments[environment];
    artifactKey = envArtifact.artifactKey;
    rowCount = envArtifact.rowCount;
    revision = envArtifact.artifactRevision;
    sourceSchema = envArtifact.sourceSchema;
  } else if (!environment) {
    artifactKey = binding.cache.parquetArtifactKey;
    rowCount = binding.cache.rowCount;
    revision = binding.cache.artifactRevision;
  }

  if (!artifactKey) return null;
  return { artifactKey, rowCount, revision, sourceSchema };
}

/**
 * Build an executable query for a specific dbt environment (for environment-specific materialization).
 */
async function buildExecutableQueryForEnvironment(
  binding: IMakoAppDataBinding,
  workspaceId: string | Types.ObjectId,
  environment?: string,
): Promise<string> {
  if (binding.language !== "sql" && binding.language !== "mongodb") {
    throw new Error(
      `Materialization is not supported for ${binding.language} bindings yet`,
    );
  }
  const { resolveDbtBoundCode } = await import(
    "../dbt/dbt-environments.service"
  );
  const code = await resolveDbtBoundCode({
    workspaceId,
    dbtProjectId: binding.dbtProjectId,
    code: binding.code,
    environment,
  });
  assertReadOnlyMaterializationQuery(
    code,
    binding.language === "mongodb" ? "mongodb" : undefined,
  );
  return code;
}

/**
 * Queue an environment-specific materialization (dev, staging, etc). Works like
 * queueAppBindingMaterialization but materializes to a per-environment artifact
 * that is stored in binding.cache.environments[environment] instead of the
 * root cache (prod). Environment artifacts are preview-scoped and never served
 * to published/shared viewers.
 *
 * When environment is not provided, defaults to prod and uses the legacy behavior.
 */
export async function queueAppBindingMaterializationForEnvironment(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  environment?: string;
  force?: boolean;
}): Promise<AppBindingQueueResult> {
  const { workspaceId, appId, bindingId, environment, force } = input;

  const appDoc = await MakoApp.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!appDoc) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "App not found",
    };
  }
  const binding = appDoc.dataBindings.find(b => b.id === bindingId);
  if (!binding) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "Binding not found",
    };
  }
  if (binding.materialization !== "parquet") {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: "Binding is not configured for parquet materialization",
    };
  }

  // For non-environment builds or prod environment, use legacy path
  if (!environment) {
    return queueAppBindingMaterialization({
      workspaceId,
      appId,
      bindingId,
      force,
    });
  }

  try {
    assertSafeEnvironmentName(environment);
  } catch (error) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: error instanceof Error ? error.message : "Invalid environment",
    };
  }

  // Validate the query for the specified environment
  let executableQuery: string;
  try {
    executableQuery = await buildExecutableQueryForEnvironment(
      binding,
      workspaceId,
      environment,
    );
  } catch (error) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: error instanceof Error ? error.message : "Invalid binding query",
    };
  }

  // Hash includes environment for cache invalidation
  const definitionHash = buildAppBindingDefinitionHash({
    ...bindingHashFields(binding),
    code: executableQuery,
  });
  const artifactKey = buildAppBindingArtifactKey({
    workspaceId,
    appId,
    bindingId,
    definitionHash,
    environment,
  });

  // Environment cache hit
  const envCache = (binding.cache?.environments ?? {})[environment];
  if (
    !force &&
    envCache?.artifactKey === artifactKey &&
    envCache?.definitionHash === definitionHash &&
    envCache?.status === "ready" &&
    (await artifactExists(artifactKey))
  ) {
    return {
      bindingId,
      status: "ready",
      queued: false,
      rowCount: envCache?.rowCount,
      byteSize: envCache?.byteSize,
      artifactRevision: envCache?.artifactRevision,
    };
  }

  // Already building this environment artifact
  if (isEnvironmentBuildActive(envCache)) {
    return {
      bindingId,
      status: envCache?.status === "building" ? "building" : "queued",
      queued: false,
      alreadyRunning: true,
    };
  }

  // Atomically claim THIS environment: the guard lives in the filter (like the
  // prod path) so only one caller can flip it to "queued" unless the previous
  // build's heartbeat went stale. Writing narrow dotted paths — rather than
  // replacing the whole `environments` map — keeps concurrent builds for other
  // environments from clobbering each other, and preserves the currently-ready
  // artifact's metadata so the preview keeps working while a rebuild runs.
  const staleCutoff = new Date(Date.now() - BUILD_STALE_THRESHOLD_MS);
  const statusPath = `cache.environments.${environment}.status`;
  const statusAtPath = `cache.environments.${environment}.statusAt`;
  const claim = await MakoApp.updateOne(
    {
      _id: appDoc._id,
      dataBindings: {
        $elemMatch: {
          id: bindingId,
          $or: [
            { [statusPath]: { $nin: ["queued", "building"] } },
            { [statusAtPath]: { $lt: staleCutoff } },
            { [statusAtPath]: null },
          ],
        },
      },
    },
    {
      $set: {
        [envCachePath(environment, "status")]: "queued",
        [envCachePath(environment, "statusAt")]: new Date(),
        [envCachePath(environment, "error")]: null,
      },
    },
  );
  if (claim.modifiedCount === 0) {
    return { bindingId, status: "queued", queued: false, alreadyRunning: true };
  }

  const eventData = {
    workspaceId,
    appId,
    bindingId,
    environment,
    force: force === true,
    dedupeKey: `${appId}:${bindingId}:${environment}`,
  };
  try {
    await inngest.send({ name: "app/binding.materialize", data: eventData });
  } catch (error) {
    logger.warn(
      "Failed to enqueue environment-specific app binding materialization; running in-process",
      { workspaceId, appId, bindingId, environment, error },
    );
    void materializeAppBindingForEnvironment({
      workspaceId,
      appId,
      bindingId,
      environment,
      force,
    }).catch(err => {
      logger.error("In-process environment materialization failed", {
        workspaceId,
        appId,
        bindingId,
        environment,
        error: err,
      });
    });
  }

  logger.info("Queued environment-specific app binding materialization", {
    workspaceId,
    appId,
    bindingId,
    environment,
    force: force === true,
  });
  return { bindingId, status: "queued", queued: true };
}

/**
 * Materialize a binding for a specific environment to Parquet. Stores result
 * in binding.cache.environments[environment] instead of root cache.
 */
export async function materializeAppBindingForEnvironment(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  environment?: string;
  force?: boolean;
}): Promise<AppBindingMaterializationStatus> {
  const { workspaceId, appId, bindingId, environment, force } = input;

  // Fallback to legacy path for non-environment builds
  if (!environment) {
    return materializeAppBinding({ workspaceId, appId, bindingId, force });
  }

  try {
    assertSafeEnvironmentName(environment);
  } catch (error) {
    return {
      bindingId,
      status: "error",
      error: error instanceof Error ? error.message : "Invalid environment",
    };
  }

  const appDoc = await MakoApp.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!appDoc) {
    return { bindingId, status: "error", error: "App not found" };
  }
  const binding = appDoc.dataBindings.find(b => b.id === bindingId);
  if (!binding) {
    return { bindingId, status: "error", error: "Binding not found" };
  }
  if (binding.materialization !== "parquet") {
    return {
      bindingId,
      status: "error",
      error: "Binding is not configured for parquet materialization",
    };
  }

  let executableQuery: string;
  try {
    executableQuery = await buildExecutableQueryForEnvironment(
      binding,
      workspaceId,
      environment,
    );
  } catch (error) {
    return {
      bindingId,
      status: "error",
      error: error instanceof Error ? error.message : "Invalid binding query",
    };
  }

  const definitionHash = buildAppBindingDefinitionHash({
    ...bindingHashFields(binding),
    code: executableQuery,
  });
  const artifactKey = buildAppBindingArtifactKey({
    workspaceId,
    appId,
    bindingId,
    definitionHash,
    environment,
  });

  // Resolve schema for provenance tracking
  let sourceSchema: string | undefined;
  if (binding.dbtProjectId) {
    const { resolveDbtSchemaForBinding } = await import(
      "../dbt/dbt-environments.service"
    );
    const schemaInfo = await resolveDbtSchemaForBinding({
      workspaceId,
      dbtProjectId: binding.dbtProjectId,
      environmentName: environment,
    });
    sourceSchema = schemaInfo?.schema;
  }

  return withArtifactBuildLock(artifactKey, async () => {
    const envCache = binding.cache?.environments?.[environment];

    // Cache hit — reuse the existing environment artifact.
    if (
      !force &&
      envCache?.artifactKey === artifactKey &&
      envCache?.definitionHash === definitionHash &&
      envCache?.status === "ready" &&
      (await artifactExists(artifactKey))
    ) {
      return {
        bindingId,
        status: "ready" as const,
        rowCount: envCache.rowCount,
        byteSize: envCache.byteSize,
        artifactRevision: envCache.artifactRevision,
      };
    }

    await MakoApp.updateOne(
      { _id: appDoc._id, "dataBindings.id": bindingId },
      {
        $set: {
          [envCachePath(environment, "status")]: "building",
          [envCachePath(environment, "statusAt")]: new Date(),
          [envCachePath(environment, "error")]: null,
        },
      },
    );

    // Heartbeat so a dead worker's "building" state goes stale and becomes
    // reclaimable, independently of every other environment's build.
    const heartbeat = setInterval(() => {
      void MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        { $set: { [envCachePath(environment, "statusAt")]: new Date() } },
      ).catch(() => undefined);
    }, BUILD_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const startedAt = Date.now();
    const recordRun = async (run: {
      status: "ready" | "error";
      rowCount?: number;
      byteSize?: number;
      error?: string;
    }) => {
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $push: {
            [envCachePath(environment, "history")]: {
              $each: [
                { ...run, at: new Date(), durationMs: Date.now() - startedAt },
              ],
              $position: 0,
              $slice: 20,
            },
          },
        },
      );
    };

    try {
      const connection = await DatabaseConnection.findById(
        binding.connectionId,
      );
      if (!connection) throw new Error("Connection not found");

      const parquet = await buildQueryParquetFile({
        connection,
        executableQuery,
        databaseId: binding.databaseId,
        databaseName: binding.databaseName,
        rowLimit: PARQUET_ROW_LIMIT,
        filenameBase: `app-${appId}-${bindingId}-${environment}`,
        schemaProbe: schemaProbeMode(binding),
      });
      await storeParquetArtifactFile({
        filePath: parquet.filePath,
        artifactKey,
        metadata: { appId, bindingId, definitionHash, environment },
      });

      const builtAt = new Date();
      const artifactRevision = String(builtAt.getTime());
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $set: {
            [envCachePath(environment, "artifactKey")]: artifactKey,
            [envCachePath(environment, "definitionHash")]: definitionHash,
            [envCachePath(environment, "artifactRevision")]: artifactRevision,
            [envCachePath(environment, "rowCount")]: parquet.rowCount,
            [envCachePath(environment, "byteSize")]: parquet.byteSize,
            [envCachePath(environment, "builtAt")]: builtAt,
            [envCachePath(environment, "sourceSchema")]: sourceSchema,
            [envCachePath(environment, "status")]: "ready",
            [envCachePath(environment, "statusAt")]: builtAt,
            [envCachePath(environment, "error")]: null,
          },
        },
      );
      await recordRun({
        status: "ready",
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
      });

      // Poke open editors so they refetch and pick up the new artifact URL.
      const bumped = await MakoApp.findByIdAndUpdate(
        appDoc._id,
        { $inc: { version: 1 } },
        { new: true },
      );
      publishRealtimeEvent(workspaceId, {
        type: "app.updated",
        appId,
        version: bumped?.version ?? appDoc.version + 1,
        updatedBy: "system",
        origin: "save",
      });

      logger.info("Materialized app binding for environment", {
        workspaceId,
        appId,
        bindingId,
        environment,
        sourceSchema,
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
      });

      return {
        bindingId,
        status: "ready" as const,
        rowCount: parquet.rowCount,
        byteSize: parquet.byteSize,
        artifactRevision,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Materialization failed";
      await MakoApp.updateOne(
        { _id: appDoc._id, "dataBindings.id": bindingId },
        {
          $set: {
            [envCachePath(environment, "status")]: "error",
            [envCachePath(environment, "statusAt")]: new Date(),
            [envCachePath(environment, "error")]: message,
          },
        },
      );
      await recordRun({ status: "error", error: message });
      logger.error("Failed to materialize app binding for environment", {
        workspaceId,
        appId,
        bindingId,
        environment,
        error: message,
      });
      return { bindingId, status: "error" as const, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  });
}
