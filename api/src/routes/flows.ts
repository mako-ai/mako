import { createRoute, z } from "@hono/zod-openapi";
import { findInWorkspace } from "./lib/load-resource";
import {
  Flow,
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  Connector as DataSource,
  DatabaseConnection,
  FlowExecution,
  WebhookEvent,
  type IFlow,
} from "../database/workspace-schema";
import {
  deriveFlowDisplayName,
  reserveFlowSlug,
} from "../services/flow-identity.service";
import {
  commitFlowFile,
  deleteFlowFile,
} from "../services/flow-config.service";
import { Types, PipelineStage } from "mongoose";
import { inngest } from "../inngest";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  validateQuery,
  checkQuerySafety,
  dryRunDbSync,
} from "../services/destination-writer.service";
import { teardownFlow } from "../sync-cdc/flow-reconcile";
import { RepoRequiredError, appsRequireConnectedRepo } from "../apps/config";
import { resolveMirrorTarget } from "../apps/cloud-repo.service";
import { cdcBackfillService } from "../sync-cdc/backfill";
import { syncMachineService } from "../sync-cdc/sync-state";
import { databaseRegistry } from "../databases/registry";
import { cdcLiveTableName, cdcStageTableName } from "../sync-cdc/normalization";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import {
  computeEntityPendingBacklog,
  computeEntitySeqGap,
  computePendingLagSeconds,
} from "../sync-cdc/backlog";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import { databaseConnectionService } from "../services/database-connection.service";
import { mapLogicalTypeToBigQuery } from "../sync-cdc/adapters/bigquery";
import {
  hasCdcDestinationAdapter,
  supportedCdcWriteModes,
} from "../sync-cdc/adapters/registry";
import { resolveDefaultSyncEngine } from "../services/flow-triggers.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { connectorRegistry } from "../connectors/registry";
import {
  validateSyncConfig,
  type IncrementalCapabilities,
} from "@mako/schemas";

/** `findOne({ _id, workspaceId })` for flows — was written inline sixteen times. */
const findFlow = findInWorkspace(Flow);

const logger = loggers.inngest("flow");

/**
 * RFC #904 decision 1: a connected repo is REQUIRED for flows.
 *
 * `flows/<slug>.yml` is the definition, so a workspace without a repo has
 * nowhere durable to keep one — there is no Mongo fallback and no second
 * definition path. Flows follow consoles and dbt into `RepoRequiredError`
 * rather than silently writing a definition that only exists in a database
 * (apps.md §17).
 *
 * Deciding it now costs one workspace's configuration — ours, which has a
 * repo — and stops being free the moment flows have external users. That is
 * the opposite of the position consoles were in when they hit this.
 */
async function assertFlowRepo(workspaceId: string): Promise<void> {
  if (!appsRequireConnectedRepo()) return;
  if (!(await resolveMirrorTarget(workspaceId))) throw new RepoRequiredError();
}

/** 412 with the actionable message, as consoles and the prompt already do. */
function repoRequired(c: AuthenticatedContext, error: RepoRequiredError) {
  return c.json(
    { success: false, code: error.code, error: error.message },
    error.status as 412,
  );
}
export const flowRoutes = createRouter();

type RequestContextLike = {
  req: {
    url: string;
    header: (name: string) => string | undefined;
  };
};

function getRequestBaseUrl(c: RequestContextLike): string {
  const requestUrl = new URL(c.req.url);
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwardedHost || c.req.header("host"))?.split(",")[0]?.trim();
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProto || requestUrl.protocol.replace(":", "");

  if (host) {
    return `${protocol}://${host}`;
  }

  return requestUrl.origin;
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }

  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const secondOctet = Number(match172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function resolveWebhookBaseUrl(
  c: RequestContextLike,
  preferredBaseUrl?: string,
): string {
  if (preferredBaseUrl) {
    try {
      return new URL(preferredBaseUrl).origin;
    } catch {
      // Ignore invalid preferred URL and fall back to inferred values.
    }
  }

  const requestBaseUrl = getRequestBaseUrl(c);
  try {
    const parsedRequestBase = new URL(requestBaseUrl);
    if (!isLoopbackOrPrivateHostname(parsedRequestBase.hostname)) {
      return parsedRequestBase.origin;
    }
  } catch {
    // Fall through to env candidates.
  }

  const envCandidates = [
    process.env.WEBHOOK_PUBLIC_BASE_URL,
    process.env.PUBLIC_URL,
    process.env.API_BASE_URL,
    process.env.BASE_URL,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of envCandidates) {
    try {
      const parsed = new URL(candidate);
      if (!isLoopbackOrPrivateHostname(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // Ignore invalid env URL candidate and keep checking.
    }
  }

  return requestBaseUrl;
}

const DESTINATION_COUNT_CACHE_TTL_MS = 60_000;
const destinationCountBatchCache = new Map<
  string,
  { value: Record<string, number | null>; expiresAt: number }
>();

function escapePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escapeBigQueryPath(path: string): string {
  return `\`${path.replace(/`/g, "\\`")}\``;
}

function isSafeSqlIdentifier(identifier: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier);
}

function isTableMissingError(errorMessage?: string): boolean {
  const value = String(errorMessage || "").toLowerCase();
  const isPostgresMissingRelation =
    value.includes("relation") && value.includes("does not exist");
  return (
    value.includes("not found") ||
    value.includes("does not exist") ||
    value.includes("unknown table") ||
    isPostgresMissingRelation ||
    value.includes("no such table")
  );
}

async function getDestinationEntityRowCountsBatch(params: {
  workspaceId: string;
  flowId: string;
  entities: string[];
  destinationType?: string;
  destination: any;
  schema: string;
  baseTablePrefix?: string;
}): Promise<Record<string, number | null>> {
  const sortedEntities = [...params.entities].sort();
  const cacheKey = [
    params.workspaceId,
    params.flowId,
    params.destinationType || "",
    params.schema,
    params.baseTablePrefix || "",
    String((params.destination as any)?.connection?.project_id || ""),
    sortedEntities.join("|"),
  ].join(":");
  const cached = destinationCountBatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const empty: Record<string, number | null> = {};
  for (const entity of params.entities) empty[entity] = null;

  if (params.entities.length === 0) {
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }

  // Map each entity to its destination table name, keep both directions.
  const tableToEntity = new Map<string, string>();
  const tableNames: string[] = [];
  for (const entity of params.entities) {
    const tableName = cdcLiveTableName(
      params.baseTablePrefix,
      entity,
      params.flowId,
    );
    tableToEntity.set(tableName, entity);
    tableNames.push(tableName);
  }

  const driver = databaseRegistry.getDriver(params.destination.type);
  const query = driver?.buildRowCountBatchQuery?.(params.schema, tableNames, {
    projectId: (params.destination as any)?.connection?.project_id,
  });
  if (!driver?.executeQuery || !query) {
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }

  // Default everything to 0 — if a table doesn't appear in __TABLES__/pg_class,
  // it doesn't exist yet, which is semantically the same as "0 rows".
  const result: Record<string, number | null> = {};
  for (const entity of params.entities) result[entity] = 0;

  // For MongoDB the tableDestination "schema" IS the target database name and
  // the count expression runs against the connection's active db, so it must
  // be routed explicitly. SQL engines fully qualify inside the query instead.
  const isMongoDestination =
    String(params.destination.type || "").toLowerCase() === "mongodb";

  try {
    const queryResult = await driver.executeQuery(
      params.destination,
      query,
      isMongoDestination ? { databaseName: params.schema } : undefined,
    );
    if (!queryResult.success) {
      if (isTableMissingError(queryResult.error)) {
        destinationCountBatchCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
        });
        return result;
      }
      logger.warn("Failed to count destination rows for CDC flow", {
        flowId: params.flowId,
        destinationType: params.destinationType,
        error: queryResult.error,
      });
      destinationCountBatchCache.set(cacheKey, {
        value: empty,
        expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
      });
      return empty;
    }

    if (Array.isArray(queryResult.data)) {
      for (const row of queryResult.data as Array<Record<string, unknown>>) {
        const tableId = String(row.table_id ?? row.tableId ?? "");
        const entity = tableToEntity.get(tableId);
        if (!entity) continue;
        const raw = row.row_count ?? row.rowCount ?? row.total_count;
        const parsed = Number(raw);
        result[entity] = Number.isFinite(parsed) ? parsed : null;
      }
    }

    destinationCountBatchCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return result;
  } catch (error) {
    logger.warn("Destination row count batch query errored", {
      flowId: params.flowId,
      destinationType: params.destinationType,
      error: error instanceof Error ? error.message : String(error),
    });
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }
}

// Apply unified auth middleware to all flow routes
flowRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
flowRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    // Validate ObjectId format early to return 400 instead of 500
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    } else {
      // Neither API key nor session auth succeeded - reject request
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

async function assertOwnerOrAdmin(
  c: AuthenticatedContext,
  workspaceId: string,
) {
  const user = c.get("user");
  if (!user) {
    return c.json(
      { success: false, error: "Owner/admin access requires user session" },
      403,
    );
  }

  const isOwnerOrAdmin = await workspaceService.hasRole(workspaceId, user.id, [
    "owner",
    "admin",
  ]);
  if (!isOwnerOrAdmin) {
    return c.json({ success: false, error: "Owner/admin role required" }, 403);
  }

  return null;
}

// GET /api/workspaces/:workspaceId/flows - List all flows
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Flows"],
    summary: "GET /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const sourceType = c.req.query("sourceType"); // Optional filter

      const pipeline: PipelineStage[] = [
        {
          $match: {
            workspaceId: new Types.ObjectId(workspaceId),
            ...(sourceType && { sourceType }),
          },
        },
        // Lookup for connector sources (optional)
        {
          $lookup: {
            from: "connectors",
            localField: "dataSourceId",
            foreignField: "_id",
            as: "dataSourceLookup",
          },
        },
        // Lookup for database sources (optional)
        {
          $lookup: {
            from: "databaseconnections",
            localField: "databaseSource.connectionId",
            foreignField: "_id",
            as: "databaseSourceLookup",
          },
        },
        // Lookup for destination database
        {
          $lookup: {
            from: "databaseconnections",
            localField: "destinationDatabaseId",
            foreignField: "_id",
            as: "destinationDatabaseLookup",
          },
        },
        // Lookup for table destination (optional)
        {
          $lookup: {
            from: "databaseconnections",
            localField: "tableDestination.connectionId",
            foreignField: "_id",
            as: "tableDestinationLookup",
          },
        },
        {
          $addFields: {
            // Normalize source info based on sourceType
            dataSourceId: {
              $cond: {
                if: { $eq: ["$sourceType", "database"] },
                then: { $arrayElemAt: ["$databaseSourceLookup", 0] },
                else: { $arrayElemAt: ["$dataSourceLookup", 0] },
              },
            },
            destinationDatabaseId: {
              $arrayElemAt: ["$destinationDatabaseLookup", 0],
            },
            tableDestinationConnection: {
              $arrayElemAt: ["$tableDestinationLookup", 0],
            },
          },
        },
        {
          $project: {
            _id: 1,
            workspaceId: 1,
            type: 1,
            name: 1,
            slug: 1,
            sourceType: { $ifNull: ["$sourceType", "connector"] },
            destinationDatabaseName: 1,
            schedule: 1,
            webhookConfig: 1,
            entityFilter: 1,
            queries: 1,
            syncMode: 1,
            writeMode: 1,
            backfillSchedule: 1,
            syncEngine: 1,
            syncState: 1,
            syncStateUpdatedAt: 1,
            syncStateMeta: 1,
            lastRunAt: 1,
            lastSuccessAt: 1,
            lastError: 1,
            nextRunAt: 1,
            runCount: 1,
            avgDurationMs: 1,
            createdBy: 1,
            createdAt: 1,
            updatedAt: 1,
            // Source info
            "dataSourceId._id": 1,
            "dataSourceId.name": 1,
            "dataSourceId.type": 1,
            // Database source details
            databaseSource: 1,
            // Destination info
            "destinationDatabaseId._id": 1,
            "destinationDatabaseId.name": 1,
            "destinationDatabaseId.type": 1,
            // Table destination details
            tableDestination: 1,
            "tableDestinationConnection._id": 1,
            "tableDestinationConnection.name": 1,
            "tableDestinationConnection.type": 1,
            // Database source specific config
            incrementalConfig: 1,
            conflictConfig: 1,
            batchSize: 1,
            entityLayouts: 1,
            deleteMode: 1,
          },
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
      ];

      const flows = await Flow.aggregate(pipeline);
      const requestBaseUrl = getRequestBaseUrl(c);
      const normalizedFlows = flows.map((flow: any) => {
        if (flow?.type !== "webhook" || !flow?._id) {
          return flow;
        }

        const endpoint = generateWebhookEndpoint(
          workspaceId as string,
          flow._id.toString(),
          requestBaseUrl,
        );

        return {
          ...flow,
          webhookConfig: {
            ...(flow.webhookConfig || {}),
            endpoint,
          },
        };
      });

      return c.json({
        success: true,
        data: normalizedFlows,
      });
    } catch (error) {
      logger.error("Error listing flows", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

/**
 * Validate an Airbyte-style write mode against the read mode, trigger set,
 * and destination capability. Returns an error string or null.
 */
function selectedEntitiesFromFlowBody(body: {
  entityFilter?: unknown;
  entityLayouts?: unknown;
}): string[] {
  const fromFilter = Array.isArray(body.entityFilter)
    ? body.entityFilter.map(String).filter(Boolean)
    : [];
  if (fromFilter.length > 0) return fromFilter;

  if (Array.isArray(body.entityLayouts)) {
    return body.entityLayouts
      .filter(
        (layout: { enabled?: boolean; entity?: string }) =>
          layout?.enabled !== false && typeof layout?.entity === "string",
      )
      .map((layout: { entity: string }) => layout.entity);
  }
  return [];
}

function resolveConnectorIncrementalCapabilities(
  dataSource:
    | { type?: string; config?: Record<string, unknown> }
    | null
    | undefined,
): IncrementalCapabilities | undefined {
  if (!dataSource?.type) return undefined;
  try {
    const connector = connectorRegistry.getConnector({
      id: "validation",
      name: dataSource.type,
      type: dataSource.type,
      config: dataSource.config || {},
    } as any);
    return connector?.getIncrementalCapabilities?.();
  } catch {
    const meta = connectorRegistry
      .getAllMetadata()
      .find(entry => entry.type === dataSource.type);
    return meta?.metadata?.incremental;
  }
}

/**
 * Write-mode + incremental-capability validation. Delegates to the shared
 * `@mako/schemas` matrix so SyncFlowForm and the API cannot drift.
 */
function validateWriteMode(params: {
  writeMode?: unknown;
  syncMode: string;
  destinationType?: string;
  syncEngine: string;
  webhookEnabled: boolean;
  selectedEntities?: string[];
  incremental?: IncrementalCapabilities;
  enforceIncrementalCapability?: boolean;
}): { error: string | null; warnings: string[] } {
  // Prefer the destination-adapter registry's supported modes when available
  // (keeps ClickHouse / new adapters honest), then fall through to the
  // shared pure validator for the rest of the rules.
  if (
    params.writeMode !== undefined &&
    params.writeMode !== null &&
    params.syncEngine === "cdc" &&
    params.writeMode !== "append_dedup"
  ) {
    const supported = supportedCdcWriteModes(params.destinationType);
    if (!supported.includes(params.writeMode as any)) {
      return {
        error: `writeMode '${params.writeMode}' is not supported by '${params.destinationType}' destinations (supported: ${supported.join(", ") || "none"})`,
        warnings: [],
      };
    }
  }

  return validateSyncConfig({
    syncMode: params.syncMode,
    writeMode: params.writeMode,
    syncEngine: params.syncEngine,
    destinationType: params.destinationType,
    webhookEnabled: params.webhookEnabled,
    selectedEntities: params.selectedEntities,
    incremental: params.incremental,
    enforceIncrementalCapability: params.enforceIncrementalCapability,
  });
}

// POST /api/workspaces/:workspaceId/flows - Create a new flow
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Flows"],
    summary: "POST /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      if (!workspaceId) {
        return c.json(
          { success: false, error: "Workspace ID is required" },
          400,
        );
      }
      // A flow's definition lives in the repo, so refuse before creating one
      // that would have nowhere durable to live (RFC #904 decision 1).
      await assertFlowRepo(workspaceId);
      // TODO: Get userId from authentication
      const userId = "system";
      const body = await c.req.json();

      // Validate required fields based on flow type and source type
      const flowType = body.type || "scheduled";
      const sourceType = body.sourceType || "connector";

      // Schedule cron required whenever a poll schedule is enabled,
      // regardless of flow type (unified trigger model).
      if (body.schedule?.enabled && !body.schedule?.cron) {
        return c.json(
          { success: false, error: "schedule.cron is required when enabled" },
          400,
        );
      }

      // Validate source configuration based on sourceType
      if (sourceType === "database") {
        // Database source validation
        if (!body.databaseSource?.connectionId) {
          return c.json(
            {
              success: false,
              error: "databaseSource.connectionId is required",
            },
            400,
          );
        }
        if (!body.databaseSource?.query) {
          return c.json(
            { success: false, error: "databaseSource.query is required" },
            400,
          );
        }

        // Validate query safety (read-only SELECT only)
        const safetyCheck = checkQuerySafety(body.databaseSource.query);
        if (!safetyCheck.safe) {
          return c.json(
            {
              success: false,
              error: `Unsafe query: ${safetyCheck.errors.join("; ")}`,
              safetyCheck,
            },
            400,
          );
        }

        // Validate source database connection exists and belongs to workspace
        const sourceDb = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.databaseSource.connectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });

        if (!sourceDb) {
          return c.json(
            { success: false, error: "Source database connection not found" },
            404,
          );
        }
      } else {
        // Connector source validation (default)
        if (!body.dataSourceId) {
          return c.json(
            { success: false, error: "dataSourceId is required" },
            400,
          );
        }

        // Validate data source exists and belongs to workspace
        const dataSource = await DataSource.findOne({
          _id: new Types.ObjectId(body.dataSourceId),
          workspaceId: new Types.ObjectId(workspaceId),
        });

        if (!dataSource) {
          return c.json(
            { success: false, error: "Data source not found" },
            404,
          );
        }
      }

      // Validate destination - either destinationDatabaseId or tableDestination
      let destinationDatabaseId: Types.ObjectId | undefined;
      let destinationType: string | undefined;

      if (body.tableDestination?.connectionId) {
        // Table destination validation
        const destDb = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.tableDestination.connectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });

        if (!destDb) {
          return c.json(
            {
              success: false,
              error: "Destination database connection not found",
            },
            404,
          );
        }

        // Use the table destination connection as the destinationDatabaseId
        destinationDatabaseId = new Types.ObjectId(
          body.tableDestination.connectionId,
        );
        destinationType = destDb.type;
      } else if (body.destinationDatabaseId) {
        // MongoDB destination validation
        const database = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.destinationDatabaseId),
          workspaceId: new Types.ObjectId(workspaceId),
        });

        if (!database) {
          return c.json(
            { success: false, error: "Destination database not found" },
            404,
          );
        }

        destinationDatabaseId = new Types.ObjectId(body.destinationDatabaseId);
        destinationType = database.type;
      } else {
        return c.json(
          {
            success: false,
            error: "destinationDatabaseId or tableDestination is required",
          },
          400,
        );
      }

      // Create flow with type-specific configuration
      const flowData: any = {
        workspaceId: new Types.ObjectId(workspaceId),
        type: flowType,
        sourceType,
        destinationDatabaseId,
        destinationDatabaseName:
          typeof body.destinationDatabaseName === "string" &&
          body.destinationDatabaseName.trim().length > 0
            ? body.destinationDatabaseName.trim()
            : undefined,
        syncMode: body.syncMode || "full",
        // Webhook flows run exclusively on the CDC engine (the legacy real-time
        // webhook pipeline has been decommissioned). Connector flows targeting
        // a CDC-capable table destination default to CDC too; everything else
        // keeps the legacy engine until the full sunset.
        syncEngine: resolveDefaultSyncEngine({
          flowType,
          sourceType,
          hasTableDestination: Boolean(body.tableDestination?.connectionId),
          destinationSupportsCdc: hasCdcDestinationAdapter(destinationType),
        }),
        writeMode: body.writeMode || "append_dedup",
        syncStateUpdatedAt: new Date(),
        enabled: true,
        createdBy: userId,
      };

      // Optional periodic full-backfill cadence (CDC flows only).
      if (
        (flowType === "webhook" || flowData.syncEngine === "cdc") &&
        body.backfillSchedule
      ) {
        const sched = body.backfillSchedule;
        const enabled = Boolean(sched.enabled);
        const cron = typeof sched.cron === "string" ? sched.cron.trim() : "";
        if (enabled && cron) {
          flowData.backfillSchedule = {
            enabled: true,
            cron,
            timezone:
              typeof sched.timezone === "string" && sched.timezone.trim()
                ? sched.timezone.trim()
                : "UTC",
          };
        }
      }

      // Add source-specific fields
      if (sourceType === "database") {
        flowData.databaseSource = {
          connectionId: new Types.ObjectId(body.databaseSource.connectionId),
          database: body.databaseSource.database,
          query: body.databaseSource.query,
        };

        // Database source specific config
        if (body.incrementalConfig) {
          flowData.incrementalConfig = body.incrementalConfig;
        }
        if (body.conflictConfig) {
          flowData.conflictConfig = {
            ...body.conflictConfig,
            // Normalize legacy "upsert" strategy to "update"
            strategy:
              body.conflictConfig.strategy === "upsert"
                ? "update"
                : body.conflictConfig.strategy,
          };
        }
        if (body.paginationConfig) {
          flowData.paginationConfig = body.paginationConfig;
        }
        if (body.typeCoercions) {
          flowData.typeCoercions = body.typeCoercions;
        }
        if (body.batchSize) {
          flowData.batchSize = Number(body.batchSize);
        }
      } else {
        flowData.dataSourceId = new Types.ObjectId(body.dataSourceId);
        flowData.entityFilter = body.entityFilter || [];
        // Ensure numeric fields in queries are properly typed
        flowData.queries = (body.queries || []).map((q: any) => ({
          ...q,
          batch_size: q.batch_size ? Number(q.batch_size) : undefined,
          batchSize: q.batchSize ? Number(q.batchSize) : undefined,
        }));
      }

      // Add table destination if specified
      if (body.tableDestination?.connectionId) {
        const td: any = {
          connectionId: new Types.ObjectId(body.tableDestination.connectionId),
          database: body.tableDestination.database,
          schema: body.tableDestination.schema,
          tableName: body.tableDestination.tableName || "",
          createIfNotExists: body.tableDestination.createIfNotExists !== false,
        };
        if (body.tableDestination.partitioning) {
          td.partitioning = body.tableDestination.partitioning;
        }
        if (body.tableDestination.clustering) {
          td.clustering = body.tableDestination.clustering;
        }
        flowData.tableDestination = td;
      }

      const destinationDriver = databaseRegistry.getDriver(
        destinationType ?? "",
      );
      if (
        flowData.syncEngine === "cdc" &&
        destinationDriver?.requiresSoftDeleteForCdc?.()
      ) {
        // Destination's CDC path relies on tombstones for correctness.
        flowData.deleteMode = "soft";
      } else if (body.deleteMode) {
        flowData.deleteMode = body.deleteMode;
      }
      if (body.entityLayouts && Array.isArray(body.entityLayouts)) {
        flowData.entityLayouts = body.entityLayouts;
      }

      if (flowType === "scheduled") {
        const scheduleEnabled = body.schedule?.enabled === true;
        flowData.schedule = {
          enabled: scheduleEnabled,
          cron: scheduleEnabled
            ? body.schedule?.cron || body.schedule
            : undefined,
          timezone: scheduleEnabled
            ? body.schedule?.timezone || body.timezone || "UTC"
            : undefined,
        };
      } else if (flowType === "webhook") {
        // Unified trigger model: a webhook flow may also carry a poll
        // schedule (hybrid trigger set). Persist it so the scheduler's
        // trigger-based selection picks it up.
        if (body.schedule?.enabled === true) {
          flowData.schedule = {
            enabled: true,
            cron: body.schedule?.cron,
            timezone: body.schedule?.timezone || body.timezone || "UTC",
          };
        }
        // Generate webhook configuration
        const requestBaseUrl = getRequestBaseUrl(c);
        const webhookEndpoint = generateWebhookEndpoint(
          workspaceId,
          new Types.ObjectId().toString(),
          requestBaseUrl,
        );
        // Webhook secret must be provided by the user (from Stripe/Close)
        const webhookSecret = body.webhookSecret || "";

        flowData.webhookConfig = {
          endpoint: webhookEndpoint,
          secret: webhookSecret,
          enabled: true,
        };
      }

      let createIncremental: IncrementalCapabilities | undefined;
      if (sourceType !== "database" && body.dataSourceId) {
        const ds = await DataSource.findById(body.dataSourceId)
          .select({ type: 1, config: 1 })
          .lean();
        createIncremental = resolveConnectorIncrementalCapabilities(ds as any);
      }
      const createValidation = validateWriteMode({
        writeMode: flowData.writeMode,
        syncMode: flowData.syncMode,
        destinationType,
        syncEngine: flowData.syncEngine,
        webhookEnabled:
          flowType === "webhook" || Boolean(flowData.webhookConfig?.enabled),
        selectedEntities: selectedEntitiesFromFlowBody({
          entityFilter: flowData.entityFilter,
          entityLayouts: flowData.entityLayouts,
        }),
        incremental: createIncremental,
        enforceIncrementalCapability: true,
      });
      if (createValidation.error) {
        return c.json({ success: false, error: createValidation.error }, 400);
      }
      const syncConfigWarnings = createValidation.warnings;

      // The create forms have always POSTed a synthesized `name`; until this
      // field existed Mongoose silently dropped it. Persist it, fall back to
      // the shared derivation, and mint the slug that names the flow's file
      // (RFC #904) — once, here; a later rename never moves it.
      const requestedName =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 200)
          : await deriveFlowDisplayName(flowData as unknown as IFlow);
      flowData.name = requestedName;
      flowData.slug = await reserveFlowSlug(workspaceId, requestedName);

      const flow = new Flow(flowData);

      // Update webhook endpoint with actual flow ID
      if (flowType === "webhook" && flow.webhookConfig) {
        const requestBaseUrl = getRequestBaseUrl(c);
        flow.webhookConfig.endpoint = generateWebhookEndpoint(
          workspaceId,
          flow._id.toString(),
          requestBaseUrl,
        );
      }

      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      // Pre-create BigQuery dataset for connector flows (tables created on first write with full schema)
      if (
        sourceType === "connector" &&
        flowData.tableDestination?.connectionId &&
        flowData.tableDestination?.schema
      ) {
        try {
          const { createDestinationWriter } = await import(
            "../services/destination-writer.service"
          );
          // createDestinationWriter.initialize() calls ensureSchema which creates the dataset
          await createDestinationWriter(
            {
              destinationDatabaseId: flowData.destinationDatabaseId,
              tableDestination: flowData.tableDestination,
            },
            "pre-check",
          );
          logger.info("BigQuery dataset ensured", {
            dataset: flowData.tableDestination.schema,
          });
        } catch (preCreateError) {
          logger.warn("Failed to ensure BigQuery dataset", {
            error:
              preCreateError instanceof Error
                ? preCreateError.message
                : String(preCreateError),
          });
        }
      }

      // Populate references for response based on source type
      if (sourceType === "connector" && flow.dataSourceId) {
        await flow.populate("dataSourceId", "name type");
      }
      await flow.populate("destinationDatabaseId", "name type");

      return c.json({
        success: true,
        data: flow,
        ...(syncConfigWarnings.length > 0
          ? { warnings: syncConfigWarnings }
          : {}),
      });
    } catch (error) {
      // The repo gate is a precondition, not a failure: 412 with an
      // actionable message rather than a 500 the user cannot act on.
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error creating flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId - Get flow details
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}",
    tags: ["Flows"],
    summary: "GET /{flowId}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;

      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Populate references based on source type
      if (flow.sourceType !== "database" && flow.dataSourceId) {
        await flow.populate("dataSourceId", "name type config");
      }
      await flow.populate("destinationDatabaseId", "name type");
      if (flow.type === "webhook" && flow.webhookConfig) {
        flow.webhookConfig.endpoint = generateWebhookEndpoint(
          workspaceId as string,
          flow._id.toString(),
          getRequestBaseUrl(c),
        );
      }

      return c.json({
        success: true,
        data: flow,
      });
    } catch (error) {
      logger.error("Error getting flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PUT /api/workspaces/:workspaceId/flows/:flowId - Update flow
flowRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{flowId}",
    tags: ["Flows"],
    summary: "PUT /{flowId}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      if (!workspaceId) {
        return c.json(
          { success: false, error: "Workspace ID is required" },
          400,
        );
      }
      // An edit rewrites `flows/<slug>.yml`; refuse when there is no repo to
      // write it to (RFC #904 decision 1).
      await assertFlowRepo(workspaceId);
      const body = await c.req.json();

      // Find and validate flow
      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Update common fields. Under the unified trigger model any flow may
      // carry a poll schedule (hybrid trigger set), not only type=scheduled.
      if (body.schedule) {
        const scheduleEnabled = body.schedule.enabled === true;
        flow.schedule = {
          enabled: scheduleEnabled,
          cron: scheduleEnabled
            ? body.schedule.cron || body.schedule
            : flow.schedule?.cron,
          timezone: scheduleEnabled
            ? body.schedule.timezone || flow.schedule?.timezone || "UTC"
            : flow.schedule?.timezone,
        };
      }
      // Rename changes the DISPLAY name only: `slug` is the filename identity
      // and never moves (RFC #904 / apps.md §23).
      if (typeof body.name === "string" && body.name.trim()) {
        flow.name = body.name.trim().slice(0, 200);
      }
      if (body.destinationDatabaseName !== undefined) {
        flow.destinationDatabaseName =
          typeof body.destinationDatabaseName === "string" &&
          body.destinationDatabaseName.trim().length > 0
            ? body.destinationDatabaseName.trim()
            : undefined;
      }
      const previousSyncMode = flow.syncMode;
      if (body.syncMode) flow.syncMode = body.syncMode;
      const syncConfigTouched =
        body.syncMode !== undefined ||
        body.writeMode !== undefined ||
        body.entityFilter !== undefined ||
        body.entityLayouts !== undefined ||
        body.dataSourceId !== undefined;

      if (body.writeMode !== undefined) {
        (flow as any).writeMode = body.writeMode;
      }

      let syncConfigWarnings: string[] = [];
      if (syncConfigTouched) {
        const destForWriteMode = await DatabaseConnection.findById(
          flow.tableDestination?.connectionId || flow.destinationDatabaseId,
        )
          .select({ type: 1 })
          .lean();

        let updateIncremental: IncrementalCapabilities | undefined;
        if (flow.sourceType !== "database" && flow.dataSourceId) {
          const ds = await DataSource.findById(flow.dataSourceId)
            .select({ type: 1, config: 1 })
            .lean();
          updateIncremental = resolveConnectorIncrementalCapabilities(
            ds as any,
          );
        }

        const selectedEntities = selectedEntitiesFromFlowBody({
          entityFilter: body.entityFilter ?? flow.entityFilter,
          entityLayouts: body.entityLayouts ?? (flow as any).entityLayouts,
        });

        // Hard-reject incremental+none only when the client is actively
        // editing sync mode / entities — don't break unrelated updates of
        // legacy flows that were saved as Incremental before capability
        // declarations existed.
        const enforceIncrementalCapability =
          body.syncMode !== undefined ||
          body.entityFilter !== undefined ||
          body.entityLayouts !== undefined ||
          previousSyncMode !== "incremental";

        const updateValidation = validateWriteMode({
          writeMode: (flow as any).writeMode,
          syncMode: flow.syncMode,
          destinationType: destForWriteMode?.type,
          syncEngine: flow.syncEngine,
          webhookEnabled: Boolean(
            flow.webhookConfig?.enabled && flow.webhookConfig?.endpoint,
          ),
          selectedEntities,
          incremental: updateIncremental,
          enforceIncrementalCapability,
        });
        if (updateValidation.error) {
          return c.json({ success: false, error: updateValidation.error }, 400);
        }
        syncConfigWarnings = updateValidation.warnings;
      }

      // Update connector source specific fields
      if (flow.sourceType !== "database") {
        if (body.entityFilter !== undefined) {
          flow.entityFilter = body.entityFilter;
        }
        if (body.queries !== undefined) {
          // Ensure numeric fields in queries are properly typed
          flow.queries = body.queries.map((q: any) => ({
            ...q,
            batch_size: q.batch_size ? Number(q.batch_size) : undefined,
            batchSize: q.batchSize ? Number(q.batchSize) : undefined,
          }));
        }
      }

      // Update database source specific fields
      if (flow.sourceType === "database") {
        // Validate query safety if query is being updated
        if (body.databaseSource?.query) {
          const safetyCheck = checkQuerySafety(body.databaseSource.query);
          if (!safetyCheck.safe) {
            return c.json(
              {
                success: false,
                error: `Unsafe query: ${safetyCheck.errors.join("; ")}`,
                safetyCheck,
              },
              400,
            );
          }
        }

        // Merge databaseSource object to avoid missing fields
        if (body.databaseSource) {
          const newConnectionId = body.databaseSource.connectionId
            ? new Types.ObjectId(body.databaseSource.connectionId)
            : flow.databaseSource?.connectionId;

          if (!newConnectionId) {
            return c.json(
              {
                success: false,
                error: "databaseSource.connectionId is required",
              },
              400,
            );
          }

          flow.databaseSource = {
            connectionId: newConnectionId,
            database:
              body.databaseSource.database ?? flow.databaseSource?.database,
            query:
              body.databaseSource.query ?? flow.databaseSource?.query ?? "",
          };
        }

        // Update other database source config fields
        if (body.incrementalConfig !== undefined) {
          flow.incrementalConfig = body.incrementalConfig;
        }
        if (body.conflictConfig !== undefined) {
          flow.conflictConfig = body.conflictConfig
            ? {
                ...body.conflictConfig,
                // Normalize legacy "upsert" strategy to "update"
                strategy:
                  body.conflictConfig.strategy === "upsert"
                    ? "update"
                    : body.conflictConfig.strategy,
              }
            : body.conflictConfig;
        }
        if (body.paginationConfig !== undefined) {
          flow.paginationConfig = body.paginationConfig;
        }
        if (body.typeCoercions !== undefined) {
          flow.typeCoercions = body.typeCoercions;
        }
        if (body.batchSize !== undefined) {
          flow.batchSize = Number(body.batchSize);
        }
      }

      // Update table destination - merge entire object to avoid missing fields
      if (body.tableDestination) {
        const newConnectionId = body.tableDestination.connectionId
          ? new Types.ObjectId(body.tableDestination.connectionId)
          : flow.tableDestination?.connectionId;

        if (!newConnectionId) {
          return c.json(
            {
              success: false,
              error: "tableDestination.connectionId is required",
            },
            400,
          );
        }

        flow.tableDestination = {
          connectionId: newConnectionId,
          database:
            body.tableDestination.database ?? flow.tableDestination?.database,
          schema: body.tableDestination.schema ?? flow.tableDestination?.schema,
          tableName:
            body.tableDestination.tableName ??
            flow.tableDestination?.tableName ??
            "",
          createIfNotExists:
            body.tableDestination.createIfNotExists ??
            flow.tableDestination?.createIfNotExists ??
            true,
        };

        const resolvedPartitioning =
          body.tableDestination.partitioning ??
          flow.tableDestination?.partitioning;
        if (resolvedPartitioning) {
          flow.tableDestination.partitioning = resolvedPartitioning;
        }
        const resolvedClustering =
          body.tableDestination.clustering ?? flow.tableDestination?.clustering;
        if (resolvedClustering) {
          flow.tableDestination.clustering = resolvedClustering;
        }

        // Keep destinationDatabaseId in sync (used for population/lookups)
        if (body.tableDestination.connectionId) {
          flow.destinationDatabaseId = new Types.ObjectId(
            body.tableDestination.connectionId,
          );
        }
      }

      // Keyed on the engine (not `type`): any CDC flow writing to a
      // destination whose CDC MERGE path relies on tombstones must stay on
      // soft delete, including scheduled CDC flows.
      if (flow.syncEngine === "cdc") {
        const effectiveDestConnectionId =
          flow.tableDestination?.connectionId || flow.destinationDatabaseId;
        const destination = await DatabaseConnection.findById(
          effectiveDestConnectionId,
        )
          .select({ type: 1 })
          .lean();
        const destinationDriver = databaseRegistry.getDriver(
          destination?.type ?? "",
        );
        if (destinationDriver?.requiresSoftDeleteForCdc?.()) {
          // Force soft delete for destinations whose CDC path needs tombstones.
          flow.deleteMode = "soft";
        } else if (body.deleteMode !== undefined) {
          flow.deleteMode = body.deleteMode;
        }
      } else if (body.deleteMode !== undefined) {
        flow.deleteMode = body.deleteMode;
      }
      if (body.entityLayouts !== undefined) {
        (flow as any).entityLayouts = body.entityLayouts;
      }

      // Periodic full backfill cadence (CDC flows only). The dedicated
      // /backfill-schedule endpoint offers the same behavior for API consumers.
      if (body.backfillSchedule !== undefined && flow.syncEngine === "cdc") {
        const sched = body.backfillSchedule || {};
        const enabled = Boolean(sched.enabled);
        const cron = typeof sched.cron === "string" ? sched.cron.trim() : "";
        flow.backfillSchedule = {
          enabled,
          cron: enabled ? cron : flow.backfillSchedule?.cron,
          timezone:
            typeof sched.timezone === "string" && sched.timezone.trim()
              ? sched.timezone.trim()
              : flow.backfillSchedule?.timezone || "UTC",
          lastRunAt: flow.backfillSchedule?.lastRunAt,
        };
      }

      // Update webhook-specific fields
      if (flow.type === "webhook" && flow.webhookConfig) {
        flow.webhookConfig.endpoint = generateWebhookEndpoint(
          workspaceId as string,
          flow._id.toString(),
          getRequestBaseUrl(c),
        );
        if (body.webhookSecret !== undefined) {
          flow.webhookConfig.secret = body.webhookSecret;
        }
        if (body.webhookConfig) {
          if (body.webhookConfig.enabled !== undefined) {
            flow.webhookConfig.enabled = body.webhookConfig.enabled;
          }
        }
      }

      // Normalize legacy "upsert" strategy to "update" before saving
      if (flow.conflictConfig?.strategy === "upsert") {
        flow.conflictConfig.strategy = "update";
      }

      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      // Populate references for response based on source type
      if (flow.sourceType !== "database" && flow.dataSourceId) {
        await flow.populate("dataSourceId", "name type");
      }
      await flow.populate("destinationDatabaseId", "name type");

      return c.json({
        success: true,
        data: flow,
        ...(syncConfigWarnings.length > 0
          ? { warnings: syncConfigWarnings }
          : {}),
      });
    } catch (error) {
      // The repo gate is a precondition, not a failure: 412 with an
      // actionable message rather than a 500 the user cannot act on.
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error updating flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/flows/:flowId - Delete flow
flowRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{flowId}",
    tags: ["Flows"],
    summary: "DELETE /{flowId}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const flowOid = new Types.ObjectId(flowId);
      const wsOid = new Types.ObjectId(workspaceId);

      const flow = await Flow.findOne({ _id: flowOid, workspaceId: wsOid });
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Cancel + cascade + row delete live in one place, shared with the
      // repo reconciler (sync-cdc/flow-reconcile.ts). Two copies of a
      // five-collection teardown would drift, and the halves that drifted
      // would be the ones nobody deletes.
      await teardownFlow(flow);
      // Only this direction writes the file: a deletion made HERE is Mongo →
      // git. When the reconciler tears down, the file is already gone from
      // the tree and committing again would fight the push that caused it.
      await deleteFlowFile(flow, c.get("user")?.id);

      return c.json({
        success: true,
        message: "Flow deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/toggle - Enable/disable flow
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/toggle",
    tags: ["Flows"],
    summary: "POST /{flowId}/toggle",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");

      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Unified trigger model: any flow may carry a poll schedule (hybrid
      // webhook + schedule), so no type gate here.
      if (!flow.schedule?.cron) {
        flow.schedule = {
          enabled: true,
          cron: "0 * * * *",
          timezone: "UTC",
        } as any;
      } else {
        flow.schedule.enabled = !flow.schedule.enabled;
      }
      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      return c.json({
        success: true,
        data: {
          enabled: flow.schedule?.enabled ?? false,
          message: `Schedule ${flow.schedule?.enabled ? "enabled" : "disabled"} successfully`,
        },
      });
    } catch (error) {
      logger.error("Error toggling flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/run - Manually trigger flow
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/run",
    tags: ["Flows"],
    summary: "POST /{flowId}/run",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");

      const flow = await Flow.findOne({
        _id: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .populate("dataSourceId")
        .populate("destinationDatabaseId");

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Trigger flow via Inngest
      const eventId = await inngest.send({
        name: "flow.manual",
        data: {
          flowId: flow._id.toString(),
        },
      });

      return c.json({
        success: true,
        message: "Flow triggered successfully",
        data: {
          flowId: flow._id,
          eventId,
          startedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Error running flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/backfill - Trigger a full backfill
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/backfill",
    tags: ["Flows"],
    summary: "POST /{flowId}/backfill",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;

      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      if (flow.syncEngine === "cdc") {
        const backfill = await cdcBackfillService.startBackfill(
          workspaceId,
          flowId,
        );
        return c.json({
          success: true,
          message: "CDC backfill started",
          data: {
            flowId: flow._id,
            startedAt: new Date(),
            runId: backfill.runId,
            resumed: backfill.reusedRunId,
          },
        });
      }

      const eventId = await inngest.send({
        name: "flow.execute",
        data: {
          flowId: flow._id.toString(),
          noJitter: true,
          backfill: true,
          triggerType: "manual",
        },
      });

      logger.info("Backfill triggered", { flowId, eventId });

      return c.json({
        success: true,
        message: "Backfill started",
        data: {
          flowId: flow._id,
          eventId,
          startedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Error triggering backfill", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-engine
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-engine",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-engine",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(c, workspaceId);
      if (authorizationError) return authorizationError;

      const body = await c.req.json();
      const syncEngine = body?.syncEngine;
      if (syncEngine !== "legacy" && syncEngine !== "cdc") {
        return c.json(
          { success: false, error: "syncEngine must be 'legacy' or 'cdc'" },
          400,
        );
      }

      const flow = await findFlow(workspaceId, flowId);
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // The legacy real-time webhook pipeline has been decommissioned —
      // webhook flows must run on the CDC engine.
      if (flow.type === "webhook" && syncEngine === "legacy") {
        return c.json(
          {
            success: false,
            error:
              "Webhook flows must use the CDC engine — the legacy webhook engine has been removed",
          },
          400,
        );
      }

      flow.syncEngine = syncEngine;
      if (syncEngine === "legacy") {
        flow.streamState = "idle";
        flow.syncStateUpdatedAt = new Date();
        flow.syncStateMeta = {
          lastEvent: "ENGINE_SWITCH",
          lastReason: "Switched to legacy engine",
        };
      } else {
        flow.streamState = flow.streamState || "idle";
        flow.syncStateUpdatedAt = new Date();
        flow.syncStateMeta = {
          lastEvent: "ENGINE_SWITCH",
          lastReason: "Switched to cdc engine",
        };
      }
      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      return c.json({
        success: true,
        data: {
          flowId: flow._id,
          syncEngine: flow.syncEngine,
          syncState: flow.syncState,
        },
      });
    } catch (error) {
      logger.error("Error updating sync engine", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/backfill-schedule
// Configure (or disable) a periodic full backfill cadence for a CDC flow.
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/backfill-schedule",
    tags: ["Flows"],
    summary: "POST /{flowId}/backfill-schedule",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean(),
              cron: z.string().optional(),
              timezone: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(c, workspaceId);
      if (authorizationError) return authorizationError;

      const body = await c.req.json();
      const enabled = Boolean(body?.enabled);
      const cron = typeof body?.cron === "string" ? body.cron.trim() : "";
      const timezone =
        typeof body?.timezone === "string" && body.timezone.trim().length > 0
          ? body.timezone.trim()
          : "UTC";

      if (enabled) {
        const fields = cron.split(" ").filter(Boolean);
        if (fields.length !== 5 && fields.length !== 6) {
          return c.json(
            {
              success: false,
              error: "A valid cron expression is required to enable a schedule",
            },
            400,
          );
        }
      }

      const flow = await findFlow(workspaceId, flowId);
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }
      if (flow.syncEngine !== "cdc") {
        return c.json(
          {
            success: false,
            error: "Scheduled backfill requires syncEngine=cdc",
          },
          400,
        );
      }

      flow.backfillSchedule = {
        enabled,
        cron: enabled ? cron : flow.backfillSchedule?.cron,
        timezone,
        lastRunAt: flow.backfillSchedule?.lastRunAt,
      };
      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      return c.json({
        success: true,
        data: {
          flowId: flow._id,
          backfillSchedule: flow.backfillSchedule,
        },
      });
    } catch (error) {
      logger.error("Error updating backfill schedule", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/start
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/backfill/start",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/backfill/start",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const body = (await c.req.json().catch(() => ({}))) as {
        entities?: string[];
      };
      const backfill = await cdcBackfillService.startBackfill(
        workspaceId,
        flowId,
        { entities: body.entities },
      );
      return c.json({
        success: true,
        message: "CDC backfill started",
        data: {
          runId: backfill.runId,
          resumed: backfill.reusedRunId,
        },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/cancel
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/backfill/cancel",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/backfill/cancel",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const result = await cdcBackfillService.cancelBackfill(
        workspaceId,
        flowId,
      );

      return c.json({
        success: true,
        message: "Backfill cancelled",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-entity
// Drop destination table for one entity, clear its CDC state, and start a fresh backfill.
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/reset-entity",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/reset-entity",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = (await c.req.json().catch(() => ({}))) as {
        entity?: string;
      };
      const entity =
        typeof body.entity === "string" ? body.entity.trim() : undefined;
      if (!entity) {
        return c.json({ success: false, error: "entity is required" }, 400);
      }

      const flow = await findFlow(workspaceId, flowId);
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }
      if (flow.syncEngine !== "cdc") {
        return c.json(
          { success: false, error: "Entity reset requires syncEngine=cdc" },
          400,
        );
      }

      try {
        await cdcBackfillService.assertCanStartBackfill(workspaceId, flowId);
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Execution still running",
          },
          400,
        );
      }

      if (
        flow.tableDestination?.connectionId &&
        flow.tableDestination?.schema
      ) {
        const destination = await DatabaseConnection.findById(
          flow.tableDestination.connectionId,
        );
        if (destination) {
          const driver = databaseRegistry.getDriver(destination.type);
          if (driver?.dropTable) {
            const schema = flow.tableDestination.schema;
            const stageSchema = driver.getStagingSchema?.(schema) ?? schema;
            const liveTable = cdcLiveTableName(
              flow.tableDestination.tableName,
              entity,
              flowId,
            );
            const oldStageTable = cdcStageTableName(
              flow.tableDestination.tableName,
              entity,
              flowId,
            );
            const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
            const bulkStagingTable = `${liveTable}__${flowToken}__staging`;

            await driver.dropTable(destination, liveTable, { schema });
            await driver.dropTable(destination, oldStageTable, {
              schema: stageSchema,
            });
            await driver.dropTable(destination, `${liveTable}__stage_changes`, {
              schema: stageSchema,
            });
            await driver.dropTable(destination, bulkStagingTable, { schema });
          }
        }
      }

      await CdcEntityState.deleteMany({
        workspaceId: new Types.ObjectId(workspaceId),
        flowId: new Types.ObjectId(flowId),
        entity,
      });

      await CdcChangeEvent.deleteMany({
        workspaceId: new Types.ObjectId(workspaceId),
        flowId: new Types.ObjectId(flowId),
        entity,
      });

      const tempCollectionName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
      await Flow.db
        .collection(tempCollectionName)
        .drop()
        .catch(() => undefined);

      // The batch cache stores one entry per (workspace, flow, sorted entity
      // list); invalidate every entry for this flow so the next read reflects
      // the freshly-truncated entity table.
      for (const key of destinationCountBatchCache.keys()) {
        if (key.startsWith(`${workspaceId}:${flowId}:`)) {
          destinationCountBatchCache.delete(key);
        }
      }

      const backfill = await cdcBackfillService.startBackfill(
        workspaceId,
        flowId,
        { entities: [entity] },
      );

      return c.json({
        success: true,
        message: "Entity table reset and backfill started",
        data: {
          entity,
          runId: backfill.runId,
        },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-column
// Reset one destination column for an entity and optionally start entity backfill.
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/reset-column",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/reset-column",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = (await c.req.json().catch(() => ({}))) as {
        entity?: string;
        column?: string;
        forceReplay?: boolean;
        startBackfill?: boolean;
      };
      const entity =
        typeof body.entity === "string" ? body.entity.trim() : undefined;
      const column =
        typeof body.column === "string" ? body.column.trim() : undefined;
      const forceReplay = body.forceReplay !== false;
      const startBackfill = body.startBackfill !== false;

      if (!entity) {
        return c.json({ success: false, error: "entity is required" }, 400);
      }
      if (!column) {
        return c.json({ success: false, error: "column is required" }, 400);
      }
      if (!isSafeSqlIdentifier(column)) {
        return c.json(
          {
            success: false,
            error:
              "column must be a valid SQL identifier (letters, digits, underscore)",
          },
          400,
        );
      }

      const flow = await Flow.findOne({
        _id: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }
      if (flow.syncEngine !== "cdc") {
        return c.json(
          { success: false, error: "Column reset requires syncEngine=cdc" },
          400,
        );
      }
      if (
        !flow.tableDestination?.connectionId ||
        !flow.tableDestination?.schema
      ) {
        return c.json(
          {
            success: false,
            error: "Flow has no destination table configuration",
          },
          400,
        );
      }

      const { entities: configuredEntities } = resolveConfiguredEntities(
        flow as any,
      );
      if (
        configuredEntities.length > 0 &&
        !configuredEntities.includes(entity)
      ) {
        return c.json(
          {
            success: false,
            error: `Entity '${entity}' is not enabled for this flow`,
          },
          400,
        );
      }

      if (startBackfill) {
        try {
          await cdcBackfillService.assertCanStartBackfill(workspaceId, flowId);
        } catch (error) {
          return c.json(
            {
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Execution still running",
            },
            400,
          );
        }
      }

      const destinationRaw = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      if (!destinationRaw) {
        return c.json(
          { success: false, error: "Destination connection not found" },
          404,
        );
      }
      const destinationDoc = destinationRaw.toObject();

      const destinationType = String(destinationDoc.type || "").toLowerCase();
      const schema = flow.tableDestination.schema;
      const tableName = cdcLiveTableName(
        flow.tableDestination.tableName,
        entity,
        String(flow._id),
      );

      let resetQuery: string | null = null;
      if (destinationType === "bigquery") {
        const projectId =
          typeof (destinationDoc as any)?.connection?.project_id === "string"
            ? (destinationDoc as any).connection.project_id.trim()
            : "";
        const tableRef = projectId
          ? `${projectId}.${schema}.${tableName}`
          : `${schema}.${tableName}`;
        const assignments = [`${escapeBigQueryPath(column)} = NULL`];
        if (forceReplay) {
          assignments.push(
            `${escapeBigQueryPath("_mako_source_ts")} = TIMESTAMP('1970-01-01 00:00:00 UTC')`,
          );
          assignments.push(`${escapeBigQueryPath("_mako_ingest_seq")} = -1`);
        }
        resetQuery = `UPDATE ${escapeBigQueryPath(tableRef)} SET ${assignments.join(", ")} WHERE TRUE`;
      } else if (destinationType.includes("postgres")) {
        const assignments = [`${escapePostgresIdentifier(column)} = NULL`];
        if (forceReplay) {
          assignments.push(
            `${escapePostgresIdentifier("_mako_source_ts")} = TIMESTAMP '1970-01-01 00:00:00+00'`,
          );
          assignments.push(
            `${escapePostgresIdentifier("_mako_ingest_seq")} = -1`,
          );
        }
        resetQuery = `UPDATE ${escapePostgresIdentifier(schema)}.${escapePostgresIdentifier(tableName)} SET ${assignments.join(", ")}`;
      }

      if (!resetQuery) {
        return c.json(
          {
            success: false,
            error: `Column reset is not supported for destination type '${destinationDoc.type}'`,
          },
          400,
        );
      }

      const driver = databaseRegistry.getDriver(destinationType);
      if (!driver?.executeQuery) {
        return c.json(
          {
            success: false,
            error: `No query driver available for destination type '${destinationDoc.type}'`,
          },
          400,
        );
      }

      const resetResult = await driver.executeQuery(
        destinationDoc as any,
        resetQuery,
      );
      if (!resetResult.success) {
        return c.json(
          {
            success: false,
            error:
              typeof resetResult.error === "string"
                ? resetResult.error
                : "Failed to reset destination column",
          },
          400,
        );
      }

      let backfillRunId: string | null = null;
      let reusedRunId = false;
      if (startBackfill) {
        try {
          const backfill = await cdcBackfillService.startBackfill(
            workspaceId,
            flowId,
            {
              entities: [entity],
            },
          );
          backfillRunId = backfill.runId;
          reusedRunId = backfill.reusedRunId;
        } catch (error) {
          return c.json(
            {
              success: false,
              error: `Column reset applied but failed to start backfill: ${error instanceof Error ? error.message : String(error)}`,
              data: {
                resetApplied: true,
                entity,
                column,
              },
            },
            400,
          );
        }
      }

      return c.json({
        success: true,
        message: startBackfill
          ? "Column reset applied and entity backfill started"
          : "Column reset applied",
        data: {
          resetApplied: true,
          entity,
          column,
          forceReplay,
          backfillStarted: startBackfill,
          runId: backfillRunId,
          reusedRunId,
        },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/recover",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/recover",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = (await c.req.json().catch(() => ({}))) as {
        retryFailedMaterialization?: boolean;
        entity?: string;
      };
      const result = await cdcBackfillService.recoverFlow({
        workspaceId,
        flowId,
        retryFailedMaterialization: body.retryFailedMaterialization !== false,
        entity: typeof body.entity === "string" ? body.entity : undefined,
      });
      return c.json({
        success: true,
        message: "CDC flow recovered",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-stream
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/recover-stream",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/recover-stream",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = (await c.req.json().catch(() => ({}))) as {
        retryFailedMaterialization?: boolean;
        entity?: string;
      };
      const result = await cdcBackfillService.recoverStream({
        workspaceId,
        flowId,
        retryFailedMaterialization: body.retryFailedMaterialization !== false,
        entity: typeof body.entity === "string" ? body.entity : undefined,
      });
      return c.json({
        success: true,
        message: "CDC stream recovered",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-backfill
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/recover-backfill",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/recover-backfill",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const result = await cdcBackfillService.startBackfill(
        workspaceId,
        flowId,
        {
          reuseExistingRunId: true,
          reason: "Backfill restarted via recover-backfill (from checkpoint)",
        },
      );
      return c.json({
        success: true,
        message: "CDC backfill recovered",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reprocess-stale
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/reprocess-stale",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/reprocess-stale",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const result = await cdcBackfillService.reprocessStaleEvents({
        workspaceId,
        flowId,
      });
      return c.json({
        success: true,
        message: "Stale events reprocessed",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/materialize/retry-failed
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/materialize/retry-failed",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/materialize/retry-failed",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = (await c.req.json().catch(() => ({}))) as {
        entity?: string;
      };
      const result = await cdcBackfillService.retryFailedMaterialization({
        workspaceId,
        flowId,
        entity: typeof body.entity === "string" ? body.entity : undefined,
      });
      return c.json({
        success: true,
        message: "Queued failed CDC rows for materialization retry",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/webhook/provision
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/webhook/provision",
    tags: ["Flows"],
    summary: "POST /{flowId}/webhook/provision",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;

      const body = await c.req.json().catch(() => ({}));

      const flow = await findFlow(workspaceId, flowId);
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }
      if (flow.type !== "webhook") {
        return c.json(
          {
            success: false,
            error: "Webhook provisioning requires webhook flow",
          },
          400,
        );
      }
      if (!flow.dataSourceId) {
        return c.json(
          {
            success: false,
            error: "Webhook provisioning requires a connector data source",
          },
          400,
        );
      }

      const connectorSource = await DataSource.findOne({
        _id: new Types.ObjectId(String(flow.dataSourceId)),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!connectorSource) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      const decryptedConnectorSource =
        await databaseDataSourceManager.getDataSource(
          connectorSource._id.toString(),
        );
      if (!decryptedConnectorSource) {
        return c.json(
          {
            success: false,
            error: "Connector configuration could not be loaded",
          },
          404,
        );
      }

      const connector = await syncConnectorRegistry.getConnector(
        decryptedConnectorSource,
      );
      if (!connector || !connector.supportsWebhooks()) {
        return c.json(
          {
            success: false,
            error: "Selected connector does not support webhooks",
          },
          400,
        );
      }
      if (!connector.supportsWebhookProvisioning()) {
        return c.json(
          {
            success: false,
            error:
              "Selected connector does not support automatic webhook provisioning",
          },
          400,
        );
      }

      const requestedPublicBaseUrl =
        typeof body.publicBaseUrl === "string" && body.publicBaseUrl.trim()
          ? body.publicBaseUrl.trim()
          : undefined;

      const endpoint = generateWebhookEndpoint(
        workspaceId,
        flow._id.toString(),
        resolveWebhookBaseUrl(c, requestedPublicBaseUrl),
      );
      let parsedEndpoint: URL;
      try {
        parsedEndpoint = new URL(endpoint);
      } catch {
        return c.json(
          {
            success: false,
            error: `Generated webhook endpoint is invalid: ${endpoint}`,
          },
          400,
        );
      }

      if (isLoopbackOrPrivateHostname(parsedEndpoint.hostname)) {
        return c.json(
          {
            success: false,
            error: `Generated webhook endpoint is not publicly reachable: ${endpoint}. Open the app through your public tunnel URL before provisioning, or set PUBLIC_URL/BASE_URL to a public HTTPS origin.`,
          },
          400,
        );
      }
      const requestedEvents = Array.isArray(body.events)
        ? body.events
            .filter(
              (event: unknown): event is string => typeof event === "string",
            )
            .map((event: string) => event.trim())
            .filter(Boolean)
        : undefined;

      const { entities: enabledEntities } = resolveConfiguredEntities(flow);

      const created = await connector.createWebhookSubscription({
        endpointUrl: endpoint,
        verifySsl: body.verifySsl !== false,
        events: requestedEvents,
        enabledEntities,
      });

      if (!flow.webhookConfig) {
        flow.webhookConfig = {
          endpoint,
          secret: "",
          totalReceived: 0,
          enabled: true,
        };
      }
      const webhookConfig = flow.webhookConfig;
      if (!webhookConfig) {
        throw new Error("Failed to initialize webhook configuration");
      }
      webhookConfig.endpoint = endpoint;
      if (webhookConfig.enabled === undefined) {
        webhookConfig.enabled = true;
      }
      if (created.signingSecret) {
        webhookConfig.secret = created.signingSecret;
      }
      await flow.save();
      // Mirror the definition into `flows/<slug>.yml` (RFC #904 block 2:
      // export-only — Mongo stays authoritative, a failed write is logged).
      await commitFlowFile(flow, c.get("user")?.id);

      if (!created.signingSecret) {
        // Some providers create the endpoint but omit the signing secret from
        // the API response (e.g. Stripe restricted keys, rk_…). Without it the
        // flow can't verify incoming webhooks, so surface an actionable error
        // instead of reporting a misleading success. The endpoint URL is still
        // persisted above so the user can find/reuse it.
        return c.json(
          {
            success: false,
            error:
              `The ${connectorSource.type} webhook endpoint` +
              (created.providerWebhookId
                ? ` (${created.providerWebhookId})`
                : "") +
              " was created, but the provider did not return a signing secret. " +
              "This typically happens with restricted API keys. Reveal the " +
              "signing secret in your provider's dashboard and paste it into the " +
              "Webhook Secret field, or use a full-access API key and re-provision.",
          },
          400,
        );
      }

      return c.json({
        success: true,
        data: {
          endpoint,
          providerWebhookId: created.providerWebhookId,
          webhookSecret: created.signingSecret || null,
          connectorType: connectorSource.type,
        },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resync
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/resync",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/resync",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const body = await c.req.json().catch(() => ({}));
      const entities = Array.isArray(body.entities)
        ? (body.entities as unknown[]).filter(
            (e): e is string => typeof e === "string" && e.length > 0,
          )
        : [];

      if (entities.length > 0) {
        // Scoped resync: only recreate/re-backfill the listed entities.
        await cdcBackfillService.resyncEntities({
          workspaceId,
          flowId,
          entities,
          deleteDestination: Boolean(body.deleteDestination),
        });
        return c.json({
          success: true,
          message: `CDC resync started for ${entities.length} entit${entities.length === 1 ? "y" : "ies"}`,
        });
      }

      await cdcBackfillService.resyncFlow({
        workspaceId,
        flowId,
        deleteDestination: Boolean(body.deleteDestination),
        clearWebhookEvents: Boolean(body.clearWebhookEvents),
      });
      return c.json({
        success: true,
        message: "CDC resync started",
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/start
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/stream/start",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/stream/start",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const result = await cdcBackfillService.resumeStream(workspaceId, flowId);
      return c.json({
        success: true,
        message: "CDC stream activated",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/pause
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/stream/pause",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/stream/pause",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const result = await cdcBackfillService.pauseStream(workspaceId, flowId);
      return c.json({
        success: true,
        message: "CDC stream paused",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/pause
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/pause",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/pause",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const result = await cdcBackfillService.pauseBackfill(
        workspaceId,
        flowId,
      );
      return c.json({
        success: true,
        message: "CDC flow paused",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resume
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/sync-cdc/resume",
    tags: ["Flows"],
    summary: "POST /{flowId}/sync-cdc/resume",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const authorizationError = await assertOwnerOrAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (authorizationError) return authorizationError;
      const result = await cdcBackfillService.resumeBackfill(
        workspaceId,
        flowId,
      );
      return c.json({
        success: true,
        message: "CDC flow resumed",
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/status
// Unified CDC observability — 3 queries (Flow, CdcEntityState, recent transitions).
// Replaces the old /summary (11 queries) and /diagnostics (500-event scan) endpoints.
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/sync-cdc/status",
    tags: ["Flows"],
    summary: "GET /{flowId}/sync-cdc/status",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const workspaceObjectId = new Types.ObjectId(workspaceId);
      const flowObjectId = new Types.ObjectId(flowId);

      const failedQuery = {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        materializationStatus: "failed" as const,
      };
      const [
        flow,
        states,
        transitions,
        failedRows,
        failedTotal,
        pendingByEntity,
        failedWebhookCount,
        webhookApplyPendingCount,
        cdcByStatus,
        cdcBySource,
      ] = await Promise.all([
        Flow.findOne({
          _id: flowObjectId,
          workspaceId: workspaceObjectId,
        }).lean(),
        CdcEntityState.find({
          workspaceId: workspaceObjectId,
          flowId: flowObjectId,
        })
          .sort({ entity: 1 })
          .lean(),
        CdcStateTransition.find({
          workspaceId: workspaceObjectId,
          flowId: flowObjectId,
        })
          .sort({ at: -1 })
          .limit(20)
          .lean(),
        CdcChangeEvent.find(failedQuery)
          .sort({ ingestTs: -1 })
          .select({ entity: 1, materializationError: 1, ingestTs: 1 })
          .limit(200)
          .lean(),
        CdcChangeEvent.countDocuments(failedQuery),
        CdcChangeEvent.aggregate<{
          _id: string;
          count: number;
          oldestIngestTs: Date | null;
        }>([
          {
            $match: {
              flowId: flowObjectId,
              materializationStatus: "pending",
            },
          },
          {
            $group: {
              _id: "$entity",
              count: { $sum: 1 },
              oldestIngestTs: { $min: "$ingestTs" },
            },
          },
        ]),
        WebhookEvent.countDocuments({
          flowId: flowObjectId,
          workspaceId: workspaceObjectId,
          status: "failed",
        }),
        WebhookEvent.countDocuments({
          flowId: flowObjectId,
          workspaceId: workspaceObjectId,
          applyStatus: "pending",
        }),
        CdcChangeEvent.aggregate<{ _id: string; count: number }>([
          { $match: { flowId: flowObjectId } },
          { $group: { _id: "$materializationStatus", count: { $sum: 1 } } },
        ]),
        CdcChangeEvent.aggregate<{ _id: string; count: number }>([
          { $match: { flowId: flowObjectId } },
          { $group: { _id: "$sourceKind", count: { $sum: 1 } } },
        ]),
      ]);

      if (!flow) {
        throw new Error("Flow not found");
      }
      const { entities: configuredEntities } = resolveConfiguredEntities(
        flow as any,
      );
      const stateByEntity = new Map(
        states
          .filter(
            state =>
              typeof state.entity === "string" && state.entity.length > 0,
          )
          .map(state => [state.entity, state] as const),
      );
      const uniqueEntities = Array.from(
        new Set([
          ...configuredEntities,
          ...states
            .map(state =>
              typeof state.entity === "string" ? state.entity : "",
            )
            .filter(Boolean),
        ]),
      );
      const failedByEntity = new Map<
        string,
        { count: number; latestAt: Date | null; latestError: any | null }
      >();
      for (const row of failedRows) {
        const entity =
          typeof (row as any).entity === "string" ? (row as any).entity : "";
        if (!entity) continue;
        const existing = failedByEntity.get(entity) || {
          count: 0,
          latestAt: null,
          latestError: null,
        };
        existing.count += 1;
        if (!existing.latestAt) {
          existing.latestAt = (row as any).ingestTs
            ? new Date((row as any).ingestTs)
            : null;
          existing.latestError = (row as any).materializationError || null;
        }
        failedByEntity.set(entity, existing);
      }

      const pendingCountMap = new Map(
        pendingByEntity.map(r => [r._id, r.count]),
      );
      const pendingOldestTsMap = new Map(
        pendingByEntity.flatMap(r =>
          r.oldestIngestTs
            ? [[r._id, new Date(r.oldestIngestTs)] as const]
            : [],
        ),
      );

      const entities = uniqueEntities.map(entity => {
        const state = stateByEntity.get(entity);
        const lastMaterializedAt = state?.lastMaterializedAt
          ? new Date(state.lastMaterializedAt)
          : null;
        const lifetimeEventsProcessed =
          typeof (state as any)?.lifetimeEventsProcessed === "number"
            ? (state as any).lifetimeEventsProcessed
            : 0;
        const lifetimeRowsApplied =
          typeof (state as any)?.lifetimeRowsApplied === "number"
            ? (state as any).lifetimeRowsApplied
            : 0;
        const backfillDone =
          state?.backfillCompletedAt != null ||
          (state?.backfillCursor as any)?.hasMore === false;
        const ingestSeq = state?.lastIngestSeq || 0;
        const materializedSeq = state?.lastMaterializedSeq || 0;
        // Real pending rows only — never inflate with ingest/materialized seq
        // gap (Recover/Reprocess used to rewind the cursor and make the gap
        // look like hundreds of thousands of "pending" events).
        const backlogCount = computeEntityPendingBacklog(
          pendingCountMap.get(entity) || 0,
        );
        const seqGap = computeEntitySeqGap(ingestSeq, materializedSeq);
        const oldestPendingTs = pendingOldestTsMap.get(entity) ?? null;
        return {
          entity,
          lastIngestSeq: ingestSeq,
          lastMaterializedSeq: materializedSeq,
          backlogCount,
          seqGap,
          lagSeconds: computePendingLagSeconds({
            pendingCount: backlogCount,
            oldestPendingTs,
          }),
          lastMaterializedAt,
          destinationRowCount: (state as any)?.destinationRowCount ?? null,
          lifetimeEventsProcessed,
          lifetimeRowsApplied,
          backfillDone,
          failedCount: failedByEntity.get(entity)?.count || 0,
          lastFailedAt: failedByEntity.get(entity)?.latestAt || null,
          lastFailedError: failedByEntity.get(entity)?.latestError || null,
          repartition: (state as any)?.repartition?.status
            ? {
                status: (state as any).repartition.status as
                  | "pending"
                  | "running"
                  | "done"
                  | "failed",
                error: (state as any).repartition.error ?? null,
              }
            : null,
        };
      });

      const totalBacklog = entities.reduce((sum, e) => sum + e.backlogCount, 0);
      const materializedDates = entities
        .map(e => e.lastMaterializedAt)
        .filter((d): d is Date => d instanceof Date);
      const oldestPendingTs = Array.from(pendingOldestTsMap.values()).sort(
        (a, b) => a.getTime() - b.getTime(),
      )[0];
      const lagSeconds = computePendingLagSeconds({
        pendingCount: totalBacklog,
        oldestPendingTs,
      });

      let backfillStatus = flow.backfillState?.status || "idle";
      if (
        backfillStatus === "paused" &&
        entities.length > 0 &&
        entities.every(e => e.backfillDone)
      ) {
        try {
          await syncMachineService.applyBackfillTransition({
            workspaceId,
            flowId,
            event: {
              type: "COMPLETE",
              reason: "All entities completed (auto-healed from paused)",
            },
            context: { backfillCursorExhausted: true },
          });
          backfillStatus = "completed";
        } catch {
          /* ignore guard failures */
        }
      }

      const lastError =
        flow.syncStateMeta?.lastErrorMessage ||
        flow.syncStateMeta?.lastErrorCode
          ? {
              message: flow.syncStateMeta.lastErrorMessage || null,
              code: flow.syncStateMeta.lastErrorCode || null,
              reason: flow.syncStateMeta.lastReason || null,
              event: flow.syncStateMeta.lastEvent || null,
            }
          : null;

      const statusMap = new Map(cdcByStatus.map(r => [r._id, r.count]));
      const sourceMap = new Map(cdcBySource.map(r => [r._id, r.count]));

      return c.json({
        success: true,
        data: {
          syncState: flow.syncState ?? flow.streamState ?? "idle",
          streamState: flow.streamState || "idle",
          backfillStatus,
          consecutiveFailures: flow.backfillState?.consecutiveFailures ?? 0,
          lastError,
          backlogCount: totalBacklog,
          // The UI "pending" counter must reflect real pending CdcChangeEvents
          // only — not cursor seq gaps (Recover rewind used to inflate those
          // into hundreds of thousands of fake "pending" events) and not the
          // raw WebhookEvent.applyStatus count (orphaned/deduped rows).
          webhookPendingCount: totalBacklog,
          // Raw applyStatus=pending count kept for diagnostics only.
          webhookApplyPendingCount,
          lagSeconds,
          lastMaterializedAt:
            materializedDates.sort((a, b) => b.getTime() - a.getTime())[0] ||
            null,
          entities,
          failedMaterialization: {
            total: failedTotal,
            latest:
              failedRows.length > 0
                ? {
                    entity: (failedRows[0] as any).entity || null,
                    at: (failedRows[0] as any).ingestTs || null,
                    error: (failedRows[0] as any).materializationError || null,
                  }
                : null,
          },
          failedWebhookCount,
          pipeline: {
            cdcEventsByStatus: {
              pending: statusMap.get("pending") || 0,
              applied: statusMap.get("applied") || 0,
              failed: statusMap.get("failed") || 0,
              dropped: statusMap.get("dropped") || 0,
            },
            cdcEventsBySource: {
              webhook: sourceMap.get("webhook") || 0,
              backfill: sourceMap.get("backfill") || 0,
            },
            materializationBacklog: totalBacklog,
            lagSeconds,
          },
          transitions: transitions.map(t => ({
            machine: t.machine,
            fromState: t.fromState,
            event: t.event,
            toState: t.toState,
            at: t.at,
            reason: t.reason,
          })),
        },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/schema-health
// Compare live destination column types against the connector schema to surface drift.
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/sync-cdc/schema-health",
    tags: ["Flows"],
    summary: "GET /{flowId}/sync-cdc/schema-health",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      query: z.object({
        entity: z
          .string()
          .optional()
          .openapi({ param: { name: "entity", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const entityFilter = c.req.query("entity");

      const flow = await Flow.findOne({
        _id: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();
      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }
      if (flow.syncEngine !== "cdc") {
        return c.json(
          { success: false, error: "Schema health requires syncEngine=cdc" },
          400,
        );
      }
      if (
        !flow.tableDestination?.connectionId ||
        !flow.tableDestination?.schema
      ) {
        return c.json(
          {
            success: false,
            error: "Flow has no destination table configuration",
          },
          400,
        );
      }

      const destination = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      if (!destination) {
        return c.json(
          { success: false, error: "Destination connection not found" },
          404,
        );
      }

      if (destination.type !== "bigquery") {
        return c.json(
          {
            success: false,
            error:
              "Schema health is currently only supported for BigQuery destinations",
          },
          400,
        );
      }

      const { entities: configuredEntities } = resolveConfiguredEntities(
        flow as any,
      );
      const targetEntities = entityFilter
        ? configuredEntities.filter(e => e === entityFilter)
        : configuredEntities;

      if (targetEntities.length === 0) {
        return c.json({
          success: true,
          data: { entities: [], hasDrift: false },
        });
      }

      const connectorSchema: Map<
        string,
        Record<string, { type: string }>
      > = new Map();
      if (flow.dataSourceId) {
        try {
          const ds = await databaseDataSourceManager.getDataSource(
            String(flow.dataSourceId),
          );
          if (ds) {
            const connector = await syncConnectorRegistry.getConnector(ds);
            if (connector?.resolveSchema) {
              for (const entity of targetEntities) {
                try {
                  const schema = await connector.resolveSchema(entity);
                  if (schema?.fields) {
                    connectorSchema.set(entity, schema.fields as any);
                  }
                } catch {
                  // skip entities where schema resolution fails
                }
              }
            }
          }
        } catch {
          // connector resolution failed — return empty schema health
        }
      }

      const schema = flow.tableDestination.schema;
      const conn = (destination as any).connection || {};
      const connLocation: string | undefined = conn.location;
      const results: Array<{
        entity: string;
        columns: Array<{
          column: string;
          liveType: string;
          expectedType: string;
          status: "match" | "drift";
        }>;
        hasDrift: boolean;
      }> = [];
      let globalHasDrift = false;

      for (const entity of targetEntities) {
        const fields = connectorSchema.get(entity);
        if (!fields) {
          results.push({ entity, columns: [], hasDrift: false });
          continue;
        }

        const liveTable = cdcLiveTableName(
          flow.tableDestination.tableName,
          entity,
          flowId,
        );

        const infoQuery = `SELECT column_name, data_type FROM \`${schema}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${liveTable.replace(/'/g, "''")}'`;

        const infoResult = await databaseConnectionService.executeQuery(
          destination,
          infoQuery,
          { location: connLocation },
        );

        if (!infoResult.success || !Array.isArray(infoResult.data)) {
          results.push({ entity, columns: [], hasDrift: false });
          continue;
        }

        const liveTypes = new Map<string, string>();
        for (const row of infoResult.data as any[]) {
          liveTypes.set(row.column_name, row.data_type);
        }

        const columns: Array<{
          column: string;
          liveType: string;
          expectedType: string;
          status: "match" | "drift";
        }> = [];
        let entityHasDrift = false;

        for (const [col, fieldDef] of Object.entries(fields)) {
          const liveType = liveTypes.get(col);
          if (!liveType) continue;
          const expectedType = mapLogicalTypeToBigQuery((fieldDef as any).type);
          const status =
            liveType.toUpperCase() === expectedType.toUpperCase()
              ? ("match" as const)
              : ("drift" as const);
          if (status === "drift") entityHasDrift = true;
          columns.push({ column: col, liveType, expectedType, status });
        }

        if (entityHasDrift) globalHasDrift = true;
        results.push({ entity, columns, hasDrift: entityHasDrift });
      }

      return c.json({
        success: true,
        data: { entities: results, hasDrift: globalHasDrift },
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/destination-counts
// Lazy endpoint — returns destination row counts per entity (may be slow for BigQuery).
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/sync-cdc/destination-counts",
    tags: ["Flows"],
    summary: "GET /{flowId}/sync-cdc/destination-counts",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const workspaceObjectId = new Types.ObjectId(workspaceId);
      const flowObjectId = new Types.ObjectId(flowId);

      const flow = await Flow.findOne({
        _id: flowObjectId,
        workspaceId: workspaceObjectId,
      }).lean();

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      if (
        !flow.tableDestination?.connectionId ||
        !flow.tableDestination?.schema
      ) {
        return c.json({ success: true, data: {} });
      }

      const destinationDoc = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      const destination = destinationDoc?.toObject();
      if (!destination) {
        return c.json({ success: true, data: {} });
      }

      const { entities: configuredEntities } = resolveConfiguredEntities(
        flow as any,
      );
      const states = await CdcEntityState.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .select("entity")
        .lean();
      const uniqueEntities = Array.from(
        new Set([
          ...configuredEntities,
          ...states
            .map(s => (typeof s.entity === "string" ? s.entity : ""))
            .filter(Boolean),
        ]),
      );

      const data = await getDestinationEntityRowCountsBatch({
        workspaceId,
        flowId,
        entities: uniqueEntities,
        destinationType: destination.type,
        destination,
        schema: flow.tableDestination?.schema || "",
        baseTablePrefix: flow.tableDestination?.tableName,
      });

      return c.json({ success: true, data });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// Backward-compat: /summary and /diagnostics redirect to unified /status
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/sync-cdc/summary",
    tags: ["Flows"],
    summary: "GET /{flowId}/sync-cdc/summary",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace("/summary", "/status");
    return c.redirect(url.toString(), 307);
  },
);
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/sync-cdc/diagnostics",
    tags: ["Flows"],
    summary: "GET /{flowId}/sync-cdc/diagnostics",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace("/diagnostics", "/status");
    return c.redirect(url.toString(), 307);
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/schema?entity=activities:LeadStatusChange
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/schema",
    tags: ["Flows"],
    summary: "GET /{flowId}/schema",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      query: z.object({
        entity: z
          .string()
          .optional()
          .openapi({ param: { name: "entity", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      const entity = c.req.query("entity");

      if (!entity) {
        return c.json(
          { success: false, error: "entity query parameter is required" },
          400,
        );
      }

      const flow = await Flow.findOne({
        _id: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      if (!flow.dataSourceId) {
        return c.json(
          { success: false, error: "Flow has no connector data source" },
          400,
        );
      }

      const dataSource = await DataSource.findById(flow.dataSourceId).lean();
      if (!dataSource) {
        return c.json({ success: false, error: "Data source not found" }, 404);
      }

      const decrypted = await databaseDataSourceManager.getDataSource(
        String(dataSource._id),
      );
      if (!decrypted) {
        return c.json(
          { success: false, error: "Could not resolve data source" },
          404,
        );
      }
      const connector = await syncConnectorRegistry.getConnector(decrypted);
      if (!connector) {
        return c.json(
          { success: false, error: "Connector not found for data source type" },
          404,
        );
      }

      const schema = await connector.resolveSchema(entity);
      if (!schema) {
        return c.json(
          {
            success: false,
            error: `No schema available for entity: ${entity}`,
          },
          404,
        );
      }

      return c.json({ success: true, data: schema });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/status - Check if flow is running
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/status",
    tags: ["Flows"],
    summary: "GET /{flowId}/status",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");

      // Verify flow exists and belongs to workspace
      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Check for running executions
      const runningExecution = await FlowExecution.findOne({
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        status: "running",
      })
        .sort({ startedAt: -1 })
        .lean();

      return c.json({
        success: true,
        data: {
          isRunning: !!runningExecution,
          runningExecution: runningExecution
            ? {
                executionId: runningExecution._id,
                startedAt: runningExecution.startedAt,
                lastHeartbeat: runningExecution.lastHeartbeat,
              }
            : null,
        },
      });
    } catch (error) {
      logger.error("Error checking flow status", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/:flowId/cancel - Cancel running flow
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/cancel",
    tags: ["Flows"],
    summary: "POST /{flowId}/cancel",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const body = await c.req.json().catch(() => ({}));
      const { executionId } = body;

      // Verify flow exists and belongs to workspace
      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      let executionIdToCancel = executionId;

      // If no executionId provided, find the running execution
      if (!executionIdToCancel) {
        const runningExecution = await FlowExecution.findOne({
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
          status: "running",
        })
          .sort({ startedAt: -1 })
          .lean();

        if (!runningExecution) {
          return c.json(
            { success: false, error: "No running execution found" },
            404,
          );
        }

        executionIdToCancel = runningExecution._id.toString();
      }

      // Trigger cancellation via Inngest
      const eventId = await inngest.send({
        name: "flow.cancel",
        data: {
          flowId: flow._id.toString(),
          executionId: executionIdToCancel,
        },
      });

      return c.json({
        success: true,
        message: "Cancellation request sent successfully",
        data: {
          flowId: flow._id,
          executionId: executionIdToCancel,
          eventId,
        },
      });
    } catch (error) {
      logger.error("Error cancelling flow", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/flows/:flowId/history - Get execution history
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/history",
    tags: ["Flows"],
    summary: "GET /{flowId}/history",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const limit = parseInt(c.req.query("limit") || "50");
      const offset = parseInt(c.req.query("offset") || "0");

      // Verify flow exists and belongs to workspace
      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return c.json({ success: false, error: "Flow not found" }, 404);
      }

      // Fetch executions from flow_executions collection
      const executions = await FlowExecution.find({
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .sort({ startedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      const formatted = executions.map(ex => ({
        executionId: ex._id,
        executedAt: ex.startedAt,
        status: ex.status,
        success: ex.success,
        error: ex.error,
        duration: ex.duration,
        logCount: Array.isArray(ex.logs) ? ex.logs.length : 0,
      }));

      return c.json({
        success: true,
        data: {
          total: await FlowExecution.countDocuments({
            flowId: new Types.ObjectId(flowId),
            workspaceId: new Types.ObjectId(workspaceId),
          }),
          limit,
          offset,
          history: formatted,
        },
      });
    } catch (error) {
      logger.error("Error getting flow history", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET full details for a specific execution
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/executions/{executionId}",
    tags: ["Flows"],
    summary: "GET /{flowId}/executions/{executionId}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
        executionId: z
          .string()
          .openapi({ param: { name: "executionId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const executionId = c.req.param("executionId");

      const execution = await FlowExecution.findOne({
        _id: new Types.ObjectId(executionId),
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!execution) {
        return c.json({ success: false, error: "Execution not found" }, 404);
      }

      return c.json({ success: true, data: execution });
    } catch (error) {
      logger.error("Error getting execution details", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// GET logs for a specific execution
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/executions/{executionId}/logs",
    tags: ["Flows"],
    summary: "GET /{flowId}/executions/{executionId}/logs",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
        executionId: z
          .string()
          .openapi({ param: { name: "executionId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const executionId = c.req.param("executionId");

      const execution = await FlowExecution.findOne({
        _id: new Types.ObjectId(executionId),
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!execution) {
        return c.json({ success: false, error: "Execution not found" }, 404);
      }

      return c.json({ success: true, data: execution.logs || [] });
    } catch (error) {
      logger.error("Error getting execution logs", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// GET webhook events for a flow
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/webhook/events",
    tags: ["Flows"],
    summary: "GET /{flowId}/webhook/events",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
        offset: z
          .string()
          .optional()
          .openapi({ param: { name: "offset", in: "query" } }),
        status: z
          .string()
          .optional()
          .openapi({ param: { name: "status", in: "query" } }),
        applyStatus: z
          .string()
          .optional()
          .openapi({ param: { name: "applyStatus", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const limit = parseInt(c.req.query("limit") || "50");
      const offset = parseInt(c.req.query("offset") || "0");
      const status = c.req.query("status");

      const flow = await Flow.findOne({
        _id: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        type: "webhook",
      });

      if (!flow) {
        return c.json({ success: false, error: "Webhook flow not found" }, 404);
      }

      const applyStatus = c.req.query("applyStatus");

      const query: any = {
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      };

      if (status) {
        query.status = status;
      }
      if (applyStatus) {
        query.applyStatus = applyStatus;
      }

      const events = await WebhookEvent.find(query)
        .sort({ receivedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      const total = await WebhookEvent.countDocuments(query);

      return c.json({
        success: true,
        data: {
          total,
          limit,
          offset,
          events: events.map(event => ({
            id: event._id,
            eventId: event.eventId,
            eventType: event.eventType,
            receivedAt: event.receivedAt,
            processedAt: event.processedAt,
            status: event.status,
            applyStatus: event.applyStatus,
            attempts: event.attempts,
            error: event.error,
            applyError: event.applyError,
            entity: event.entity,
            operation: event.operation,
            processingDurationMs: event.processingDurationMs,
          })),
        },
      });
    } catch (error) {
      logger.error("Error getting webhook events", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// GET webhook event details
flowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{flowId}/webhook/events/{eventId}",
    tags: ["Flows"],
    summary: "GET /{flowId}/webhook/events/{eventId}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
        eventId: z.string().openapi({ param: { name: "eventId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const eventId = c.req.param("eventId");

      const event = await WebhookEvent.findOne({
        _id: new Types.ObjectId(eventId),
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!event) {
        return c.json(
          { success: false, error: "Webhook event not found" },
          404,
        );
      }

      return c.json({ success: true, data: event });
    } catch (error) {
      logger.error("Error getting webhook event details", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// POST retry webhook event — resets to pending.
// CDC: 2-min cron picks it up. Non-CDC: enqueues via Inngest.
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/webhook/events/{eventId}/retry",
    tags: ["Flows"],
    summary: "POST /{flowId}/webhook/events/{eventId}/retry",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
        eventId: z.string().openapi({ param: { name: "eventId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      const eventId = c.req.param("eventId");

      const event = await WebhookEvent.findOneAndUpdate(
        {
          _id: new Types.ObjectId(eventId),
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
          status: { $in: ["failed", "completed"] },
        },
        {
          $set: { status: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
        { new: true, projection: { eventId: 1, flowId: 1 } },
      );

      if (!event) {
        return c.json(
          {
            success: false,
            error: "Webhook event not found or cannot be retried",
          },
          404,
        );
      }

      // All webhook flows are CDC: the scheduler cron re-ingests pending events.
      return c.json({
        success: true,
        message:
          "Webhook event reset to pending — will be picked up by the next CDC cron cycle",
        data: { eventId },
      });
    } catch (error) {
      logger.error("Error retrying webhook event", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// POST retry all failed webhook events for a flow — resets to pending.
// CDC: cron picks up. Non-CDC: enqueues each via Inngest.
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{flowId}/webhook/events/retry-all-failed",
    tags: ["Flows"],
    summary: "POST /{flowId}/webhook/events/retry-all-failed",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");

      const failedEvents = await WebhookEvent.find({
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        status: "failed",
        attempts: { $lt: 10 },
      })
        .select("_id eventId flowId")
        .limit(500)
        .lean();

      if (failedEvents.length === 0) {
        return c.json({ success: true, data: { retried: 0 } });
      }

      await WebhookEvent.updateMany(
        { _id: { $in: failedEvents.map(e => e._id) } },
        {
          $set: { status: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
      );

      // All webhook flows are CDC: the scheduler cron re-ingests pending events.
      return c.json({
        success: true,
        data: {
          retried: failedEvents.length,
          total: failedEvents.length,
        },
      });
    } catch (error) {
      logger.error("Error retrying all failed webhook events", { error });
      return c.json({ success: false, error: "Server error" }, 500);
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/validate-query - Validate a database query before creating a flow
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/validate-query",
    tags: ["Flows"],
    summary: "POST /validate-query",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const body = await c.req.json();

      const { connectionId, query, database } = body;

      if (!connectionId) {
        return c.json(
          { success: false, error: "connectionId is required" },
          400,
        );
      }

      if (!query) {
        return c.json({ success: false, error: "query is required" }, 400);
      }

      // Run safety checks first
      const safetyCheck = checkQuerySafety(query);
      if (!safetyCheck.safe) {
        return c.json(
          {
            success: false,
            error: safetyCheck.errors.join("; "),
            safetyCheck,
          },
          400,
        );
      }

      // Validate connection exists and belongs to workspace
      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      // Validate the query
      const result = await validateQuery(connection, query, database);

      if (!result.success) {
        return c.json(
          {
            success: false,
            error: result.error || "Query validation failed",
            safetyCheck,
          },
          400,
        );
      }

      return c.json({
        success: true,
        data: {
          columns: result.columns,
          sampleRow: result.sampleRow,
          connectionName: connection.name,
          connectionType: connection.type,
          safetyCheck,
        },
      });
    } catch (error) {
      logger.error("Error validating query", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/flows/dry-run - Dry run a sync configuration
flowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/dry-run",
    tags: ["Flows"],
    summary: "POST /dry-run",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const body = await c.req.json();

      const {
        connectionId,
        query,
        database,
        paginationConfig,
        typeCoercions,
        pageSize = 100,
        pages = 3,
      } = body;

      if (!connectionId) {
        return c.json(
          { success: false, error: "connectionId is required" },
          400,
        );
      }

      if (!query) {
        return c.json({ success: false, error: "query is required" }, 400);
      }

      // Validate connection exists and belongs to workspace
      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      // Run dry run
      const result = await dryRunDbSync({
        sourceConnection: connection,
        sourceQuery: query,
        sourceDatabase: database,
        paginationConfig,
        typeCoercions,
        pageSize: Math.min(pageSize, 1000), // Cap at 1000 per page
        pages: Math.min(pages, 5), // Cap at 5 pages
      });

      if (!result.success) {
        return c.json(
          {
            success: false,
            error: result.error,
            safetyCheck: result.safetyCheck,
          },
          400,
        );
      }

      return c.json({
        success: true,
        data: {
          totalRows: result.totalRows,
          sampleData: result.sampleData,
          columns: result.columns,
          estimatedTotal: result.estimatedTotal,
          safetyCheck: result.safetyCheck,
          connectionName: connection.name,
          connectionType: connection.type,
        },
      });
    } catch (error) {
      logger.error("Error running dry-run", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);
