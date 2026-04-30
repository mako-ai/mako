import { Hono } from "hono";
import {
  Flow,
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  Connector as DataSource,
  DatabaseConnection,
  FlowExecution,
  WebhookEvent,
} from "../database/workspace-schema";
import { Types, PipelineStage } from "mongoose";
import { inngest } from "../inngest";
import { enqueueWebhookProcess } from "../inngest/webhook-process-enqueue";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";
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
import { cdcBackfillService } from "../sync-cdc/backfill";
import { getCdcFlowStats, syncMachineService } from "../sync-cdc/sync-state";
import { databaseRegistry } from "../databases/registry";
import { cdcLiveTableName, cdcStageTableName } from "../sync-cdc/normalization";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";
import { databaseConnectionService } from "../services/database-connection.service";
import { mapLogicalTypeToBigQuery } from "../sync-cdc/adapters/bigquery";

const logger = loggers.inngest("flow");

export const flowRoutes = new Hono();

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

function toLagSeconds(value: Date | null): number | null {
  if (!value) return null;
  return Math.max(Math.floor((Date.now() - value.getTime()) / 1000), 0);
}

const DESTINATION_COUNT_CACHE_TTL_MS = 60_000;
const destinationCountBatchCache = new Map<
  string,
  { value: Record<string, number | null>; expiresAt: number }
>();

function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escapeBigQueryPath(path: string): string {
  return `\`${path.replace(/`/g, "\\`")}\``;
}

function isSafeSqlIdentifier(identifier: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier);
}

function buildDestinationCountBatchQuery(params: {
  destinationType?: string;
  schema: string;
  tableNames: string[];
  projectId?: string;
}): string | null {
  if (params.tableNames.length === 0) return null;
  const type = (params.destinationType || "").toLowerCase();
  const inList = params.tableNames.map(escapeSqlLiteral).join(",");
  if (type === "bigquery") {
    const dataset = params.projectId
      ? `\`${params.projectId}\`.\`${params.schema}\``
      : `\`${params.schema}\``;
    return `SELECT table_id, row_count FROM ${dataset}.__TABLES__ WHERE table_id IN (${inList})`;
  }
  if (type.includes("postgres")) {
    return `SELECT c.relname AS table_id, c.reltuples::bigint AS row_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${escapeSqlLiteral(params.schema)} AND c.relname IN (${inList})`;
  }
  return null;
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

  const query = buildDestinationCountBatchQuery({
    destinationType: params.destinationType,
    schema: params.schema,
    tableNames,
    projectId: (params.destination as any)?.connection?.project_id,
  });
  if (!query) {
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }

  const driver = databaseRegistry.getDriver(params.destination.type);
  if (!driver?.executeQuery) {
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

  try {
    const queryResult = await driver.executeQuery(params.destination, query);
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
flowRoutes.get("/", async c => {
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
          sourceType: { $ifNull: ["$sourceType", "connector"] },
          destinationDatabaseName: 1,
          schedule: 1,
          webhookConfig: 1,
          entityFilter: 1,
          queries: 1,
          syncMode: 1,
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
});

// POST /api/workspaces/:workspaceId/flows - Create a new flow
flowRoutes.post("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ success: false, error: "Workspace ID is required" }, 400);
    }
    // TODO: Get userId from authentication
    const userId = "system";
    const body = await c.req.json();

    // Validate required fields based on flow type and source type
    const flowType = body.type || "scheduled";
    const sourceType = body.sourceType || "connector";

    // Schedule cron required only when schedule is enabled
    if (
      flowType === "scheduled" &&
      body.schedule?.enabled &&
      !body.schedule?.cron
    ) {
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
          { success: false, error: "databaseSource.connectionId is required" },
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
        return c.json({ success: false, error: "Data source not found" }, 404);
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
      syncEngine: "legacy",
      syncStateUpdatedAt: new Date(),
      enabled: true,
      createdBy: userId,
    };

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

    if (flowType === "webhook" && destinationType === "bigquery") {
      // BigQuery CDC path relies on tombstones for correctness.
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
    });
  } catch (error) {
    logger.error("Error creating flow", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/flows/:flowId - Get flow details
flowRoutes.get("/:flowId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

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
});

// PUT /api/workspaces/:workspaceId/flows/:flowId - Update flow
flowRoutes.put("/:flowId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");
    const body = await c.req.json();

    // Find and validate flow
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }

    // Update common fields
    if (flow.type === "scheduled" && body.schedule) {
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
    if (body.destinationDatabaseName !== undefined) {
      flow.destinationDatabaseName =
        typeof body.destinationDatabaseName === "string" &&
        body.destinationDatabaseName.trim().length > 0
          ? body.destinationDatabaseName.trim()
          : undefined;
    }
    if (body.syncMode) flow.syncMode = body.syncMode;

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
          query: body.databaseSource.query ?? flow.databaseSource?.query ?? "",
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

    if (flow.type === "webhook") {
      const effectiveDestConnectionId =
        flow.tableDestination?.connectionId || flow.destinationDatabaseId;
      const destination = await DatabaseConnection.findById(
        effectiveDestConnectionId,
      )
        .select({ type: 1 })
        .lean();
      if (destination?.type === "bigquery") {
        // Force soft delete for BigQuery webhook flows.
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

    // Populate references for response based on source type
    if (flow.sourceType !== "database" && flow.dataSourceId) {
      await flow.populate("dataSourceId", "name type");
    }
    await flow.populate("destinationDatabaseId", "name type");

    return c.json({
      success: true,
      data: flow,
    });
  } catch (error) {
    logger.error("Error updating flow", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/flows/:flowId - Delete flow
flowRoutes.delete("/:flowId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");
    const flowOid = new Types.ObjectId(flowId);
    const wsOid = new Types.ObjectId(workspaceId);

    const flow = await Flow.findOne({ _id: flowOid, workspaceId: wsOid });
    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }

    await inngest.send({ name: "flow.cancel", data: { flowId } });

    const childFilter = { flowId: flowOid, workspaceId: wsOid };
    const [webhooks, executions, cdcEvents, entityStates, transitions] =
      await Promise.all([
        WebhookEvent.deleteMany(childFilter),
        FlowExecution.deleteMany(childFilter),
        CdcChangeEvent.deleteMany(childFilter),
        CdcEntityState.deleteMany(childFilter),
        CdcStateTransition.deleteMany(childFilter),
      ]);

    await Flow.deleteOne({ _id: flowOid, workspaceId: wsOid });

    logger.info("Flow deleted with cascade cleanup", {
      flowId,
      workspaceId,
      deleted: {
        webhookEvents: webhooks.deletedCount,
        flowExecutions: executions.deletedCount,
        cdcChangeEvents: cdcEvents.deletedCount,
        cdcEntityStates: entityStates.deletedCount,
        cdcStateTransitions: transitions.deletedCount,
      },
    });

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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/toggle - Enable/disable flow
flowRoutes.post("/:flowId/toggle", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }

    if (flow.type !== "scheduled") {
      return c.json(
        { success: false, error: "Only scheduled flows can be toggled" },
        400,
      );
    }

    if (!flow.schedule) {
      flow.schedule = {
        enabled: true,
        cron: "0 * * * *",
        timezone: "UTC",
      } as any;
    } else {
      flow.schedule.enabled = !flow.schedule.enabled;
    }
    await flow.save();

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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/run - Manually trigger flow
flowRoutes.post("/:flowId/run", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/backfill - Trigger a full backfill
flowRoutes.post("/:flowId/backfill", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-engine
flowRoutes.post("/:flowId/sync-engine", async (c: AuthenticatedContext) => {
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

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/start
flowRoutes.post("/:flowId/sync-cdc/backfill/start", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/cancel
flowRoutes.post("/:flowId/sync-cdc/backfill/cancel", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;

    const result = await cdcBackfillService.cancelBackfill(workspaceId, flowId);

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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-entity
// Drop destination table for one entity, clear its CDC state, and start a fresh backfill.
flowRoutes.post("/:flowId/sync-cdc/reset-entity", async c => {
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

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
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
            error instanceof Error ? error.message : "Execution still running",
        },
        400,
      );
    }

    if (flow.tableDestination?.connectionId && flow.tableDestination?.schema) {
      const destination = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      if (destination) {
        const driver = databaseRegistry.getDriver(destination.type);
        if (driver?.dropTable) {
          const schema = flow.tableDestination.schema;
          const stageSchema =
            destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-column
// Reset one destination column for an entity and optionally start entity backfill.
flowRoutes.post("/:flowId/sync-cdc/reset-column", async c => {
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
    if (configuredEntities.length > 0 && !configuredEntities.includes(entity)) {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover
flowRoutes.post("/:flowId/sync-cdc/recover", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-stream
flowRoutes.post("/:flowId/sync-cdc/recover-stream", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-backfill
flowRoutes.post("/:flowId/sync-cdc/recover-backfill", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;

    const result = await cdcBackfillService.startBackfill(workspaceId, flowId, {
      reuseExistingRunId: true,
      reason: "Backfill restarted via recover-backfill (from checkpoint)",
    });
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reprocess-stale
flowRoutes.post("/:flowId/sync-cdc/reprocess-stale", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/materialize/retry-failed
flowRoutes.post("/:flowId/sync-cdc/materialize/retry-failed", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/webhook/provision
flowRoutes.post("/:flowId/webhook/provision", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;

    const body = await c.req.json().catch(() => ({}));

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }
    if (flow.type !== "webhook") {
      return c.json(
        { success: false, error: "Webhook provisioning requires webhook flow" },
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resync
flowRoutes.post("/:flowId/sync-cdc/resync", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;
    const body = await c.req.json().catch(() => ({}));
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/start
flowRoutes.post("/:flowId/sync-cdc/stream/start", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/pause
flowRoutes.post("/:flowId/sync-cdc/stream/pause", async c => {
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/pause
flowRoutes.post("/:flowId/sync-cdc/pause", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;
    const result = await cdcBackfillService.pauseBackfill(workspaceId, flowId);
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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resume
flowRoutes.post("/:flowId/sync-cdc/resume", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;
    const result = await cdcBackfillService.resumeBackfill(workspaceId, flowId);
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
});

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/status
// Unified CDC observability — 3 queries (Flow, CdcEntityState, recent transitions).
// Replaces the old /summary (11 queries) and /diagnostics (500-event scan) endpoints.
flowRoutes.get("/:flowId/sync-cdc/status", async c => {
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
      webhookPendingCount,
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
          state => typeof state.entity === "string" && state.entity.length > 0,
        )
        .map(state => [state.entity, state] as const),
    );
    const uniqueEntities = Array.from(
      new Set([
        ...configuredEntities,
        ...states
          .map(state => (typeof state.entity === "string" ? state.entity : ""))
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

    const pendingCountMap = new Map(pendingByEntity.map(r => [r._id, r.count]));
    const pendingOldestTsMap = new Map(
      pendingByEntity.flatMap(r =>
        r.oldestIngestTs ? [[r._id, new Date(r.oldestIngestTs)] as const] : [],
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
      const backlogCount = Math.max(
        pendingCountMap.get(entity) || 0,
        ingestSeq - materializedSeq,
        state?.backlogCount || 0,
      );
      const oldestPendingTs = pendingOldestTsMap.get(entity) ?? null;
      return {
        entity,
        lastIngestSeq: ingestSeq,
        lastMaterializedSeq: materializedSeq,
        backlogCount,
        lagSeconds:
          backlogCount > 0
            ? oldestPendingTs
              ? toLagSeconds(oldestPendingTs)
              : toLagSeconds(lastMaterializedAt)
            : 0,
        lastMaterializedAt,
        destinationRowCount: (state as any)?.destinationRowCount ?? null,
        lifetimeEventsProcessed,
        lifetimeRowsApplied,
        backfillDone,
        failedCount: failedByEntity.get(entity)?.count || 0,
        lastFailedAt: failedByEntity.get(entity)?.latestAt || null,
        lastFailedError: failedByEntity.get(entity)?.latestError || null,
      };
    });

    const totalBacklog = entities.reduce((sum, e) => sum + e.backlogCount, 0);
    const materializedDates = entities
      .map(e => e.lastMaterializedAt)
      .filter((d): d is Date => d instanceof Date);
    let lagSeconds: number | null;
    if (totalBacklog === 0) {
      lagSeconds = 0;
    } else {
      const oldestPendingTs = Array.from(pendingOldestTsMap.values()).sort(
        (a, b) => a.getTime() - b.getTime(),
      )[0];
      if (oldestPendingTs) {
        lagSeconds = toLagSeconds(oldestPendingTs);
      } else {
        const oldestMaterialized = entities
          .filter(e => e.backlogCount > 0)
          .map(e => e.lastMaterializedAt)
          .filter((d): d is Date => d instanceof Date)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        lagSeconds = oldestMaterialized ? toLagSeconds(oldestMaterialized) : -1;
      }
    }

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
      flow.syncStateMeta?.lastErrorMessage || flow.syncStateMeta?.lastErrorCode
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
        webhookPendingCount,
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
});

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/schema-health
// Compare live destination column types against the connector schema to surface drift.
flowRoutes.get("/:flowId/sync-cdc/schema-health", async c => {
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
});

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/destination-counts
// Lazy endpoint — returns destination row counts per entity (may be slow for BigQuery).
flowRoutes.get("/:flowId/sync-cdc/destination-counts", async c => {
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
});

// Backward-compat: /summary and /diagnostics redirect to unified /status
flowRoutes.get("/:flowId/sync-cdc/summary", async c => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/summary", "/status");
  return c.redirect(url.toString(), 307);
});
flowRoutes.get("/:flowId/sync-cdc/diagnostics", async c => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/diagnostics", "/status");
  return c.redirect(url.toString(), 307);
});

// GET /api/workspaces/:workspaceId/flows/:flowId/schema?entity=activities:LeadStatusChange
flowRoutes.get("/:flowId/schema", async c => {
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
        { success: false, error: `No schema available for entity: ${entity}` },
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
});

// GET /api/workspaces/:workspaceId/flows/:flowId/status - Check if flow is running
flowRoutes.get("/:flowId/status", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");

    // Verify flow exists and belongs to workspace
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

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
});

// POST /api/workspaces/:workspaceId/flows/:flowId/cancel - Cancel running flow
flowRoutes.post("/:flowId/cancel", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");
    const body = await c.req.json().catch(() => ({}));
    const { executionId } = body;

    // Verify flow exists and belongs to workspace
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

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
});

// GET /api/workspaces/:workspaceId/flows/:flowId/history - Get execution history
flowRoutes.get("/:flowId/history", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");

    // Verify flow exists and belongs to workspace
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

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
});

// GET full details for a specific execution
flowRoutes.get("/:flowId/executions/:executionId", async c => {
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
});

// GET logs for a specific execution
flowRoutes.get("/:flowId/executions/:executionId/logs", async c => {
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
});

// GET webhook stats for a flow
flowRoutes.get("/:flowId/webhook/stats", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");

    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
      type: "webhook",
    });

    if (!flow) {
      return c.json({ success: false, error: "Webhook flow not found" }, 404);
    }

    // Get recent webhook events
    const recentEvents = await WebhookEvent.find({
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .sort({ receivedAt: -1 })
      .limit(100)
      .lean();

    // Calculate stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      eventsToday,
      completedToday,
      failedToday,
      totalCount,
      deferredCount,
      runningFullSyncExecution,
      cdcStats,
    ] = await Promise.all([
      WebhookEvent.countDocuments({
        flowId: new Types.ObjectId(flowId),
        receivedAt: { $gte: today },
      }),
      WebhookEvent.countDocuments({
        flowId: new Types.ObjectId(flowId),
        receivedAt: { $gte: today },
        status: "completed",
      }),
      WebhookEvent.countDocuments({
        flowId: new Types.ObjectId(flowId),
        receivedAt: { $gte: today },
        status: "failed",
      }),
      WebhookEvent.countDocuments({
        flowId: new Types.ObjectId(flowId),
      }),
      WebhookEvent.countDocuments({
        flowId: new Types.ObjectId(flowId),
        applyStatus: "pending",
      }),
      FlowExecution.findOne({
        flowId: new Types.ObjectId(flowId),
        status: "running",
        "context.syncMode": "full",
      })
        .select({ _id: 1 })
        .lean(),
      getCdcFlowStats({ flowId }),
    ]);
    // Only use terminal events for success-rate math.
    // Pending/processing events should not be counted as successful.
    const terminalToday = completedToday + failedToday;
    const successRate =
      terminalToday > 0 ? (completedToday / terminalToday) * 100 : 100;
    const backfillActive = Boolean(
      flow.backfillState?.status === "running" || runningFullSyncExecution,
    );

    const stats = {
      webhookUrl:
        flow.type === "webhook"
          ? generateWebhookEndpoint(
              workspaceId as string,
              flowId as string,
              getRequestBaseUrl(c),
            )
          : flow.webhookConfig?.endpoint,
      lastReceived: flow.webhookConfig?.lastReceivedAt
        ? new Date(flow.webhookConfig.lastReceivedAt).toISOString()
        : null,
      totalReceived: totalCount,
      eventsToday,
      deferredCount,
      backfillActive,
      cdc: cdcStats,
      successRate: Math.round(successRate),
      recentEvents: recentEvents.slice(0, 10).map(event => ({
        eventId: event.eventId,
        eventType: event.eventType,
        receivedAt: event.receivedAt,
        status: event.status,
        applyStatus: event.applyStatus,
        processingDurationMs: event.processingDurationMs,
      })),
    };

    return c.json({ success: true, data: stats });
  } catch (error) {
    logger.error("Error getting webhook stats", { error });
    return c.json({ success: false, error: "Server error" }, 500);
  }
});

// GET webhook events for a flow
flowRoutes.get("/:flowId/webhook/events", async c => {
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
});

// GET webhook event details
flowRoutes.get("/:flowId/webhook/events/:eventId", async c => {
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
      return c.json({ success: false, error: "Webhook event not found" }, 404);
    }

    return c.json({ success: true, data: event });
  } catch (error) {
    logger.error("Error getting webhook event details", { error });
    return c.json({ success: false, error: "Server error" }, 500);
  }
});

// POST retry webhook event — resets to pending.
// CDC: 2-min cron picks it up. Non-CDC: enqueues via Inngest.
flowRoutes.post("/:flowId/webhook/events/:eventId/retry", async c => {
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

    // Non-CDC flows need explicit Inngest enqueue
    const flowDoc = await Flow.findById(flowId)
      .select("syncEngine destinationDatabaseId tableDestination")
      .lean();
    const destConn =
      flowDoc?.destinationDatabaseId != null
        ? await DatabaseConnection.findById(flowDoc.destinationDatabaseId)
            .select("type")
            .lean()
        : null;
    const isCdc =
      flowDoc?.syncEngine === "cdc" &&
      Boolean((flowDoc as any).tableDestination?.connectionId) &&
      hasCdcDestinationAdapter(destConn?.type);

    if (!isCdc) {
      await enqueueWebhookProcess({
        flowId: event.flowId.toString(),
        eventId: event.eventId,
      });
    }

    return c.json({
      success: true,
      message: isCdc
        ? "Webhook event reset to pending — will be picked up by next cron cycle"
        : "Webhook event queued for retry",
      data: { eventId },
    });
  } catch (error) {
    logger.error("Error retrying webhook event", { error });
    return c.json({ success: false, error: "Server error" }, 500);
  }
});

// POST retry all failed webhook events for a flow — resets to pending.
// CDC: cron picks up. Non-CDC: enqueues each via Inngest.
flowRoutes.post("/:flowId/webhook/events/retry-all-failed", async c => {
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

    // Non-CDC flows: enqueue each event via Inngest
    const flowDoc = await Flow.findById(flowId)
      .select("syncEngine destinationDatabaseId tableDestination")
      .lean();
    const destConn =
      flowDoc?.destinationDatabaseId != null
        ? await DatabaseConnection.findById(flowDoc.destinationDatabaseId)
            .select("type")
            .lean()
        : null;
    const isCdc =
      flowDoc?.syncEngine === "cdc" &&
      Boolean((flowDoc as any).tableDestination?.connectionId) &&
      hasCdcDestinationAdapter(destConn?.type);

    let enqueued = 0;
    if (!isCdc) {
      for (const evt of failedEvents) {
        try {
          await enqueueWebhookProcess({
            flowId: evt.flowId.toString(),
            eventId: evt.eventId,
          });
          enqueued++;
        } catch {
          logger.warn("Failed to enqueue event during retry-all", {
            eventId: evt.eventId,
          });
        }
      }
    }

    return c.json({
      success: true,
      data: {
        retried: failedEvents.length,
        total: failedEvents.length,
        enqueued,
      },
    });
  } catch (error) {
    logger.error("Error retrying all failed webhook events", { error });
    return c.json({ success: false, error: "Server error" }, 500);
  }
});

// POST /api/workspaces/:workspaceId/flows/validate-query - Validate a database query before creating a flow
flowRoutes.post("/validate-query", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const body = await c.req.json();

    const { connectionId, query, database } = body;

    if (!connectionId) {
      return c.json({ success: false, error: "connectionId is required" }, 400);
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
});

// POST /api/workspaces/:workspaceId/flows/dry-run - Dry run a sync configuration
flowRoutes.post("/dry-run", async c => {
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
      return c.json({ success: false, error: "connectionId is required" }, 400);
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
});
