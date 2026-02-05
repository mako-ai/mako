import { Hono } from "hono";
import {
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

const logger = loggers.inngest("flow");

export const flowRoutes = new Hono();

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
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      },
    ];

    const flows = await Flow.aggregate(pipeline);

    return c.json({
      success: true,
      data: flows,
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

      if (!body.tableDestination.tableName) {
        return c.json(
          { success: false, error: "tableDestination.tableName is required" },
          400,
        );
      }

      // Use the table destination connection as the destinationDatabaseId
      destinationDatabaseId = new Types.ObjectId(
        body.tableDestination.connectionId,
      );
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
        flowData.conflictConfig = body.conflictConfig;
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

    // Validate: connector sources don't support tableDestination (they always write to MongoDB)
    if (sourceType === "connector" && body.tableDestination?.connectionId) {
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
      flowData.tableDestination = {
        connectionId: new Types.ObjectId(body.tableDestination.connectionId),
        database: body.tableDestination.database,
        schema: body.tableDestination.schema,
        tableName: body.tableDestination.tableName,
        createIfNotExists: body.tableDestination.createIfNotExists !== false,
      };
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
      const webhookEndpoint = generateWebhookEndpoint(
        workspaceId,
        new Types.ObjectId().toString(),
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
      flow.webhookConfig.endpoint = generateWebhookEndpoint(
        workspaceId,
        flow._id.toString(),
      );
    }

    await flow.save();

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
    const workspaceId = c.req.param("workspaceId");
    const flowId = c.req.param("flowId");

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
        flow.conflictConfig = body.conflictConfig;
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

      // Keep destinationDatabaseId in sync (used for population/lookups)
      if (body.tableDestination.connectionId) {
        flow.destinationDatabaseId = new Types.ObjectId(
          body.tableDestination.connectionId,
        );
      }
    }

    // Update webhook-specific fields
    if (flow.type === "webhook" && flow.webhookConfig) {
      if (body.webhookSecret !== undefined) {
        flow.webhookConfig.secret = body.webhookSecret;
      }
      if (body.webhookConfig) {
        if (body.webhookConfig.enabled !== undefined) {
          flow.webhookConfig.enabled = body.webhookConfig.enabled;
        }
      }
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

    const eventsToday = recentEvents.filter(
      e => new Date(e.receivedAt) >= today,
    ).length;
    const failedEvents = recentEvents.filter(e => e.status === "failed").length;
    const successRate =
      recentEvents.length > 0
        ? ((recentEvents.length - failedEvents) / recentEvents.length) * 100
        : 100;

    const stats = {
      webhookUrl: flow.webhookConfig?.endpoint,
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
