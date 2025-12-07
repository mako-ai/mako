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

export const flowRoutes = new Hono();

// GET /api/workspaces/:workspaceId/flows - List all flows
flowRoutes.get("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");

    const buildPipeline = (sourceCollection: string): PipelineStage[] => [
      { $match: { workspaceId: new Types.ObjectId(workspaceId) } },
      {
        $lookup: {
          from: sourceCollection,
          localField: "dataSourceId",
          foreignField: "_id",
          as: "dataSourceId",
        },
      },
      {
        $lookup: {
          from: "databaseconnections",
          localField: "destinationDatabaseId",
          foreignField: "_id",
          as: "destinationDatabaseId",
        },
      },
      { $unwind: "$dataSourceId" },
      { $unwind: "$destinationDatabaseId" },
      {
        $project: {
          _id: 1,
          workspaceId: 1,
          type: 1,
          destinationDatabaseName: 1,
          schedule: 1,
          webhookConfig: 1,
          entityFilter: 1,
          queries: 1,
          syncMode: 1,
          enabled: 1,
          lastRunAt: 1,
          lastSuccessAt: 1,
          lastError: 1,
          nextRunAt: 1,
          runCount: 1,
          avgDurationMs: 1,
          createdBy: 1,
          createdAt: 1,
          updatedAt: 1,
          "dataSourceId._id": 1,
          "dataSourceId.name": 1,
          "dataSourceId.type": 1,
          "destinationDatabaseId._id": 1,
          "destinationDatabaseId.name": 1,
          "destinationDatabaseId.type": 1,
        },
      },
      {
        $sort: {
          "dataSourceId.name": 1,
          "destinationDatabaseId.name": 1,
        },
      },
    ];

    const flows = await Flow.aggregate(buildPipeline("connectors"));

    return c.json({
      success: true,
      data: flows,
    });
  } catch (error) {
    console.error("Error listing flows:", error);
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

    // Validate required fields based on flow type
    const flowType = body.type || "scheduled";
    const requiredFields = ["dataSourceId", "destinationDatabaseId"];

    // Schedule is only required for scheduled flows
    if (flowType === "scheduled") {
      requiredFields.push("schedule");
    }

    for (const field of requiredFields) {
      if (!body[field]) {
        return c.json({ success: false, error: `${field} is required` }, 400);
      }
    }

    // Validate data source exists and belongs to workspace
    const dataSource = await DataSource.findOne({
      _id: new Types.ObjectId(body.dataSourceId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dataSource) {
      return c.json({ success: false, error: "Data source not found" }, 404);
    }

    // Validate destination database exists and belongs to workspace
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

    // Create flow with type-specific configuration
    const flowData: any = {
      workspaceId: new Types.ObjectId(workspaceId),
      type: flowType,
      dataSourceId: new Types.ObjectId(body.dataSourceId),
      destinationDatabaseId: new Types.ObjectId(body.destinationDatabaseId),
      destinationDatabaseName:
        typeof body.destinationDatabaseName === "string" &&
        body.destinationDatabaseName.trim().length > 0
          ? body.destinationDatabaseName.trim()
          : undefined,
      entityFilter: body.entityFilter || [],
      queries: body.queries || [], // GraphQL/PostHog queries
      syncMode: body.syncMode || "full",
      enabled: body.enabled !== false,
      createdBy: userId,
    };

    if (flowType === "scheduled") {
      flowData.schedule = {
        cron: body.schedule.cron || body.schedule,
        timezone: body.schedule.timezone || body.timezone || "UTC",
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

    // Populate references for response
    await flow.populate("dataSourceId", "name type");
    await flow.populate("destinationDatabaseId", "name type");

    return c.json({
      success: true,
      data: flow,
    });
  } catch (error) {
    console.error("Error creating flow:", error);
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
    })
      .populate("dataSourceId", "name type config")
      .populate("destinationDatabaseId", "name type");

    if (!flow) {
      return c.json({ success: false, error: "Flow not found" }, 404);
    }

    return c.json({
      success: true,
      data: flow,
    });
  } catch (error) {
    console.error("Error getting flow:", error);
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

    // Update allowed fields
    if (flow.type === "scheduled" && body.schedule) {
      flow.schedule = {
        cron: body.schedule.cron || body.schedule,
        timezone: body.schedule.timezone || flow.schedule.timezone,
      };
    }
    if (body.destinationDatabaseName !== undefined) {
      flow.destinationDatabaseName =
        typeof body.destinationDatabaseName === "string" &&
        body.destinationDatabaseName.trim().length > 0
          ? body.destinationDatabaseName.trim()
          : undefined;
    }
    if (body.entityFilter !== undefined) flow.entityFilter = body.entityFilter;
    if (body.queries !== undefined) flow.queries = body.queries; // GraphQL/PostHog queries
    if (body.syncMode) flow.syncMode = body.syncMode;
    if (body.enabled !== undefined) flow.enabled = body.enabled;

    // Update webhook-specific fields
    if (flow.type === "webhook" && flow.webhookConfig) {
      // Handle webhookSecret directly from body
      if (body.webhookSecret !== undefined) {
        flow.webhookConfig.secret = body.webhookSecret;
      }

      // Handle other webhook config fields
      if (body.webhookConfig) {
        if (body.webhookConfig.enabled !== undefined) {
          flow.webhookConfig.enabled = body.webhookConfig.enabled;
        }
      }
    }

    await flow.save();

    // Populate references for response
    await flow.populate("dataSourceId", "name type");
    await flow.populate("destinationDatabaseId", "name type");

    return c.json({
      success: true,
      data: flow,
    });
  } catch (error) {
    console.error("Error updating flow:", error);
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
    console.error("Error deleting flow:", error);
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

    flow.enabled = !flow.enabled;
    await flow.save();

    return c.json({
      success: true,
      data: {
        enabled: flow.enabled,
        message: `Flow ${flow.enabled ? "enabled" : "disabled"} successfully`,
      },
    });
  } catch (error) {
    console.error("Error toggling flow:", error);
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
    console.error("Error running flow:", error);
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
    console.error("Error checking flow status:", error);
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
    console.error("Error cancelling flow:", error);
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
    console.error("Error getting flow history:", error);
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
    console.error("Error getting execution details:", error);
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
    console.error("Error getting execution logs:", error);
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
    console.error("Error getting webhook stats:", error);
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
    console.error("Error getting webhook events:", error);
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
    console.error("Error getting webhook event details:", error);
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
    console.error("Error retrying webhook event:", error);
    return c.json({ success: false, error: "Server error" }, 500);
  }
});

/** @deprecated Use flowRoutes instead */
export const syncJobRoutes = flowRoutes;

