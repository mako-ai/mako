import { Hono } from "hono";
import {
  DbSync,
  DbSyncExecution,
  DatabaseConnection,
  IDbSync,
} from "../database/workspace-schema";
import { Types, PipelineStage } from "mongoose";
import { inngest } from "../inngest";
import { databaseRegistry } from "../databases/registry";

export const dbSyncRoutes = new Hono();

/**
 * GET /api/workspaces/:workspaceId/db-syncs - List all db-syncs
 */
dbSyncRoutes.get("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");

    const pipeline: PipelineStage[] = [
      { $match: { workspaceId: new Types.ObjectId(workspaceId) } },
      {
        $lookup: {
          from: "databaseconnections",
          localField: "source.databaseConnectionId",
          foreignField: "_id",
          as: "sourceDatabase",
        },
      },
      {
        $lookup: {
          from: "databaseconnections",
          localField: "target.databaseConnectionId",
          foreignField: "_id",
          as: "targetDatabase",
        },
      },
      { $unwind: { path: "$sourceDatabase", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$targetDatabase", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          workspaceId: 1,
          name: 1,
          source: {
            databaseConnectionId: 1,
            database: 1,
            query: 1,
          },
          target: {
            databaseConnectionId: 1,
            database: 1,
            schema: 1,
            tableName: 1,
            createIfNotExists: 1,
          },
          syncMode: 1,
          schedule: 1,
          incrementalConfig: 1,
          conflictConfig: 1,
          batchSize: 1,
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
          "sourceDatabase._id": 1,
          "sourceDatabase.name": 1,
          "sourceDatabase.connection.type": 1,
          "targetDatabase._id": 1,
          "targetDatabase.name": 1,
          "targetDatabase.connection.type": 1,
        },
      },
      { $sort: { name: 1 } },
    ];

    const dbSyncs = await DbSync.aggregate(pipeline);

    return c.json({
      success: true,
      data: dbSyncs,
    });
  } catch (error) {
    console.error("Error listing db-syncs:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /api/workspaces/:workspaceId/db-syncs/:id - Get a specific db-sync
 */
dbSyncRoutes.get("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .populate("source.databaseConnectionId", "name connection.type")
      .populate("target.databaseConnectionId", "name connection.type");

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    return c.json({
      success: true,
      data: dbSync,
    });
  } catch (error) {
    console.error("Error getting db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * POST /api/workspaces/:workspaceId/db-syncs - Create a new db-sync
 */
dbSyncRoutes.post("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ success: false, error: "Workspace ID is required" }, 400);
    }

    // Get userId from context (set by auth middleware)
    const userId = c.get("userId") || "system";
    const body = await c.req.json();

    // Validate required fields
    const requiredFields = [
      "name",
      "source.databaseConnectionId",
      "source.query",
      "target.databaseConnectionId",
      "target.tableName",
      "schedule.cron",
    ];

    for (const field of requiredFields) {
      const parts = field.split(".");
      let value: any = body;
      for (const part of parts) {
        value = value?.[part];
      }
      if (!value) {
        return c.json({ success: false, error: `${field} is required` }, 400);
      }
    }

    // Validate source database exists and belongs to workspace
    const sourceDb = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(body.source.databaseConnectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!sourceDb) {
      return c.json({ success: false, error: "Source database not found" }, 404);
    }

    // Validate target database exists and belongs to workspace
    const targetDb = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(body.target.databaseConnectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!targetDb) {
      return c.json({ success: false, error: "Target database not found" }, 404);
    }

    // Validate target database driver supports writes
    const targetDriver = databaseRegistry.getDriver(targetDb.connection.type);
    if (!targetDriver) {
      return c.json(
        { success: false, error: `No driver found for database type: ${targetDb.connection.type}` },
        400,
      );
    }

    if (!targetDriver.supportsWrites?.()) {
      return c.json(
        { success: false, error: `Target database type '${targetDb.connection.type}' does not support write operations` },
        400,
      );
    }

    // Validate incremental config if syncMode is incremental
    if (body.syncMode === "incremental") {
      if (!body.incrementalConfig?.trackingColumn) {
        return c.json(
          { success: false, error: "trackingColumn is required for incremental sync" },
          400,
        );
      }
      if (!body.conflictConfig?.keyColumns?.length) {
        return c.json(
          { success: false, error: "keyColumns are required for incremental sync" },
          400,
        );
      }
    }

    // Create the db-sync
    const dbSync = await DbSync.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name,
      source: {
        databaseConnectionId: new Types.ObjectId(body.source.databaseConnectionId),
        database: body.source.database,
        query: body.source.query,
      },
      target: {
        databaseConnectionId: new Types.ObjectId(body.target.databaseConnectionId),
        database: body.target.database,
        schema: body.target.schema,
        tableName: body.target.tableName,
        createIfNotExists: body.target.createIfNotExists ?? true,
      },
      syncMode: body.syncMode || "full",
      schedule: {
        cron: body.schedule.cron,
        timezone: body.schedule.timezone || "UTC",
      },
      incrementalConfig: body.incrementalConfig
        ? {
            trackingColumn: body.incrementalConfig.trackingColumn,
            trackingType: body.incrementalConfig.trackingType || "timestamp",
            lastValue: body.incrementalConfig.lastValue,
          }
        : undefined,
      conflictConfig: body.conflictConfig
        ? {
            keyColumns: body.conflictConfig.keyColumns,
            strategy: body.conflictConfig.strategy || "upsert",
          }
        : undefined,
      batchSize: body.batchSize || 2000,
      enabled: body.enabled ?? true,
      createdBy: userId,
    });

    return c.json(
      {
        success: true,
        data: dbSync,
      },
      201,
    );
  } catch (error) {
    console.error("Error creating db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * PATCH /api/workspaces/:workspaceId/db-syncs/:id - Update a db-sync
 */
dbSyncRoutes.patch("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const body = await c.req.json();

    // Find existing db-sync
    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    // Build update object
    const update: any = {};

    if (body.name !== undefined) update.name = body.name;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.batchSize !== undefined) update.batchSize = body.batchSize;

    // Update source
    if (body.source) {
      if (body.source.databaseConnectionId) {
        // Validate source database
        const sourceDb = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.source.databaseConnectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!sourceDb) {
          return c.json({ success: false, error: "Source database not found" }, 404);
        }
        update["source.databaseConnectionId"] = new Types.ObjectId(
          body.source.databaseConnectionId,
        );
      }
      if (body.source.database !== undefined) {
        update["source.database"] = body.source.database;
      }
      if (body.source.query !== undefined) {
        update["source.query"] = body.source.query;
      }
    }

    // Update target
    if (body.target) {
      if (body.target.databaseConnectionId) {
        // Validate target database
        const targetDb = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.target.databaseConnectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!targetDb) {
          return c.json({ success: false, error: "Target database not found" }, 404);
        }

        // Validate target supports writes
        const targetDriver = databaseRegistry.getDriver(targetDb.connection.type);
        if (!targetDriver?.supportsWrites?.()) {
          return c.json(
            { success: false, error: `Target database type does not support write operations` },
            400,
          );
        }

        update["target.databaseConnectionId"] = new Types.ObjectId(
          body.target.databaseConnectionId,
        );
      }
      if (body.target.database !== undefined) {
        update["target.database"] = body.target.database;
      }
      if (body.target.schema !== undefined) {
        update["target.schema"] = body.target.schema;
      }
      if (body.target.tableName !== undefined) {
        update["target.tableName"] = body.target.tableName;
      }
      if (body.target.createIfNotExists !== undefined) {
        update["target.createIfNotExists"] = body.target.createIfNotExists;
      }
    }

    // Update sync mode
    if (body.syncMode !== undefined) {
      update.syncMode = body.syncMode;
    }

    // Update schedule
    if (body.schedule) {
      if (body.schedule.cron !== undefined) {
        update["schedule.cron"] = body.schedule.cron;
      }
      if (body.schedule.timezone !== undefined) {
        update["schedule.timezone"] = body.schedule.timezone;
      }
    }

    // Update incremental config
    if (body.incrementalConfig !== undefined) {
      if (body.incrementalConfig === null) {
        update.incrementalConfig = undefined;
      } else {
        update.incrementalConfig = {
          trackingColumn: body.incrementalConfig.trackingColumn,
          trackingType: body.incrementalConfig.trackingType || "timestamp",
          lastValue: body.incrementalConfig.lastValue,
        };
      }
    }

    // Update conflict config
    if (body.conflictConfig !== undefined) {
      if (body.conflictConfig === null) {
        update.conflictConfig = undefined;
      } else {
        update.conflictConfig = {
          keyColumns: body.conflictConfig.keyColumns,
          strategy: body.conflictConfig.strategy || "upsert",
        };
      }
    }

    // Validate incremental sync has required config
    const newSyncMode = update.syncMode ?? dbSync.syncMode;
    if (newSyncMode === "incremental") {
      const newIncrementalConfig = update.incrementalConfig ?? dbSync.incrementalConfig;
      const newConflictConfig = update.conflictConfig ?? dbSync.conflictConfig;

      if (!newIncrementalConfig?.trackingColumn) {
        return c.json(
          { success: false, error: "trackingColumn is required for incremental sync" },
          400,
        );
      }
      if (!newConflictConfig?.keyColumns?.length) {
        return c.json(
          { success: false, error: "keyColumns are required for incremental sync" },
          400,
        );
      }
    }

    const updatedDbSync = await DbSync.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true },
    );

    return c.json({
      success: true,
      data: updatedDbSync,
    });
  } catch (error) {
    console.error("Error updating db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/db-syncs/:id - Delete a db-sync
 */
dbSyncRoutes.delete("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const dbSync = await DbSync.findOneAndDelete({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    // Optionally delete execution history
    await DbSyncExecution.deleteMany({ dbSyncId: new Types.ObjectId(id) });

    return c.json({
      success: true,
      message: "DB Sync deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * POST /api/workspaces/:workspaceId/db-syncs/:id/run - Manually trigger a db-sync
 */
dbSyncRoutes.post("/:id/run", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    // Verify db-sync exists
    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    // Check for recent running execution
    const runningExecution = await DbSyncExecution.findOne({
      dbSyncId: new Types.ObjectId(id),
      status: "running",
      startedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    });

    if (runningExecution) {
      return c.json(
        {
          success: false,
          error: "Sync is already running",
          executionId: runningExecution._id.toString(),
        },
        409,
      );
    }

    // Trigger the sync via Inngest
    await inngest.send({
      name: "db-sync/manual",
      data: { dbSyncId: id },
    });

    return c.json({
      success: true,
      message: "Sync triggered successfully",
    });
  } catch (error) {
    console.error("Error triggering db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /api/workspaces/:workspaceId/db-syncs/:id/executions - Get execution history
 */
dbSyncRoutes.get("/:id/executions", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    // Verify db-sync exists
    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    const executions = await DbSyncExecution.find({
      dbSyncId: new Types.ObjectId(id),
    })
      .sort({ startedAt: -1 })
      .skip(offset)
      .limit(limit)
      .select("-logs") // Exclude logs for list view
      .lean();

    const total = await DbSyncExecution.countDocuments({
      dbSyncId: new Types.ObjectId(id),
    });

    return c.json({
      success: true,
      data: executions,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + executions.length < total,
      },
    });
  } catch (error) {
    console.error("Error getting db-sync executions:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /api/workspaces/:workspaceId/db-syncs/:id/executions/:executionId - Get specific execution with logs
 */
dbSyncRoutes.get("/:id/executions/:executionId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const executionId = c.req.param("executionId");

    // Verify db-sync exists
    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    const execution = await DbSyncExecution.findOne({
      _id: new Types.ObjectId(executionId),
      dbSyncId: new Types.ObjectId(id),
    }).lean();

    if (!execution) {
      return c.json({ success: false, error: "Execution not found" }, 404);
    }

    return c.json({
      success: true,
      data: execution,
    });
  } catch (error) {
    console.error("Error getting db-sync execution:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * POST /api/workspaces/:workspaceId/db-syncs/:id/toggle - Toggle enabled status
 */
dbSyncRoutes.post("/:id/toggle", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const dbSync = await DbSync.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dbSync) {
      return c.json({ success: false, error: "DB Sync not found" }, 404);
    }

    const updatedDbSync = await DbSync.findByIdAndUpdate(
      id,
      { $set: { enabled: !dbSync.enabled } },
      { new: true },
    );

    return c.json({
      success: true,
      data: updatedDbSync,
      message: `DB Sync ${updatedDbSync?.enabled ? "enabled" : "disabled"}`,
    });
  } catch (error) {
    console.error("Error toggling db-sync:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * POST /api/workspaces/:workspaceId/db-syncs/test-query - Test source query
 */
dbSyncRoutes.post("/test-query", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const body = await c.req.json();

    const { databaseConnectionId, database, query } = body;

    if (!databaseConnectionId || !query) {
      return c.json(
        { success: false, error: "databaseConnectionId and query are required" },
        400,
      );
    }

    // Validate database exists
    const db = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseConnectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!db) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }

    const driver = databaseRegistry.getDriver(db.connection.type);
    if (!driver) {
      return c.json(
        { success: false, error: `No driver found for database type: ${db.connection.type}` },
        400,
      );
    }

    // Execute a limited query (add LIMIT 10 if not present)
    let testQuery = query.trim();
    if (!/\bLIMIT\s+\d+/i.test(testQuery)) {
      testQuery = testQuery.replace(/;?\s*$/, "") + " LIMIT 10";
    }

    const result = await driver.executeQuery(db, testQuery, { databaseName: database });

    if (!result.success) {
      return c.json(
        { success: false, error: result.error || "Query execution failed" },
        400,
      );
    }

    // Infer schema from results
    let inferredSchema = null;
    if (result.data && result.data.length > 0 && driver.inferSchema) {
      inferredSchema = driver.inferSchema(result.data);
    }

    return c.json({
      success: true,
      data: {
        rows: result.data,
        rowCount: result.rowCount,
        inferredSchema,
      },
    });
  } catch (error) {
    console.error("Error testing query:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
