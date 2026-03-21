import { Hono } from "hono";
import {
  CdcChangeEvent,
  Flow,
  Connector as DataSource,
  DatabaseConnection,
  FlowExecution,
  WebhookEvent,
} from "../database/workspace-schema";
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
import { getBigQueryCdcFlowStats } from "../services/bigquery-cdc.service";
import { cdcBackfillService } from "../sync-cdc/backfill.service";
import { cdcObservabilityService } from "../sync-cdc/observability.service";
import { syncMachineService } from "../sync-cdc/state/sync-machine.service";

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

function isLocalhostBase(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return /localhost|127\.0\.0\.1|\[::1\]/i.test(baseUrl);
  }
}

function resolveWebhookEndpoint(params: {
  workspaceId: string;
  flowId: string;
  requestBaseUrl: string;
  existingEndpoint?: string | null;
}): string {
  const generated = generateWebhookEndpoint(
    params.workspaceId,
    params.flowId,
    params.requestBaseUrl,
  );

  const existing = params.existingEndpoint?.trim();
  if (!existing) {
    return generated;
  }

  // Preserve an already-public webhook URL when requests originate from localhost.
  // This avoids clobbering cloudflared/public endpoints during local UI edits.
  if (isLocalhostBase(params.requestBaseUrl) && !isLocalhostBase(existing)) {
    return existing;
  }

  return generated;
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
      if ((flow?.type !== "webhook" && flow?.type !== "cdc") || !flow?._id) {
        return flow;
      }

      const endpoint = resolveWebhookEndpoint({
        workspaceId: workspaceId as string,
        flowId: flow._id.toString(),
        requestBaseUrl,
        existingEndpoint: flow?.webhookConfig?.endpoint,
      });

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
    if (!["scheduled", "webhook", "cdc"].includes(flowType)) {
      return c.json(
        {
          success: false,
          error: "type must be 'scheduled', 'webhook', or 'cdc'",
        },
        400,
      );
    }
    const requestedSyncEngine: "legacy" | "cdc" =
      flowType === "cdc" || body.syncEngine === "cdc" ? "cdc" : "legacy";

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

      if (
        requestedSyncEngine === "legacy" &&
        sourceType === "database" &&
        !body.tableDestination.tableName
      ) {
        return c.json(
          {
            success: false,
            error:
              "tableDestination.tableName is required for legacy database-source flows.",
          },
          400,
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

    if (flowType === "cdc" && sourceType !== "connector") {
      return c.json(
        { success: false, error: "CDC flows support connector sources only" },
        400,
      );
    }
    if (flowType === "cdc" && destinationType !== "bigquery") {
      return c.json(
        {
          success: false,
          error: "CDC flow type requires a BigQuery destination",
        },
        400,
      );
    }
    if (flowType === "cdc" && !body.tableDestination?.connectionId) {
      return c.json(
        {
          success: false,
          error: "CDC flow type requires tableDestination.connectionId",
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
      syncEngine: requestedSyncEngine,
      syncState: "idle",
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

    // Keep legacy connector behavior identical to main:
    // connector sources cannot use tableDestination.
    if (
      sourceType === "connector" &&
      body.tableDestination?.connectionId &&
      requestedSyncEngine === "legacy"
    ) {
      return c.json(
        {
          success: false,
          error:
            "Connector sources do not support tableDestination. Connectors always write to MongoDB. Use a database source for SQL-to-SQL sync.",
        },
        400,
      );
    }

    // Add table destination if specified
    if (body.tableDestination?.connectionId) {
      const td: any = {
        connectionId: new Types.ObjectId(body.tableDestination.connectionId),
        database: body.tableDestination.database,
        schema: body.tableDestination.schema,
        tableName:
          requestedSyncEngine === "cdc"
            ? body.tableDestination.tableName || ""
            : body.tableDestination.tableName,
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

    if (
      requestedSyncEngine === "cdc" &&
      (flowType === "webhook" || flowType === "cdc") &&
      destinationType === "bigquery"
    ) {
      // BigQuery CDC path relies on tombstones for correctness.
      flowData.deleteMode = "soft";
    } else if (requestedSyncEngine === "cdc" && body.deleteMode) {
      flowData.deleteMode = body.deleteMode;
    }
    if (
      requestedSyncEngine === "cdc" &&
      body.entityLayouts &&
      Array.isArray(body.entityLayouts)
    ) {
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
    } else if (flowType === "webhook" || flowType === "cdc") {
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
    if ((flowType === "webhook" || flowType === "cdc") && flow.webhookConfig) {
      const requestBaseUrl = getRequestBaseUrl(c);
      flow.webhookConfig.endpoint = resolveWebhookEndpoint({
        workspaceId,
        flowId: flow._id.toString(),
        requestBaseUrl,
        existingEndpoint: flow.webhookConfig.endpoint,
      });
    }

    await flow.save();

    // Pre-create BigQuery dataset for connector flows (tables created on first write with full schema)
    if (
      requestedSyncEngine === "cdc" &&
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
    if (
      (flow.type === "webhook" || flow.type === "cdc") &&
      flow.webhookConfig
    ) {
      flow.webhookConfig.endpoint = resolveWebhookEndpoint({
        workspaceId: workspaceId as string,
        flowId: flow._id.toString(),
        requestBaseUrl: getRequestBaseUrl(c),
        existingEndpoint: flow.webhookConfig.endpoint,
      });
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
    if (flow.type === "cdc" && body?.syncEngine === "legacy") {
      return c.json(
        { success: false, error: "CDC flow type must use cdc syncEngine" },
        400,
      );
    }
    const requestedSyncEngine =
      body?.syncEngine === "cdc"
        ? "cdc"
        : body?.syncEngine === "legacy"
          ? "legacy"
          : flow.syncEngine;
    const isCdcFlow = flow.type === "cdc" || requestedSyncEngine === "cdc";

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

    // Keep legacy connector behavior identical to main:
    // connector sources cannot use tableDestination.
    if (
      !isCdcFlow &&
      flow.sourceType === "connector" &&
      body.tableDestination?.connectionId
    ) {
      return c.json(
        {
          success: false,
          error:
            "Connector sources do not support tableDestination. Connectors always write to MongoDB. Use a database source for SQL-to-SQL sync.",
        },
        400,
      );
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

      if (isCdcFlow) {
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
      }

      // Keep destinationDatabaseId in sync (used for population/lookups)
      if (body.tableDestination.connectionId) {
        flow.destinationDatabaseId = new Types.ObjectId(
          body.tableDestination.connectionId,
        );
      }
    }

    if (isCdcFlow && (flow.type === "webhook" || flow.type === "cdc")) {
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
    } else if (isCdcFlow && body.deleteMode !== undefined) {
      flow.deleteMode = body.deleteMode;
    }
    if (isCdcFlow && body.entityLayouts !== undefined) {
      (flow as any).entityLayouts = body.entityLayouts;
    }

    // Update webhook-specific fields
    if (
      (flow.type === "webhook" || flow.type === "cdc") &&
      flow.webhookConfig
    ) {
      flow.webhookConfig.endpoint = resolveWebhookEndpoint({
        workspaceId: workspaceId as string,
        flowId: flow._id.toString(),
        requestBaseUrl: getRequestBaseUrl(c),
        existingEndpoint: flow.webhookConfig.endpoint,
      });
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

    const result = await Flow.deleteOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (result.deletedCount === 0) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }

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
    const body = await c.req.json().catch(() => ({}));
    const rawEntities: unknown[] = Array.isArray(body?.entities)
      ? (body.entities as unknown[])
      : [];
    const requestedEntities: string[] = Array.from(
      new Set(
        rawEntities
          .filter(
            (entity): entity is string =>
              typeof entity === "string" && entity.trim().length > 0,
          )
          .map(entity => entity.trim()),
      ),
    );

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
        requestedEntities.length > 0
          ? { entities: requestedEntities }
          : undefined,
      );
      return c.json({
        success: true,
        message: "CDC backfill started",
        data: {
          flowId: flow._id,
          startedAt: new Date(),
          runId: backfill.runId,
          resumed: backfill.reusedRunId,
          entities:
            requestedEntities.length > 0 ? requestedEntities : undefined,
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
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      /already running|active run lock|cannot start backfill/i.test(message)
        ? 409
        : 500;
    return c.json(
      {
        success: false,
        error: message,
      },
      status,
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
    if (flow.type === "cdc" && syncEngine !== "cdc") {
      return c.json(
        { success: false, error: "CDC flow type must use cdc syncEngine" },
        400,
      );
    }

    flow.syncEngine = syncEngine;
    if (syncEngine === "legacy") {
      flow.syncState = "idle";
      flow.syncStateUpdatedAt = new Date();
      flow.syncStateMeta = {
        lastEvent: "ENGINE_SWITCH",
        lastReason: "Switched to legacy engine",
      };
    } else {
      flow.syncState = flow.syncState || "idle";
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
    const body = await c.req.json().catch(() => ({}));
    const rawEntities: unknown[] = Array.isArray(body?.entities)
      ? (body.entities as unknown[])
      : [];
    const requestedEntities: string[] = Array.from(
      new Set(
        rawEntities
          .filter(
            (entity): entity is string =>
              typeof entity === "string" && entity.trim().length > 0,
          )
          .map(entity => entity.trim()),
      ),
    );
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;
    const backfill = await cdcBackfillService.startBackfill(
      workspaceId,
      flowId,
      requestedEntities.length > 0
        ? { entities: requestedEntities }
        : undefined,
    );
    return c.json({
      success: true,
      message: "CDC backfill started",
      data: {
        runId: backfill.runId,
        resumed: backfill.reusedRunId,
        entities: requestedEntities.length > 0 ? requestedEntities : undefined,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      /already running|active run lock|cannot start backfill/i.test(message)
        ? 409
        : 400;
    return c.json(
      {
        success: false,
        error: message,
      },
      status,
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

    const body = await c.req.json().catch(() => ({}));
    const result = await cdcBackfillService.recoverFlow({
      workspaceId,
      flowId,
      retryFailedMaterialization: body.retryFailedMaterialization !== false,
      resumeBackfill: body.resumeBackfill !== false,
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

    const body = await c.req.json().catch(() => ({}));
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
    if (body?.deleteDestination !== true) {
      return c.json(
        {
          success: false,
          error:
            "Restart from scratch requires deleteDestination=true to drop destination live and working tables.",
        },
        400,
      );
    }
    const rawEntities: unknown[] = Array.isArray(body?.entities)
      ? (body.entities as unknown[])
      : [];
    const requestedEntities: string[] = Array.from(
      new Set(
        rawEntities
          .filter(
            (entity): entity is string =>
              typeof entity === "string" && entity.trim().length > 0,
          )
          .map(entity => entity.trim()),
      ),
    );
    await cdcBackfillService.resyncFlow({
      workspaceId,
      flowId,
      deleteDestination: true,
      clearWebhookEvents: Boolean(body.clearWebhookEvents),
      entities: requestedEntities,
    });
    return c.json({
      success: true,
      message: "CDC restart-from-scratch started",
      data: {
        entities: requestedEntities.length > 0 ? requestedEntities : undefined,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /cannot restart from scratch|active run/i.test(message)
      ? 409
      : 400;
    return c.json(
      {
        success: false,
        error: message,
      },
      status,
    );
  }
});

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/restart-preview
flowRoutes.get("/:flowId/sync-cdc/restart-preview", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const authorizationError = await assertOwnerOrAdmin(
      c as AuthenticatedContext,
      workspaceId,
    );
    if (authorizationError) return authorizationError;

    const entitiesParam = c.req.query("entities");
    const requestedEntities =
      typeof entitiesParam === "string" && entitiesParam.trim().length > 0
        ? Array.from(
            new Set(
              entitiesParam
                .split(",")
                .map(entity => entity.trim())
                .filter(entity => entity.length > 0),
            ),
          )
        : [];

    const preview = await cdcBackfillService.getRestartTablePreview({
      workspaceId,
      flowId,
      entities: requestedEntities,
    });

    return c.json({
      success: true,
      data: preview,
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
    await syncMachineService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "PAUSE", reason: "Paused via API" },
    });
    return c.json({ success: true, message: "CDC flow paused" });
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
    await syncMachineService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "RESUME", reason: "Resumed via API" },
    });

    // RESUME transitions paused -> catchup by design. If there is no pending
    // CDC backlog at resume time, emit LAG_CLEARED immediately so the stream
    // returns to live without waiting for another materialization tick.
    const pending = await CdcChangeEvent.countDocuments({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
      materializationStatus: "pending",
    });
    if (pending === 0) {
      await syncMachineService.applyTransition({
        workspaceId,
        flowId,
        event: {
          type: "LAG_CLEARED",
          reason: "Resume with empty backlog",
        },
        context: {
          backlogCount: 0,
          lagSeconds: 0,
          lagThresholdSeconds: 60,
        },
      });
    }

    return c.json({ success: true, message: "CDC flow resumed" });
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

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/summary
flowRoutes.get("/:flowId/sync-cdc/summary", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const summary = await cdcObservabilityService.getSummary(
      workspaceId,
      flowId,
    );
    return c.json({ success: true, data: summary });
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

// GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/diagnostics
flowRoutes.get("/:flowId/sync-cdc/diagnostics", async c => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const flowId = c.req.param("flowId") as string;
    const diagnostics = await cdcObservabilityService.getDiagnostics(
      workspaceId,
      flowId,
    );
    return c.json({ success: true, data: diagnostics });
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

    // Mark execution cancelled immediately so the running worker can cooperatively
    // stop on its next cancellation checkpoint without waiting for async event lag.
    const now = new Date();
    await FlowExecution.updateOne(
      {
        _id: new Types.ObjectId(executionIdToCancel),
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        status: "running",
      },
      {
        $set: {
          status: "cancelled",
          success: false,
          completedAt: now,
          lastHeartbeat: now,
          error: {
            message: "Flow execution cancelled by user",
            code: "USER_CANCELLED",
          },
        },
      },
    );

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
      error: ex.error?.message,
      duration: ex.duration,
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
      type: { $in: ["webhook", "cdc"] },
    });

    if (!flow) {
      return c.json(
        { success: false, error: "Webhook/CDC flow not found" },
        404,
      );
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

    const webhookUrl = resolveWebhookEndpoint({
      workspaceId: workspaceId as string,
      flowId: flowId as string,
      requestBaseUrl: getRequestBaseUrl(c),
      existingEndpoint: flow.webhookConfig?.endpoint,
    });
    const isCdcFlow = flow.type === "cdc" || flow.syncEngine === "cdc";

    let stats: any;
    if (isCdcFlow) {
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
        getBigQueryCdcFlowStats({ flowId }),
      ]);
      // Only use terminal events for success-rate math.
      // Pending/processing events should not be counted as successful.
      const terminalToday = completedToday + failedToday;
      const successRate =
        terminalToday > 0 ? (completedToday / terminalToday) * 100 : 100;
      const backfillActive = Boolean(
        flow.backfillState?.active || runningFullSyncExecution,
      );

      stats = {
        webhookUrl,
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
    } else {
      const eventsToday = recentEvents.filter(
        e => new Date(e.receivedAt) >= today,
      ).length;
      const failedEvents = recentEvents.filter(
        e => e.status === "failed",
      ).length;
      const successRate =
        recentEvents.length > 0
          ? ((recentEvents.length - failedEvents) / recentEvents.length) * 100
          : 100;

      stats = {
        webhookUrl,
        lastReceived: flow.webhookConfig?.lastReceivedAt
          ? new Date(flow.webhookConfig.lastReceivedAt).toISOString()
          : null,
        totalReceived: flow.webhookConfig?.totalReceived || 0,
        eventsToday,
        successRate: Math.round(successRate),
        recentEvents: recentEvents.slice(0, 10).map(event => ({
          eventId: event.eventId,
          eventType: event.eventType,
          receivedAt: event.receivedAt,
          status: event.status,
          processingDurationMs: event.processingDurationMs,
        })),
      };
    }

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
      type: { $in: ["webhook", "cdc"] },
    });

    if (!flow) {
      return c.json(
        { success: false, error: "Webhook/CDC flow not found" },
        404,
      );
    }

    const query: any = {
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    };

    if (status) {
      query.status = status;
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
          ...(flow.type === "cdc" || flow.syncEngine === "cdc"
            ? { applyStatus: event.applyStatus }
            : {}),
          attempts: event.attempts,
          error: event.error,
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

// POST retry webhook event
flowRoutes.post("/:flowId/webhook/events/:eventId/retry", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");
    const eventId = c.req.param("eventId");

    const event = await WebhookEvent.findOne({
      _id: new Types.ObjectId(eventId),
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
      status: { $in: ["failed", "completed"] }, // Can retry failed or completed events
    });

    if (!event) {
      return c.json(
        {
          success: false,
          error: "Webhook event not found or cannot be retried",
        },
        404,
      );
    }

    // Reset event for retry
    event.status = "pending";
    await event.save();

    // Trigger processing
    await inngest.send({
      name: "webhook/event.process",
      data: {
        flowId: event.flowId.toString(),
        eventId: event.eventId,
      },
    });

    return c.json({
      success: true,
      message: "Webhook event queued for retry",
      data: {
        eventId: event._id,
      },
    });
  } catch (error) {
    logger.error("Error retrying webhook event", { error });
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
