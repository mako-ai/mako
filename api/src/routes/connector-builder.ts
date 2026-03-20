import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  ConnectorInstance,
  UserConnector,
  type IConnectorInstance,
  type IUserConnector,
} from "../database/connector-builder-schema";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { enrichContextWithWorkspace, loggers } from "../logging";
import { workspaceService } from "../services/workspace.service";
import {
  sandboxRunner,
  type ConnectorBuildResult,
  type ConnectorExecutionInput,
} from "../connector-builder/sandbox-runner";
import { mapRuntimeError } from "../connector-builder/error-mapper";

const logger = loggers.api("connector-builder");
const DEFAULT_CONNECTOR_CODE = `export async function pull(input) {
  const now = new Date().toISOString();

  return {
    hasMore: false,
    state: input.state ?? {},
    batches: [
      {
        entity: "records",
        rows: [
          {
            id: 1,
            name: "example",
            receivedAt: now,
            configEcho: input.config?.example ?? null,
          },
        ],
      },
    ],
    schemas: [
      {
        entity: "records",
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "number" },
          { name: "name", type: "string" },
          { name: "receivedAt", type: "datetime" },
          { name: "configEcho", type: "string", nullable: true },
        ],
      },
    ],
  };
}
`;

const connectorBuilderRoutes = new Hono();

const createConnectorSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  code: z.string().optional(),
  visibility: z.enum(["workspace", "public"]).optional(),
});

const updateConnectorSchema = createConnectorSchema.partial();

const devRunSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  trigger: z
    .object({
      type: z.enum(["manual", "webhook", "schedule"]).optional(),
      payload: z.unknown().optional(),
    })
    .optional(),
});

const connectorTriggerSchema = z.object({
  type: z.enum(["manual", "schedule", "webhook"]),
  enabled: z.boolean().optional(),
  cron: z.string().optional(),
  path: z.string().optional(),
});

const connectorInstanceSchema = z.object({
  connectorId: z.string().optional(),
  name: z.string().trim().min(1).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  output: z
    .object({
      destinationDatabaseId: z.string().optional(),
      destinationSchema: z.string().optional(),
      destinationTablePrefix: z.string().optional(),
      evolutionMode: z
        .enum(["strict", "append", "variant", "relaxed"])
        .optional(),
    })
    .optional(),
  triggers: z.array(connectorTriggerSchema).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["idle", "active", "running", "error", "disabled"]).optional(),
});

const createConnectorInstanceSchema = connectorInstanceSchema.extend({
  connectorId: z.string(),
  name: z.string().trim().min(1),
});

const updateConnectorInstanceSchema = connectorInstanceSchema.partial();

connectorBuilderRoutes.use("*", unifiedAuthMiddleware);

connectorBuilderRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ success: false, error: "Workspace ID is required" }, 400);
  }

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
  await next();
});

function getActorId(c: AuthenticatedContext): string {
  const user = c.get("user");
  return user?.id ?? "api-key";
}

function serializeUserConnector(
  connector: Pick<
    IUserConnector,
    | "_id"
    | "workspaceId"
    | "name"
    | "description"
    | "source"
    | "bundle"
    | "metadata"
    | "version"
    | "versions"
    | "visibility"
    | "createdBy"
    | "createdAt"
    | "updatedAt"
  >,
) {
  return {
    ...connector,
    _id: connector._id.toString(),
    workspaceId: connector.workspaceId.toString(),
    versions: connector.versions.map(version => ({
      ...version,
      builtAt: version.builtAt?.toISOString(),
      createdAt: version.createdAt.toISOString(),
    })),
    bundle: {
      ...connector.bundle,
      builtAt: connector.bundle.builtAt?.toISOString(),
    },
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString(),
  };
}

function serializeConnectorInstance(
  instance: Pick<
    IConnectorInstance,
    | "_id"
    | "workspaceId"
    | "connectorId"
    | "name"
    | "secrets"
    | "config"
    | "output"
    | "triggers"
    | "state"
    | "status"
    | "lastRunAt"
    | "lastSuccessAt"
    | "lastError"
    | "createdBy"
    | "createdAt"
    | "updatedAt"
  >,
) {
  return {
    ...instance,
    _id: instance._id.toString(),
    workspaceId: instance.workspaceId.toString(),
    connectorId: instance.connectorId.toString(),
    output: {
      ...instance.output,
      destinationDatabaseId: instance.output.destinationDatabaseId?.toString(),
    },
    lastRunAt: instance.lastRunAt?.toISOString(),
    lastSuccessAt: instance.lastSuccessAt?.toISOString(),
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

async function getWorkspaceConnector(
  workspaceId: string,
  connectorId: string,
): Promise<IUserConnector | null> {
  if (!Types.ObjectId.isValid(connectorId)) {
    return null;
  }

  return UserConnector.findOne({
    _id: new Types.ObjectId(connectorId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
}

async function getWorkspaceInstance(
  workspaceId: string,
  instanceId: string,
): Promise<IConnectorInstance | null> {
  if (!Types.ObjectId.isValid(instanceId)) {
    return null;
  }

  return ConnectorInstance.findOne({
    _id: new Types.ObjectId(instanceId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
}

async function ensureConnectorBundle(
  connector: IUserConnector,
  actorId: string,
): Promise<{
  connector: IUserConnector;
  build: ConnectorBuildResult;
}> {
  const build = await sandboxRunner.build(connector.source.code);

  if (build.errors.length > 0 || !build.js) {
    return { connector, build };
  }

  const shouldPersist =
    connector.bundle.buildHash !== build.buildHash ||
    connector.bundle.js !== build.js ||
    connector.bundle.sourceMap !== build.sourceMap ||
    connector.source.resolvedDependencies.join(",") !==
      build.resolvedDependencies.join(",");

  if (shouldPersist) {
    connector.source.resolvedDependencies = build.resolvedDependencies;
    connector.bundle = {
      js: build.js,
      sourceMap: build.sourceMap,
      buildHash: build.buildHash,
      buildLog: build.buildLog,
      errors: build.errors,
      builtAt: new Date(build.builtAt),
      runtime: build.runtime,
    };

    const hasVersionForBuild = connector.versions.some(
      version => version.buildHash === build.buildHash,
    );

    if (!hasVersionForBuild) {
      connector.version += 1;
      connector.versions.push({
        version: connector.version,
        code: connector.source.code,
        buildHash: build.buildHash,
        builtAt: new Date(build.builtAt),
        createdAt: new Date(),
        createdBy: actorId,
        resolvedDependencies: build.resolvedDependencies,
      });
    }

    await connector.save();
  }

  return { connector, build };
}

connectorBuilderRoutes.post("/connectors", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const parsed = createConnectorSchema.parse(await c.req.json());
    const actorId = getActorId(c);

    const connector = await UserConnector.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: parsed.name,
      description: parsed.description,
      source: {
        code: parsed.code ?? DEFAULT_CONNECTOR_CODE,
        resolvedDependencies: [],
      },
      bundle: {
        errors: [],
      },
      metadata: {
        language: "typescript",
        entrypoint: "pull",
        runtime: "nodejs",
        tags: [],
      },
      version: 1,
      versions: [],
      visibility: parsed.visibility ?? "workspace",
      createdBy: actorId,
    });

    return c.json(
      {
        success: true,
        data: serializeUserConnector(connector.toObject()),
      },
      201,
    );
  } catch (error) {
    logger.error("Failed to create connector builder connector", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create connector",
      },
      500,
    );
  }
});

connectorBuilderRoutes.get("/connectors", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const connectors = await UserConnector.find({
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .sort({ updatedAt: -1 })
      .lean();

    return c.json({
      success: true,
      data: connectors.map(connector =>
        serializeUserConnector(connector as unknown as IUserConnector),
      ),
    });
  } catch (error) {
    logger.error("Failed to list connector builder connectors", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list connectors",
      },
      500,
    );
  }
});

connectorBuilderRoutes.get(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");
      const connector = await getWorkspaceConnector(workspaceId, connectorId);

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      return c.json({
        success: true,
        data: serializeUserConnector(connector.toObject()),
      });
    } catch (error) {
      logger.error("Failed to fetch connector builder connector", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch connector",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.get(
  "/connectors/:id/versions",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");
      const connector = await getWorkspaceConnector(workspaceId, connectorId);

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      return c.json({
        success: true,
        data: connector.versions
          .slice()
          .sort((left, right) => right.version - left.version)
          .map(version => {
            const maybeDocumentVersion = version as typeof version & {
              toObject?: () => Record<string, unknown>;
            };
            const serializedVersion =
              typeof maybeDocumentVersion.toObject === "function"
                ? maybeDocumentVersion.toObject()
                : version;

            return {
              ...serializedVersion,
              builtAt: version.builtAt?.toISOString(),
              createdAt: version.createdAt.toISOString(),
            };
          }),
      });
    } catch (error) {
      logger.error("Failed to fetch connector version history", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch connector versions",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.put(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");
      const parsed = updateConnectorSchema.parse(await c.req.json());
      const connector = await getWorkspaceConnector(workspaceId, connectorId);

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      if (parsed.name !== undefined) {
        connector.name = parsed.name;
      }
      if (parsed.description !== undefined) {
        connector.description = parsed.description;
      }
      if (parsed.code !== undefined) {
        connector.source.code = parsed.code;
      }
      if (parsed.visibility !== undefined) {
        connector.visibility = parsed.visibility;
      }

      await connector.save();

      return c.json({
        success: true,
        data: serializeUserConnector(connector.toObject()),
      });
    } catch (error) {
      logger.error("Failed to update connector builder connector", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update connector",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.delete(
  "/connectors/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");

      if (!Types.ObjectId.isValid(connectorId)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }

      const result = await UserConnector.deleteOne({
        _id: new Types.ObjectId(connectorId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (result.deletedCount === 0) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      await ConnectorInstance.deleteMany({
        connectorId: new Types.ObjectId(connectorId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      return c.json({
        success: true,
        message: "Connector deleted successfully",
      });
    } catch (error) {
      logger.error("Failed to delete connector builder connector", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to delete connector",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.post(
  "/connectors/:id/build",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");
      const connector = await getWorkspaceConnector(workspaceId, connectorId);

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      const { build, connector: updatedConnector } =
        await ensureConnectorBundle(connector, getActorId(c));

      if (build.errors.length > 0 || !build.js) {
        return c.json({
          success: false,
          error: "Connector build failed",
          data: {
            build,
            connector: serializeUserConnector(updatedConnector.toObject()),
          },
        });
      }

      return c.json({
        success: true,
        data: {
          build,
          connector: serializeUserConnector(updatedConnector.toObject()),
        },
      });
    } catch (error) {
      logger.error("Failed to build connector", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to build connector",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.post(
  "/connectors/:id/dev-run",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const connectorId = c.req.param("id");
      const parsed = devRunSchema.parse(await c.req.json().catch(() => ({})));
      const connector = await getWorkspaceConnector(workspaceId, connectorId);

      if (!connector) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      const { build, connector: updatedConnector } =
        await ensureConnectorBundle(connector, getActorId(c));

      if (build.errors.length > 0 || !build.js) {
        return c.json({
          success: false,
          error: "Connector build failed",
          data: {
            build,
            connector: serializeUserConnector(updatedConnector.toObject()),
          },
        });
      }

      const executionInput: ConnectorExecutionInput = {
        config: parsed.config ?? {},
        secrets: parsed.secrets ?? {},
        state: parsed.state ?? {},
        trigger: parsed.trigger ?? { type: "manual" },
        metadata: {
          workspaceId,
          connectorId,
        },
      };

      try {
        const execution = await sandboxRunner.execute(build.js, executionInput);

        return c.json({
          success: true,
          data: {
            build,
            connector: serializeUserConnector(updatedConnector.toObject()),
            output: execution.output,
            logs: execution.logs,
            durationMs: execution.durationMs,
            runtime: execution.runtime,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to execute connector";
        const runtimeError = await mapRuntimeError(message, build.sourceMap);

        return c.json({
          success: false,
          error: "Connector execution failed",
          data: {
            build,
            connector: serializeUserConnector(updatedConnector.toObject()),
            runtimeError,
          },
        });
      }
    } catch (error) {
      logger.error("Failed to execute connector dev run", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute dev run",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.get("/instances", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const connectorId = new URL(c.req.url).searchParams.get("connectorId");
    const filter: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(workspaceId),
    };

    if (connectorId) {
      if (!Types.ObjectId.isValid(connectorId)) {
        return c.json({ success: false, error: "Invalid connector ID" }, 400);
      }
      filter.connectorId = new Types.ObjectId(connectorId);
    }

    const instances = await ConnectorInstance.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    return c.json({
      success: true,
      data: instances.map(instance =>
        serializeConnectorInstance(instance as unknown as IConnectorInstance),
      ),
    });
  } catch (error) {
    logger.error("Failed to list connector builder instances", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list instances",
      },
      500,
    );
  }
});

connectorBuilderRoutes.post("/instances", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const parsed = createConnectorInstanceSchema.parse(await c.req.json());

    if (!Types.ObjectId.isValid(parsed.connectorId)) {
      return c.json({ success: false, error: "Invalid connector ID" }, 400);
    }

    const connector = await getWorkspaceConnector(
      workspaceId,
      parsed.connectorId,
    );
    if (!connector) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    const instance = await ConnectorInstance.create({
      workspaceId: new Types.ObjectId(workspaceId),
      connectorId: new Types.ObjectId(parsed.connectorId),
      name: parsed.name,
      secrets: parsed.secrets ?? {},
      config: parsed.config ?? {},
      output: {
        destinationDatabaseId:
          parsed.output?.destinationDatabaseId &&
          Types.ObjectId.isValid(parsed.output.destinationDatabaseId)
            ? new Types.ObjectId(parsed.output.destinationDatabaseId)
            : undefined,
        destinationSchema: parsed.output?.destinationSchema,
        destinationTablePrefix: parsed.output?.destinationTablePrefix,
        evolutionMode: parsed.output?.evolutionMode ?? "append",
      },
      triggers:
        parsed.triggers && parsed.triggers.length > 0
          ? parsed.triggers.map(trigger => ({
              type: trigger.type,
              enabled: trigger.enabled ?? true,
              cron: trigger.cron,
              path: trigger.path,
            }))
          : [{ type: "manual", enabled: true }],
      state: parsed.state ?? {},
      status: parsed.status ?? "idle",
      createdBy: getActorId(c),
    });

    return c.json(
      {
        success: true,
        data: serializeConnectorInstance(instance.toObject()),
      },
      201,
    );
  } catch (error) {
    logger.error("Failed to create connector instance", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create instance",
      },
      500,
    );
  }
});

connectorBuilderRoutes.get(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const instanceId = c.req.param("id");
      const instance = await getWorkspaceInstance(workspaceId, instanceId);

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({
        success: true,
        data: serializeConnectorInstance(instance.toObject()),
      });
    } catch (error) {
      logger.error("Failed to fetch connector instance", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to fetch instance",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.put(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const instanceId = c.req.param("id");
      const parsed = updateConnectorInstanceSchema.parse(await c.req.json());
      const instance = await getWorkspaceInstance(workspaceId, instanceId);

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      if (parsed.connectorId) {
        if (!Types.ObjectId.isValid(parsed.connectorId)) {
          return c.json({ success: false, error: "Invalid connector ID" }, 400);
        }

        const connector = await getWorkspaceConnector(
          workspaceId,
          parsed.connectorId,
        );
        if (!connector) {
          return c.json({ success: false, error: "Connector not found" }, 404);
        }

        instance.connectorId = new Types.ObjectId(parsed.connectorId);
      }

      if (parsed.name !== undefined) {
        instance.name = parsed.name;
      }
      if (parsed.secrets !== undefined) {
        instance.secrets = parsed.secrets;
      }
      if (parsed.config !== undefined) {
        instance.config = parsed.config;
      }
      if (parsed.state !== undefined) {
        instance.state = parsed.state;
      }
      if (parsed.status !== undefined) {
        instance.status = parsed.status;
      }
      if (parsed.output !== undefined) {
        instance.output = {
          destinationDatabaseId:
            parsed.output.destinationDatabaseId &&
            Types.ObjectId.isValid(parsed.output.destinationDatabaseId)
              ? new Types.ObjectId(parsed.output.destinationDatabaseId)
              : instance.output.destinationDatabaseId,
          destinationSchema:
            parsed.output.destinationSchema ??
            instance.output.destinationSchema,
          destinationTablePrefix:
            parsed.output.destinationTablePrefix ??
            instance.output.destinationTablePrefix,
          evolutionMode:
            parsed.output.evolutionMode ?? instance.output.evolutionMode,
        };
      }
      if (parsed.triggers !== undefined) {
        instance.triggers = parsed.triggers.map(trigger => ({
          type: trigger.type,
          enabled: trigger.enabled ?? true,
          cron: trigger.cron,
          path: trigger.path,
        }));
      }

      await instance.save();

      return c.json({
        success: true,
        data: serializeConnectorInstance(instance.toObject()),
      });
    } catch (error) {
      logger.error("Failed to update connector instance", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update instance",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.delete(
  "/instances/:id",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const instanceId = c.req.param("id");

      if (!Types.ObjectId.isValid(instanceId)) {
        return c.json({ success: false, error: "Invalid instance ID" }, 400);
      }

      const result = await ConnectorInstance.deleteOne({
        _id: new Types.ObjectId(instanceId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (result.deletedCount === 0) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      return c.json({
        success: true,
        message: "Instance deleted successfully",
      });
    } catch (error) {
      logger.error("Failed to delete connector instance", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to delete instance",
        },
        500,
      );
    }
  },
);

connectorBuilderRoutes.post(
  "/instances/:id/toggle",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const instanceId = c.req.param("id");
      const instance = await getWorkspaceInstance(workspaceId, instanceId);

      if (!instance) {
        return c.json({ success: false, error: "Instance not found" }, 404);
      }

      instance.status = instance.status === "disabled" ? "active" : "disabled";
      await instance.save();

      return c.json({
        success: true,
        data: serializeConnectorInstance(instance.toObject()),
      });
    } catch (error) {
      logger.error("Failed to toggle connector instance", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to toggle instance",
        },
        500,
      );
    }
  },
);

export { connectorBuilderRoutes };
