import { Hono } from "hono";
import { Types } from "mongoose";
import {
  UserConnector,
  ConnectorInstance,
  UserConnectorWebhookEvent,
} from "../database/connector-builder-schema";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { loggers, enrichContextWithWorkspace } from "../logging";
import {
  buildConnector,
  executeConnector,
  computeBuildHash,
} from "../connector-builder/sandbox-runner";
import { connectorInputSchema } from "../connector-builder/output-schema";
import { inngest } from "../inngest";

const logger = loggers.connector("builder");

export const connectorBuilderRoutes = new Hono();

// Auth middleware
connectorBuilderRoutes.use("*", unifiedAuthMiddleware);

// Workspace access verification middleware
connectorBuilderRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
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
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    } else {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// ── UserConnector CRUD ──

// POST /connectors - Create a new user connector
connectorBuilderRoutes.post("/connectors", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const user = c.get("user");
    const body = await c.req.json();

    const connector = await UserConnector.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name || "Untitled Connector",
      description: body.description || "",
      source: {
        code: body.code || getDefaultConnectorCode(),
      },
      metadata: {
        entities: body.entities || [],
        configSchema: body.configSchema || {},
        secretKeys: body.secretKeys || [],
      },
      visibility: body.visibility || "private",
      createdBy: user?.id || "system",
    });

    logger.info("User connector created", {
      connectorId: connector._id,
      workspaceId,
    });

    return c.json({ success: true, data: connector });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to create user connector", { error });
    return c.json({ success: false, error: message }, 500);
  }
});

// GET /connectors - List user connectors
connectorBuilderRoutes.get("/connectors", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const connectors = await UserConnector.find({
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .select(
        "-bundle.js -bundle.sourceMap -versions.bundleJs -versions.bundleSourceMap",
      )
      .sort({ updatedAt: -1 })
      .lean();

    return c.json({ success: true, data: connectors });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to list user connectors", { error });
    return c.json({ success: false, error: message }, 500);
  }
});

// GET /connectors/:id - Get a single user connector
connectorBuilderRoutes.get(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      const connector = await UserConnector.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      return c.json({ success: true, data: connector });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to get user connector", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// PUT /connectors/:id - Update a user connector
connectorBuilderRoutes.put(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.description !== undefined) update.description = body.description;
      if (body.code !== undefined) update["source.code"] = body.code;
      if (body.visibility !== undefined) update.visibility = body.visibility;
      if (body.metadata !== undefined) update.metadata = body.metadata;

      const connector = await UserConnector.findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { $set: update },
        { new: true },
      ).lean();

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      return c.json({ success: true, data: connector });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to update user connector", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// DELETE /connectors/:id - Delete a user connector
connectorBuilderRoutes.delete(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      // Also delete all instances tied to this connector
      await ConnectorInstance.deleteMany({
        connectorId: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      const result = await UserConnector.findOneAndDelete({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!result) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      logger.info("User connector deleted", {
        connectorId: id,
        workspaceId,
      });

      return c.json({ success: true, message: "Connector deleted" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to delete user connector", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// POST /connectors/:id/build - Trigger a build
connectorBuilderRoutes.post(
  "/connectors/:id/build",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const user = c.get("user");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      const connector = await UserConnector.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      logger.info("Building user connector", {
        connectorId: id,
        workspaceId,
      });

      const result = await buildConnector(connector.source.code);

      const hasErrors = result.errors.some(e => e.severity === "error");

      // Store version snapshot on successful build
      if (!hasErrors && result.js) {
        const nextVersion = connector.version + 1;
        connector.bundle = {
          js: result.js,
          sourceMap: result.sourceMap,
          buildHash: result.buildHash,
          buildLog: result.buildLog,
          builtAt: new Date(),
          errors: result.errors,
        };
        connector.source.resolvedDependencies = result.resolvedDependencies;
        connector.version = nextVersion;
        connector.versions.push({
          version: nextVersion,
          code: connector.source.code,
          bundleJs: result.js,
          bundleSourceMap: result.sourceMap,
          buildHash: result.buildHash,
          createdAt: new Date(),
          createdBy: user?.id || "system",
        });
        await connector.save();
      } else {
        // Still save errors/log even on failure
        connector.bundle = {
          ...connector.bundle,
          buildLog: result.buildLog,
          errors: result.errors,
          builtAt: new Date(),
        };
        await connector.save();
      }

      return c.json({
        success: !hasErrors,
        data: {
          buildHash: result.buildHash,
          buildLog: result.buildLog,
          errors: result.errors,
          resolvedDependencies: result.resolvedDependencies,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to build user connector", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// POST /connectors/:id/dev-run - Build-if-changed + execute one chunk
connectorBuilderRoutes.post(
  "/connectors/:id/dev-run",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const user = c.get("user");
      const body = await c.req.json().catch(() => ({}));

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      const connector = await UserConnector.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      // Check if rebuild is needed
      const currentHash = computeBuildHash(connector.source.code);
      let bundleJs = connector.bundle?.js;

      if (!bundleJs || connector.bundle?.buildHash !== currentHash) {
        logger.info("Rebuilding connector for dev-run", {
          connectorId: id,
          reason: !bundleJs ? "no bundle" : "source changed",
        });

        const buildResult = await buildConnector(connector.source.code);
        const hasErrors = buildResult.errors.some(e => e.severity === "error");

        if (hasErrors || !buildResult.js) {
          return c.json({
            success: false,
            data: {
              buildErrors: buildResult.errors,
              buildLog: buildResult.buildLog,
            },
            error: "Build failed",
          });
        }

        bundleJs = buildResult.js;

        // Save the build result
        const nextVersion = connector.version + 1;
        connector.bundle = {
          js: buildResult.js,
          sourceMap: buildResult.sourceMap,
          buildHash: buildResult.buildHash,
          buildLog: buildResult.buildLog,
          builtAt: new Date(),
          errors: buildResult.errors,
        };
        connector.source.resolvedDependencies =
          buildResult.resolvedDependencies;
        connector.version = nextVersion;
        connector.versions.push({
          version: nextVersion,
          code: connector.source.code,
          bundleJs: buildResult.js,
          bundleSourceMap: buildResult.sourceMap,
          buildHash: buildResult.buildHash,
          createdAt: new Date(),
          createdBy: user?.id || "system",
        });
        await connector.save();
      }

      // Build input context
      const input = connectorInputSchema.parse({
        config: body.config || {},
        secrets: body.secrets || {},
        state: body.state || {},
        trigger: body.trigger || { type: "manual" },
      });

      logger.info("Executing dev-run", { connectorId: id, workspaceId });

      const result = await executeConnector(bundleJs, input);

      return c.json({
        success: true,
        data: {
          output: result.output,
          logs: result.logs,
          durationMs: result.durationMs,
          rowCount: result.output.batches.reduce(
            (sum, b) => sum + b.records.length,
            0,
          ),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Dev-run failed", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// ── ConnectorInstance CRUD (Phase 2 preparation) ──

// POST /instances - Create a connector instance
connectorBuilderRoutes.post("/instances", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const user = c.get("user");
    const body = await c.req.json();

    if (!body.connectorId || !Types.ObjectId.isValid(body.connectorId)) {
      return c.json({ success: false, error: "Invalid connector ID" }, 400);
    }

    // Verify connector exists in this workspace
    const connector = await UserConnector.findOne({
      _id: new Types.ObjectId(body.connectorId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!connector) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    const instance = await ConnectorInstance.create({
      workspaceId: new Types.ObjectId(workspaceId),
      connectorId: new Types.ObjectId(body.connectorId),
      name: body.name || `${connector.name} Instance`,
      secrets: body.secrets || {},
      config: body.config || {},
      output: {
        destinationConnectionId: body.output?.destinationConnectionId
          ? new Types.ObjectId(body.output.destinationConnectionId)
          : undefined,
        destinationDatabase: body.output?.destinationDatabase,
        schema: body.output?.schema,
        tablePrefix: body.output?.tablePrefix,
        schemaEvolutionMode: body.output?.schemaEvolutionMode || "additive",
      },
      triggers: body.triggers || [],
      state: {},
      status: {
        enabled: false,
        runCount: 0,
        consecutiveFailures: 0,
      },
      createdBy: user?.id || "system",
    });

    logger.info("Connector instance created", {
      instanceId: instance._id,
      connectorId: body.connectorId,
      workspaceId,
    });

    return c.json({ success: true, data: instance });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to create connector instance", { error });
    return c.json({ success: false, error: message }, 500);
  }
});

// GET /instances - List instances
connectorBuilderRoutes.get("/instances", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const connectorId = c.req.query("connectorId");

    const filter: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };
    if (connectorId && Types.ObjectId.isValid(connectorId)) {
      filter.connectorId = new Types.ObjectId(connectorId);
    }

    const instances = await ConnectorInstance.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    return c.json({ success: true, data: instances });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to list connector instances", { error });
    return c.json({ success: false, error: message }, 500);
  }
});

// GET /instances/:id - Get instance
connectorBuilderRoutes.get(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const instance = await ConnectorInstance.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({ success: true, data: instance });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to get connector instance", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// PUT /instances/:id - Update instance
connectorBuilderRoutes.put(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.secrets !== undefined) update.secrets = body.secrets;
      if (body.config !== undefined) update.config = body.config;
      if (body.output !== undefined) update.output = body.output;
      if (body.triggers !== undefined) update.triggers = body.triggers;

      const instance = await ConnectorInstance.findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { $set: update },
        { new: true },
      ).lean();

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({ success: true, data: instance });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to update connector instance", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// DELETE /instances/:id - Delete instance
connectorBuilderRoutes.delete(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      // Clean up webhook events
      await UserConnectorWebhookEvent.deleteMany({
        instanceId: new Types.ObjectId(id),
      });

      const result = await ConnectorInstance.findOneAndDelete({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!result) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({ success: true, message: "Instance deleted" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to delete connector instance", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// POST /instances/:id/toggle - Enable/disable instance
connectorBuilderRoutes.post(
  "/instances/:id/toggle",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const instance = await ConnectorInstance.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      instance.status.enabled = !instance.status.enabled;
      await instance.save();

      return c.json({
        success: true,
        data: { enabled: instance.status.enabled },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to toggle connector instance", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// PATCH /instances/:id/state - Update instance state (for reset)
connectorBuilderRoutes.patch(
  "/instances/:id/state",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const instance = await ConnectorInstance.findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { $set: { state: body } },
        { new: true },
      ).lean();

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({ success: true, data: instance });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to update instance state", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// POST /instances/:id/run - Manual production run via Inngest
connectorBuilderRoutes.post(
  "/instances/:id/run",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const instance = await ConnectorInstance.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      // Verify the connector has a built bundle
      const connector = await UserConnector.findById(instance.connectorId);
      if (!connector?.bundle?.js) {
        return c.json(
          { success: false, error: "Connector has not been built yet" },
          400,
        );
      }

      await inngest.send({
        name: "user-connector.execute",
        data: {
          instanceId: id,
          workspaceId,
          trigger: { type: "manual" },
        },
      });

      logger.info("Manual run triggered", { instanceId: id, workspaceId });

      return c.json({ success: true, message: "Execution started" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to trigger manual run", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// POST /instances/:id/cancel - Cancel running execution
connectorBuilderRoutes.post(
  "/instances/:id/cancel",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      await inngest.send({
        name: "user-connector.cancel",
        data: {
          instanceId: id,
          workspaceId,
        },
      });

      return c.json({ success: true, message: "Cancellation requested" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to cancel execution", { error });
      return c.json({ success: false, error: message }, 500);
    }
  },
);

// ── Webhook Reception (no auth required - external services call this) ──

export const connectorBuilderWebhookRoutes = new Hono();

// POST /api/webhooks/:workspaceId/uc/:instanceId - Receive webhook
connectorBuilderWebhookRoutes.post("/:workspaceId/uc/:instanceId", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const instanceId = c.req.param("instanceId");

    if (
      !Types.ObjectId.isValid(workspaceId) ||
      !Types.ObjectId.isValid(instanceId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    const instance = await ConnectorInstance.findOne({
      _id: new Types.ObjectId(instanceId),
      workspaceId: new Types.ObjectId(workspaceId),
      "status.enabled": true,
    }).lean();

    if (!instance) {
      return c.json({ error: "Instance not found or disabled" }, 404);
    }

    // Verify a webhook trigger exists
    const hasWebhookTrigger = instance.triggers.some(t => t.type === "webhook");
    if (!hasWebhookTrigger) {
      return c.json({ error: "No webhook trigger configured" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const eventId =
      (body as any).id ||
      (body as any).event_id ||
      `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const eventType =
      (body as any).type || (body as any).event_type || "webhook";

    // Store webhook event
    await UserConnectorWebhookEvent.create({
      instanceId: new Types.ObjectId(instanceId),
      workspaceId: new Types.ObjectId(workspaceId),
      eventId,
      eventType,
      receivedAt: new Date(),
      status: "pending",
      rawPayload: body,
    }).catch(() => {
      // Ignore duplicate events
    });

    // Send to Inngest for processing
    await inngest.send({
      name: "user-connector.execute",
      data: {
        instanceId,
        workspaceId,
        trigger: {
          type: "webhook",
          payload: body,
        },
      },
    });

    return c.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Webhook reception failed", { error });
    return c.json({ error: message }, 500);
  }
});

// ── Helper ──

function getDefaultConnectorCode(): string {
  return `import type { ConnectorInput, ConnectorOutput } from "./types";

/**
 * Pull data from your source.
 * 
 * ctx.config  - Configuration values
 * ctx.secrets - Encrypted secrets (API keys, etc.)
 * ctx.state   - Persisted state from previous runs
 * ctx.trigger - What triggered this run (manual, cron, webhook)
 * ctx.paginate - Pagination helper (cursor, offset, link strategies)
 * ctx.log     - Structured logging (ctx.log.info, ctx.log.warn, etc.)
 */
export async function pull(ctx: any): Promise<ConnectorOutput> {
  ctx.log.info("Starting connector pull");

  // Example: fetch data from an API
  // const response = await fetch("https://api.example.com/data", {
  //   headers: { Authorization: \`Bearer \${ctx.secrets.API_KEY}\` },
  // });
  // const data = await response.json();

  const sampleRecords = [
    { id: "1", name: "Example Record", created_at: new Date().toISOString() },
  ];

  return {
    batches: [
      {
        entity: "records",
        records: sampleRecords,
        schema: {
          name: "records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "name", type: "string" },
            { name: "created_at", type: "datetime" },
          ],
        },
      },
    ],
    state: {
      ...ctx.state,
      lastRunAt: new Date().toISOString(),
    },
    hasMore: false,
  };
}
`;
}
