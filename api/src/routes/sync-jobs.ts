import { Hono } from "hono";
import {
  SyncJob,
  Connector as DataSource,
  DatabaseConnection,
  JobExecution,
  WebhookEvent,
} from "../database/workspace-schema";
import { Types, PipelineStage } from "mongoose";
import { inngest } from "../inngest";
import { generateWebhookEndpoint } from "../utils/webhook.utils";

export const syncJobRoutes = new Hono();

// GET /api/workspaces/:workspaceId/sync-jobs - List all sync jobs
syncJobRoutes.get("/", async c => {
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

    const jobs = await SyncJob.aggregate(buildPipeline("connectors"));

    return c.json({
      success: true,
      data: jobs,
    });
  } catch (error) {
    console.error("Error listing sync jobs:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/sync-jobs - Create a new sync job
syncJobRoutes.post("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ success: false, error: "Workspace ID is required" }, 400);
    }
    // TODO: Get userId from authentication
    const userId = "system";
    const body = await c.req.json();

    // Validate required fields based on job type
    const jobType = body.type || "scheduled";
    const requiredFields = ["dataSourceId", "destinationDatabaseId"];

    // Schedule is only required for scheduled jobs
    if (jobType === "scheduled") {
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

    // Create sync job with type-specific configuration
    const syncJobData: any = {
      workspaceId: new Types.ObjectId(workspaceId),
      type: jobType,
      dataSourceId: new Types.ObjectId(body.dataSourceId),
      destinationDatabaseId: new Types.ObjectId(body.destinationDatabaseId),
      destinationDatabaseName:
        typeof body.destinationDatabaseName === "string" &&
        body.destinationDatabaseName.trim().length > 0
          ? body.destinationDatabaseName.trim()
          : undefined,
      entityFilter: body.entityFilter || [],
      syncMode: body.syncMode || "full",
      enabled: body.enabled !== false,
      createdBy: userId,
    };

    if (jobType === "scheduled") {
      syncJobData.schedule = {
        cron: body.schedule.cron || body.schedule,
        timezone: body.schedule.timezone || body.timezone || "UTC",
      };
    } else if (jobType === "webhook") {
      // Generate webhook configuration
      const webhookEndpoint = generateWebhookEndpoint(
        workspaceId,
        new Types.ObjectId().toString(),
      );
      // Webhook secret must be provided by the user (from Stripe/Close)
      const webhookSecret = body.webhookSecret || "";

      syncJobData.webhookConfig = {
        endpoint: webhookEndpoint,
        secret: webhookSecret,
        enabled: true,
      };
    }

    const syncJob = new SyncJob(syncJobData);

    // Update webhook endpoint with actual job ID
    if (jobType === "webhook" && syncJob.webhookConfig) {
      syncJob.webhookConfig.endpoint = generateWebhookEndpoint(
        workspaceId,
        syncJob._id.toString(),
      );
    }

    await syncJob.save();

    // Populate references for response
    await syncJob.populate("dataSourceId", "name type");
    await syncJob.populate("destinationDatabaseId", "name type");

    return c.json({
      success: true,
      data: syncJob,
    });
  } catch (error) {
    console.error("Error creating sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/sync-jobs/:jobId - Get job details
syncJobRoutes.get("/:jobId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .populate("dataSourceId", "name type config")
      .populate("destinationDatabaseId", "name type");

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    return c.json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("Error getting sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PUT /api/workspaces/:workspaceId/sync-jobs/:jobId - Update job
syncJobRoutes.put("/:jobId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const body = await c.req.json();

    // Find and validate job
    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    // Update allowed fields
    if (job.type === "scheduled" && body.schedule) {
      job.schedule = {
        cron: body.schedule.cron || body.schedule,
        timezone: body.schedule.timezone || job.schedule.timezone,
      };
    }
    if (body.destinationDatabaseName !== undefined) {
      job.destinationDatabaseName =
        typeof body.destinationDatabaseName === "string" &&
        body.destinationDatabaseName.trim().length > 0
          ? body.destinationDatabaseName.trim()
          : undefined;
    }
    if (body.entityFilter !== undefined) job.entityFilter = body.entityFilter;
    if (body.syncMode) job.syncMode = body.syncMode;
    if (body.enabled !== undefined) job.enabled = body.enabled;

    // Update webhook-specific fields
    if (job.type === "webhook" && job.webhookConfig) {
      // Handle webhookSecret directly from body
      if (body.webhookSecret !== undefined) {
        job.webhookConfig.secret = body.webhookSecret;
      }

      // Handle other webhook config fields
      if (body.webhookConfig) {
        if (body.webhookConfig.enabled !== undefined) {
          job.webhookConfig.enabled = body.webhookConfig.enabled;
        }
      }
    }

    await job.save();

    // Populate references for response
    await job.populate("dataSourceId", "name type");
    await job.populate("destinationDatabaseId", "name type");

    return c.json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("Error updating sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/sync-jobs/:jobId - Delete job
syncJobRoutes.delete("/:jobId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    const result = await SyncJob.deleteOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (result.deletedCount === 0) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    return c.json({
      success: true,
      message: "Sync job deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/sync-jobs/:jobId/toggle - Enable/disable job
syncJobRoutes.post("/:jobId/toggle", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    job.enabled = !job.enabled;
    await job.save();

    return c.json({
      success: true,
      data: {
        enabled: job.enabled,
        message: `Sync job ${job.enabled ? "enabled" : "disabled"} successfully`,
      },
    });
  } catch (error) {
    console.error("Error toggling sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/sync-jobs/:jobId/run - Manually trigger job
syncJobRoutes.post("/:jobId/run", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .populate("dataSourceId")
      .populate("destinationDatabaseId");

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    // Trigger sync job via Inngest
    const eventId = await inngest.send({
      name: "sync/job.manual",
      data: {
        jobId: job._id.toString(),
      },
    });

    return c.json({
      success: true,
      message: "Sync job triggered successfully",
      data: {
        jobId: job._id,
        eventId,
        startedAt: new Date(),
      },
    });
  } catch (error) {
    console.error("Error running sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/sync-jobs/:jobId/status - Check if job is running
syncJobRoutes.get("/:jobId/status", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    // Verify job exists and belongs to workspace
    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    // Check for running executions
    const runningExecution = await JobExecution.findOne({
      jobId: new Types.ObjectId(jobId),
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
    console.error("Error checking sync job status:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/sync-jobs/:jobId/cancel - Cancel running job
syncJobRoutes.post("/:jobId/cancel", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const body = await c.req.json().catch(() => ({}));
    const { executionId } = body;

    // Verify job exists and belongs to workspace
    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    let executionIdToCancel = executionId;

    // If no executionId provided, find the running execution
    if (!executionIdToCancel) {
      const runningExecution = await JobExecution.findOne({
        jobId: new Types.ObjectId(jobId),
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
      name: "sync/job.cancel",
      data: {
        jobId: job._id.toString(),
        executionId: executionIdToCancel,
      },
    });

    return c.json({
      success: true,
      message: "Cancellation request sent successfully",
      data: {
        jobId: job._id,
        executionId: executionIdToCancel,
        eventId,
      },
    });
  } catch (error) {
    console.error("Error cancelling sync job:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/sync-jobs/:jobId/history - Get execution history
syncJobRoutes.get("/:jobId/history", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");

    // Verify job exists and belongs to workspace
    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!job) {
      return c.json({ success: false, error: "Sync job not found" }, 404);
    }

    // Fetch executions from job_executions collection
    const executions = await JobExecution.find({
      jobId: new Types.ObjectId(jobId),
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
        total: await JobExecution.countDocuments({
          jobId: new Types.ObjectId(jobId),
          workspaceId: new Types.ObjectId(workspaceId),
        }),
        limit,
        offset,
        history: formatted,
      },
    });
  } catch (error) {
    console.error("Error getting sync job history:", error);
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
syncJobRoutes.get("/:jobId/executions/:executionId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const executionId = c.req.param("executionId");

    const execution = await JobExecution.findOne({
      _id: new Types.ObjectId(executionId),
      jobId: new Types.ObjectId(jobId),
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
syncJobRoutes.get("/:jobId/executions/:executionId/logs", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const executionId = c.req.param("executionId");

    const execution = await JobExecution.findOne({
      _id: new Types.ObjectId(executionId),
      jobId: new Types.ObjectId(jobId),
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

// GET webhook stats for a job
syncJobRoutes.get("/:jobId/webhook/stats", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");

    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
      type: "webhook",
    });

    if (!job) {
      return c.json({ success: false, error: "Webhook job not found" }, 404);
    }

    // Get recent webhook events
    const recentEvents = await WebhookEvent.find({
      jobId: new Types.ObjectId(jobId),
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
      webhookUrl: job.webhookConfig?.endpoint,
      lastReceived: job.webhookConfig?.lastReceivedAt
        ? new Date(job.webhookConfig.lastReceivedAt).toISOString()
        : null,
      totalReceived: job.webhookConfig?.totalReceived || 0,
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

// GET webhook events for a job
syncJobRoutes.get("/:jobId/webhook/events", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");
    const status = c.req.query("status");

    const job = await SyncJob.findOne({
      _id: new Types.ObjectId(jobId),
      workspaceId: new Types.ObjectId(workspaceId),
      type: "webhook",
    });

    if (!job) {
      return c.json({ success: false, error: "Webhook job not found" }, 404);
    }

    const query: any = {
      jobId: new Types.ObjectId(jobId),
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
syncJobRoutes.get("/:jobId/webhook/events/:eventId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const eventId = c.req.param("eventId");

    const event = await WebhookEvent.findOne({
      _id: new Types.ObjectId(eventId),
      jobId: new Types.ObjectId(jobId),
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
syncJobRoutes.post("/:jobId/webhook/events/:eventId/retry", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const eventId = c.req.param("eventId");

    const event = await WebhookEvent.findOne({
      _id: new Types.ObjectId(eventId),
      jobId: new Types.ObjectId(jobId),
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
        jobId: event.jobId.toString(),
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
