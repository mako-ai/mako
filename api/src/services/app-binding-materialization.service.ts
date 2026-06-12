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

import { promises as fsPromises } from "fs";
import { Types } from "mongoose";
import {
  MakoApp,
  DatabaseConnection,
  type IMakoApp,
  type IMakoAppDataBinding,
} from "../database/workspace-schema";
import {
  buildParquetFromBatches,
  type FieldMeta,
} from "../utils/streaming-parquet-builder";
import {
  storeArtifact,
  artifactExists,
  withArtifactBuildLock,
} from "./dashboard-cache.service";
import { databaseConnectionService } from "./database-connection.service";
import { checkPreviewQuerySafety } from "./query-pagination.service";
import { inngest } from "../inngest/client";
import { loggers } from "../logging";

const logger = loggers.api("app-materialization");

const PARQUET_ROW_LIMIT = 500_000;

/** How often a running build refreshes its heartbeat (`parquetBuildStatusAt`). */
const BUILD_HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * A queued/building status with a heartbeat older than this is considered
 * stale (the worker crashed or was redeployed mid-build) and may be re-queued.
 */
export const BUILD_STALE_THRESHOLD_MS = 3 * 60 * 1000;

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

/** Stable hash of a binding's query definition; changing it invalidates cache. */
export function buildAppBindingDefinitionHash(
  binding: Pick<
    IMakoAppDataBinding,
    "connectionId" | "language" | "code" | "databaseId" | "databaseName"
  >,
): string {
  const payload = JSON.stringify({
    connectionId: String(binding.connectionId),
    language: binding.language,
    code: binding.code,
    databaseId: binding.databaseId ?? null,
    databaseName: binding.databaseName ?? null,
  });
  // djb2 — matches the lightweight (non-crypto) hashing used for dashboards.
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 33) ^ payload.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/** Object-store key prefix, shared with the dashboard artifact bucket. */
function artifactPrefix(): string {
  if (process.env.DASHBOARD_ARTIFACT_PREFIX) {
    return process.env.DASHBOARD_ARTIFACT_PREFIX;
  }
  if (process.env.PR_NUMBER) {
    return `dashboard-artifacts/pr-${process.env.PR_NUMBER}`;
  }
  if (process.env.NODE_ENV === "production") {
    return "dashboard-artifacts/prod";
  }
  return "dashboards";
}

export function buildAppBindingArtifactKey(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  definitionHash: string;
}): string {
  return `${artifactPrefix()}/workspaces/${input.workspaceId}/apps/${input.appId}/bindings/${input.bindingId}/${input.definitionHash}.parquet`;
}

/** Proxied API path the browser fetches to read a binding's Parquet artifact. */
export function buildAppBindingArtifactPath(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  revision?: string | null;
}): string {
  const base = `/api/workspaces/${input.workspaceId}/apps/${input.appId}/bindings/${input.bindingId}/materialization/artifact`;
  return input.revision
    ? `${base}?rev=${encodeURIComponent(input.revision)}`
    : base;
}

/**
 * Hydrate `cache.parquetUrl` for every ready, materialized binding on a
 * serialized app object. Pure (string building) — no store calls.
 */
export function hydrateAppBindingUrls(app: {
  _id: string;
  workspaceId: string;
  dataBindings?: Array<Record<string, any>>;
}): typeof app {
  if (!Array.isArray(app.dataBindings)) return app;
  for (const binding of app.dataBindings) {
    const cache = binding.cache;
    if (cache?.parquetArtifactKey && cache.parquetBuildStatus === "ready") {
      cache.parquetUrl = buildAppBindingArtifactPath({
        workspaceId: app.workspaceId,
        appId: app._id,
        bindingId: binding.id,
        revision: cache.artifactRevision || undefined,
      });
    }
  }
  return app;
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
} | null {
  const binding = app.dataBindings.find(b => b.id === bindingId);
  if (!binding) return null;
  const cache = binding.cache;
  const rawStatus = cache?.parquetBuildStatus ?? "missing";
  const inFlight = rawStatus === "queued" || rawStatus === "building";
  const stale = inFlight && !isAppBindingBuildActive(cache);
  return {
    bindingId,
    materialization: binding.materialization,
    status: stale ? "error" : rawStatus,
    error: stale
      ? "Materialization stalled (worker stopped reporting progress). Re-run materialize to retry."
      : cache?.parquetLastError,
    stale,
    rowCount: cache?.rowCount,
    byteSize: cache?.byteSize,
    artifactRevision: cache?.artifactRevision,
    lastRefreshedAt: cache?.lastRefreshedAt,
    parquetBuiltAt: cache?.parquetBuiltAt,
    updatedAt: cache?.parquetBuildStatusAt,
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
  // unsafe SQL) are reported synchronously instead of from the background run.
  try {
    buildExecutableQuery(binding);
  } catch (error) {
    return {
      bindingId,
      status: "error",
      queued: false,
      error: error instanceof Error ? error.message : "Invalid binding query",
    };
  }

  const definitionHash = buildAppBindingDefinitionHash(binding);
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

// SQL-family bindings execute the raw code. (MongoDB materialization would need
// collection/operation metadata; not supported yet.)
//
// The binding code is user/agent-editable, so enforce the same read-only
// safety gate as live preview execution: materialization must never run
// DDL/DML against the source connection.
function buildExecutableQuery(binding: IMakoAppDataBinding): string {
  if (binding.language !== "sql") {
    throw new Error(
      `Materialization is not supported for ${binding.language} bindings yet`,
    );
  }
  const safety = checkPreviewQuerySafety(binding.code);
  if (!safety.safe) {
    throw new Error(
      `Binding query failed read-only safety checks: ${safety.errors.join(" ")}`,
    );
  }
  return binding.code;
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

  const definitionHash = buildAppBindingDefinitionHash(binding);
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

      const executableQuery = buildExecutableQuery(binding);
      const fieldsResult =
        await databaseConnectionService.getStreamingQueryFields(
          connection,
          executableQuery,
          {
            databaseId: binding.databaseId,
            databaseName: binding.databaseName,
          },
        );
      const fields: FieldMeta[] = fieldsResult.fields ?? [];

      const parquet = await buildParquetFromBatches({
        filenameBase: `app-${appId}-${bindingId}`,
        rowLimit: PARQUET_ROW_LIMIT,
        fields,
        streamBatches: async insertBatch => {
          await databaseConnectionService.executeStreamingQuery(
            connection,
            executableQuery,
            {
              batchSize: 5000,
              databaseId: binding.databaseId,
              databaseName: binding.databaseName,
              onBatch: insertBatch,
            },
          );
        },
      });

      await storeArtifact(parquet.filePath, artifactKey, {
        appId,
        bindingId,
        definitionHash,
      });
      await fsPromises.rm(parquet.filePath, { force: true });

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
): { artifactKey: string; rowCount?: number; revision?: string } | null {
  const binding = app.dataBindings.find(b => b.id === bindingId);
  if (!binding?.cache?.parquetArtifactKey) return null;
  return {
    artifactKey: binding.cache.parquetArtifactKey,
    rowCount: binding.cache.rowCount,
    revision: binding.cache.artifactRevision,
  };
}
