import { Hono } from "hono";
import { Connector as DataSource } from "../database/workspace-schema";
import { connectorRegistry } from "../connectors/registry";
import { syncConnectorRegistry } from "../sync/connector-registry";
import * as crypto from "crypto";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";

const logger = loggers.connector();

export const dataSourceRoutes = new Hono();

// Apply unified auth middleware to all data source routes
dataSourceRoutes.use("*", unifiedAuthMiddleware);

// Middleware to enrich logging context with workspace ID from URL and verify access
dataSourceRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    // Enrich logging context with workspace ID
    enrichContextWithWorkspace(workspaceId);

    // Verify user has access to this workspace (for session auth)
    const user = c.get("user");
    if (user) {
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    }
  }
  await next();
});

// --- Helper: encrypt config values based on connector schema ---
type ConnectorFieldSchema = {
  name: string;
  type: string;
  encrypted?: boolean;
  itemFields?: ConnectorFieldSchema[];
};

function encryptString(value: string): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  // If already looks encrypted (iv:encrypted_hex), skip
  if (
    typeof value === "string" &&
    /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(value)
  ) {
    return value;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(encryptionKey, "hex"),
    iv,
  );
  let encrypted = cipher.update(value);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function applySchemaEncryption(
  config: any,
  schema: { fields: ConnectorFieldSchema[] } | null,
): any {
  if (!schema || !schema.fields || !config) return config;
  const clone: any = { ...config };

  const processFields = (target: any, fields: ConnectorFieldSchema[]): void => {
    for (const field of fields) {
      const key = field.name;
      const val = target?.[key];
      if (val === undefined) continue;

      // Recurse into object_array items
      if (field.type === "object_array" && Array.isArray(val)) {
        if (field.itemFields && field.itemFields.length > 0) {
          val.forEach((item: any) =>
            processFields(item, field.itemFields as ConnectorFieldSchema[]),
          );
        }
        continue;
      }

      const requiresEncryption =
        field.encrypted === true || field.type === "password";
      if (requiresEncryption && typeof val === "string" && val) {
        try {
          target[key] = encryptString(val);
        } catch {
          // If encryption fails, leave as-is
          target[key] = val;
        }
      }
    }
  };

  processFields(clone, schema.fields);
  return clone;
}

// GET /api/workspaces/:workspaceId/connectors - List all connectors for a workspace
dataSourceRoutes.get("/", async c => {
  try {
    const _workspaceId = c.req.param("workspaceId");
    // TODO: Add authentication and permission check
    // const user = await getUserFromRequest(c);

    if (!_workspaceId) {
      return c.json({ success: false, error: "Workspace ID is required" }, 400);
    }

    const dataSources = await DataSource.find({
      workspaceId: _workspaceId,
      // TODO: Add permission check
    })
      .sort({ createdAt: -1 })
      .lean();

    return c.json({ success: true, data: dataSources });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/connectors/:id - Get specific connector
dataSourceRoutes.get("/:id", async c => {
  try {
    const _workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    // TODO: Add authentication and permission check

    const dataSource = await DataSource.findOne({
      _id: id,
      workspaceId: _workspaceId,
    }).lean();

    if (!dataSource) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    return c.json({ success: true, data: dataSource });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/connectors - Create new connector
dataSourceRoutes.post("/", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    // TODO: Add authentication
    // const user = await getUserFromRequest(c);
    const body = await c.req.json();

    // Validate required fields
    if (!body.name || !body.type) {
      return c.json(
        {
          success: false,
          error: "Name and type are required",
        },
        400,
      );
    }

    // Check if connector type is supported
    if (!connectorRegistry.hasConnector(body.type)) {
      return c.json(
        {
          success: false,
          error: `Unsupported source type: ${body.type}`,
        },
        400,
      );
    }

    // Load connector schema for schema-driven encryption
    const schema = await syncConnectorRegistry.getConfigSchemaForType(
      body.type,
    );

    // Create connector
    const dataSource = new DataSource({
      workspaceId,
      name: body.name,
      type: body.type,
      description: body.description,
      config: applySchemaEncryption(body.config || {}, schema),
      settings: {
        sync_batch_size: body.settings?.sync_batch_size || 100,
        rate_limit_delay_ms: body.settings?.rate_limit_delay_ms || 200,
        max_retries: body.settings?.max_retries || 3,
        timeout_ms: body.settings?.timeout_ms || 30000,
        timezone: body.settings?.timezone || "UTC",
      },
      targetDatabases: body.targetDatabases || [],
      createdBy: "system", // TODO: Use actual user ID
      isActive: body.isActive !== false,
    });

    await dataSource.save();

    return c.json(
      {
        success: true,
        data: dataSource.toObject(),
        message: "Connector created successfully",
      },
      201,
    );
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PUT /api/workspaces/:workspaceId/connectors/:id - Update existing connector
dataSourceRoutes.put("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    // TODO: Add authentication and permission check
    const body = await c.req.json();

    // Find existing data source
    const dataSource = await DataSource.findOne({
      _id: id,
      workspaceId,
    });

    if (!dataSource) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    // Get the current values (decrypted) for comparison
    const currentValues = dataSource.toObject();

    // Track if any changes were made
    let hasChanges = false;

    // Update only fields that have changed
    if (body.name !== undefined && body.name !== currentValues.name) {
      dataSource.name = body.name;
      hasChanges = true;
    }
    if (
      body.description !== undefined &&
      body.description !== currentValues.description
    ) {
      dataSource.description = body.description;
      hasChanges = true;
    }
    if (body.type !== undefined && body.type !== currentValues.type) {
      dataSource.type = body.type;
      hasChanges = true;
    }
    if (
      body.isActive !== undefined &&
      body.isActive !== currentValues.isActive
    ) {
      dataSource.isActive = body.isActive;
      hasChanges = true;
    }

    // Handle config updates - only update changed fields
    if (body.config !== undefined) {
      const currentConfig = currentValues.config || {};
      let configChanged = false;

      // Create a new config object starting with current values
      const newConfig = { ...currentConfig };

      // Only update fields that are different
      for (const key in body.config) {
        if (body.config[key] !== currentConfig[key]) {
          newConfig[key] = body.config[key];
          configChanged = true;
        }
      }

      // Only update config if something changed
      if (configChanged) {
        const schema = await syncConnectorRegistry.getConfigSchemaForType(
          dataSource.type,
        );
        dataSource.config = applySchemaEncryption(newConfig, schema);
        hasChanges = true;
      }
    }

    // Handle settings updates - deep comparison
    if (body.settings !== undefined) {
      const currentSettings = currentValues.settings || {};
      let settingsChanged = false;

      const newSettings = { ...currentSettings };

      for (const key in body.settings) {
        if ((body.settings as any)[key] !== (currentSettings as any)[key]) {
          (newSettings as any)[key] = (body.settings as any)[key];
          settingsChanged = true;
        }
      }

      if (settingsChanged) {
        dataSource.settings = newSettings;
        hasChanges = true;
      }
    }

    // Handle targetDatabases array comparison
    if (body.targetDatabases !== undefined) {
      const currentTargets = (currentValues.targetDatabases || []).map(id =>
        id.toString(),
      );
      const newTargets = (body.targetDatabases || []).map((id: any) =>
        id.toString(),
      );

      // Check if arrays are different
      const arraysEqual =
        currentTargets.length === newTargets.length &&
        currentTargets.every((id, index) => id === newTargets[index]);

      if (!arraysEqual) {
        dataSource.targetDatabases = body.targetDatabases;
        hasChanges = true;
      }
    }

    // Only save if there were actual changes
    if (hasChanges) {
      await dataSource.save();
    }

    return c.json({
      success: true,
      data: dataSource.toObject(),
      message: hasChanges
        ? "Connector updated successfully"
        : "No changes detected",
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/connectors/:id - Delete connector
dataSourceRoutes.delete("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    // TODO: Add authentication and permission check

    const result = await DataSource.deleteOne({
      _id: id,
      workspaceId,
    });

    if (result.deletedCount === 0) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    return c.json({
      success: true,
      message: "Connector deleted successfully",
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/connectors/:id/test - Test connector connection
dataSourceRoutes.post("/:id/test", async c => {
  try {
    const _workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    // TODO: Add authentication and permission check

    // Use manager to load decrypted configuration before testing
    const ds = await databaseDataSourceManager.getDataSource(id);

    if (!ds) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    // Get connector and test connection
    const connector = await syncConnectorRegistry.getConnector(ds);
    if (!connector) {
      return c.json(
        {
          success: false,
          error: `No connector available for type: ${ds.type}`,
        },
        500,
      );
    }

    const result = await connector.testConnection();

    return c.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/connectors/:id/enable - Enable/disable connector
dataSourceRoutes.patch("/:id/enable", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    // TODO: Add authentication and permission check
    const body = await c.req.json();

    if (typeof body.enabled !== "boolean") {
      return c.json(
        {
          success: false,
          error: "Enabled field must be a boolean",
        },
        400,
      );
    }

    const dataSource = await DataSource.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
      },
      {
        isActive: body.enabled,
      },
      {
        new: true,
      },
    );

    if (!dataSource) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    return c.json({
      success: true,
      data: dataSource.toObject(),
      message: `Connector ${
        body.enabled ? "enabled" : "disabled"
      } successfully`,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/connectors/:id/entities - Get available entities for a connector
dataSourceRoutes.get("/:id/entities", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    // First, verify the connector belongs to the workspace
    const ownershipCheck = await DataSource.findOne(
      { _id: id, workspaceId: workspaceId },
      { _id: 1 },
    ).lean();
    if (!ownershipCheck) {
      return c.json(
        { success: false, error: "Connector not found in this workspace" },
        404,
      );
    }

    // Now get the full config using the manager
    const dataSource = await databaseDataSourceManager.getDataSource(id);

    if (!dataSource) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    // Get connector and its entities
    const connector = await syncConnectorRegistry.getConnector(dataSource);
    if (!connector) {
      return c.json(
        {
          success: false,
          error: `No connector available for type: ${dataSource.type}`,
        },
        500,
      );
    }

    // Try to get structured metadata first, fallback to flat list
    let entityData: any;
    if (typeof connector.getEntityMetadata === "function") {
      // Return structured metadata if available
      entityData = connector.getEntityMetadata();
    } else {
      // Fallback to flat list for backward compatibility
      const entities = connector.getAvailableEntities();
      entityData = entities.map((entity: string) => ({
        name: entity,
        label: entity.charAt(0).toUpperCase() + entity.slice(1),
      }));
    }

    return c.json({
      success: true,
      data: entityData,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/connectors/decrypt - Decrypt a value for debugging
dataSourceRoutes.post("/decrypt", async c => {
  try {
    const { encryptedValue } = await c.req.json();

    if (!encryptedValue) {
      return c.json(
        {
          success: false,
          error: "Encrypted value is required",
        },
        400,
      );
    }

    // Get encryption key from environment
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      return c.json(
        {
          success: false,
          error: "ENCRYPTION_KEY not configured",
        },
        500,
      );
    }

    // Check if the value is encrypted (contains ':')
    if (!encryptedValue.includes(":")) {
      return c.json({
        success: true,
        data: {
          decryptedValue: encryptedValue,
          wasEncrypted: false,
        },
      });
    }

    try {
      // Parse the encrypted string (format: iv:encrypted_data)
      const textParts = encryptedValue.split(":");
      if (textParts.length < 2) {
        return c.json(
          {
            success: false,
            error: "Invalid encrypted format (expected iv:data)",
          },
          400,
        );
      }

      const iv = Buffer.from(textParts[0], "hex");
      const encryptedText = Buffer.from(textParts.slice(1).join(":"), "hex");

      // Decrypt using AES-256-CBC
      const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        Buffer.from(encryptionKey, "hex"),
        iv,
      );

      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return c.json({
        success: true,
        data: {
          decryptedValue: decrypted.toString(),
          wasEncrypted: true,
        },
      });
    } catch (error: any) {
      logger.error("Decryption error", { error });
      return c.json(
        {
          success: false,
          error: `Decryption failed: ${error.message}`,
          details: {
            code: error.code,
            message: error.message,
          },
        },
        400,
      );
    }
  } catch (error: any) {
    logger.error("Decrypt endpoint error", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
