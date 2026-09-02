import { createRoute, z } from "@hono/zod-openapi";
import { decryptEncrypted, encryptString } from "../services/crypto.service";
import { Connector as DataSource } from "../database/workspace-schema";
import { connectorRegistry } from "../connectors/registry";
import { syncConnectorRegistry } from "../sync/connector-registry";
import {
  SandboxedConnector,
  isWorkspaceConnectorType,
  slugFromType,
} from "../connectors/workspace/SandboxedConnector";
import { recordConnectionCheck } from "../connectors/workspace/reconcile.service";
import { connectorTypeExists } from "../connectors/workspace/catalog";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { Types } from "mongoose";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.connector();

export const dataSourceRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const SourceIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const OpenBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

// Apply unified auth middleware to all data source routes
dataSourceRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
dataSourceRoutes.use("*", async (c: AuthenticatedContext, next) => {
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

// --- Helper: encrypt config values based on connector schema ---
export type ConnectorFieldSchema = {
  name: string;
  type: string;
  encrypted?: boolean;
  itemFields?: ConnectorFieldSchema[];
};

/**
 * Thrown when a credential field cannot be encrypted. Names the field, never
 * the value — this message ends up in a 500 body and a log line.
 */
export class SecretEncryptionError extends Error {
  constructor(
    public readonly field: string,
    cause: unknown,
  ) {
    super(
      `could not encrypt credential field "${field}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "SecretEncryptionError";
  }
}

/**
 * Encrypt every field the connector's own schema marks as a secret.
 *
 * Fails CLOSED. This used to catch the encryption error and store the value
 * as-is — "if encryption fails, leave as-is" — which meant a missing or
 * malformed ENCRYPTION_KEY stored the customer's API key in plaintext and
 * returned 201. The only realistic error here is that misconfiguration, and
 * the right answer to it is a 500 with nothing written, not a quiet success.
 * Both call sites sit inside the route's try/catch, which already maps a
 * throw to 500.
 */
export function applySchemaEncryption(
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
        } catch (error) {
          throw new SecretEncryptionError(key, error);
        }
      }
    }
  };

  processFields(clone, schema.fields);
  return clone;
}

dataSourceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Connectors"],
    summary: "List workspace connectors",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const _workspaceId = c.req.param("workspaceId");
      // TODO: Add authentication and permission check
      // const user = await getUserFromRequest(c);

      if (!_workspaceId) {
        return c.json(
          { success: false, error: "Workspace ID is required" },
          400,
        );
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Connectors"],
    summary: "Get a workspace connector",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Connectors"],
    summary: "Create a workspace connector",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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

      // Check if connector type is supported. A `ws:` type is one this
      // workspace wrote, so the answer comes from its index rather than from
      // the global registry, and a blocked connector is refused here rather
      // than at the first sync.
      if (isWorkspaceConnectorType(body.type)) {
        if (!workspaceId) {
          return c.json(
            { success: false, error: "workspaceId is required" },
            400,
          );
        }
        const exists = await connectorTypeExists(body.type, workspaceId);
        if (!exists.ok) {
          return c.json({ success: false, error: exists.reason }, 400);
        }
      } else if (!connectorRegistry.hasConnector(body.type)) {
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
        workspaceId,
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Connectors"],
    summary: "Update a workspace connector",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
            workspaceId,
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Connectors"],
    summary: "Delete a workspace connector",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Connectors"],
    summary: "Test a connector connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId) {
        return c.json(
          { success: false, error: "Workspace ID is required" },
          400,
        );
      }

      // The id in the URL is the caller's; the workspace in the URL is the
      // one the middleware authorized. Testing a connector by id alone would
      // let a member of one workspace exercise another's credential — and,
      // now that the outcome is recorded, write to another's index row.
      const ownershipCheck = await DataSource.findOne(
        { _id: id, workspaceId },
        { _id: 1 },
      ).lean();
      if (!ownershipCheck) {
        return c.json(
          { success: false, error: "Connector not found in this workspace" },
          404,
        );
      }

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

      const workspaceSourceSha =
        connector instanceof SandboxedConnector
          ? await connector.sourceShaForConnectionCheck()
          : undefined;
      const result = await connector.testConnection();

      // The only path that may write `verified`: a push proves a connector
      // starts, and nothing else, so this is the one place with a real
      // credential and a real answer about it. A failure records the reason
      // rather than the status, so a connector stays offerable in the picker
      // while whoever entered the key fixes it.
      if (isWorkspaceConnectorType(ds.type)) {
        if (!workspaceSourceSha) {
          throw new Error(
            `Workspace connector ${ds.type} resolved to an unexpected implementation`,
          );
        }
        await recordConnectionCheck({
          workspaceId,
          slug: slugFromType(ds.type),
          sourceSha: workspaceSourceSha,
          success: result.success === true,
          message: result.message,
        }).catch(error =>
          logger.warn("Could not record a workspace connector check", {
            workspaceId,
            type: ds.type,
            error,
          }),
        );
      }

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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/enable",
    tags: ["Connectors"],
    summary: "Enable or disable a connector",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
  },
);

dataSourceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/entities",
    tags: ["Connectors"],
    summary: "List connector entities",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
      let entityData: any[];
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

      // Static, no-I/O — safe to compute once and reuse per entity below.
      const incrementalCapabilities =
        typeof connector.getIncrementalCapabilities === "function"
          ? connector.getIncrementalCapabilities()
          : undefined;

      // Enrich each entity (and sub-entity) with its field list, dedup key
      // columns, and incremental-pull capability from the connector schema,
      // so the UI can build schema-driven partition/cluster selectors (see
      // 15-connector-agnostic.mdc) and show Airbyte-style per-entity primary
      // key + incremental indicators instead of only a connector-level one.
      // Sub-entities are resolved with the flattened `parent:Sub` key used
      // elsewhere in the pipeline.
      const attachFields = async (node: any, schemaKey: string) => {
        try {
          const schema = await connector.resolveSchema(schemaKey);
          if (schema?.fields) {
            node.fields = Object.entries(schema.fields).map(
              ([name, field]) => ({ name, type: field.type }),
            );
          }
          // Mirrors the CDC layout fallback in buildCdcEntityLayout — when a
          // connector doesn't declare keyColumns, the pipeline dedups on
          // ["id"], so reflect that here rather than showing nothing.
          node.keyColumns =
            schema?.keyColumns && schema.keyColumns.length > 0
              ? schema.keyColumns
              : ["id"];
        } catch {
          // Skip entities where schema resolution fails; the UI falls back
          // to system fields only.
          node.keyColumns = ["id"];
        }
        if (incrementalCapabilities) {
          node.incrementalMode =
            incrementalCapabilities.perEntity?.[schemaKey]?.mode ??
            incrementalCapabilities.mode;
        }
      };

      try {
        await Promise.all(
          entityData.flatMap((node: any) => {
            const subs = Array.isArray(node.subEntities)
              ? node.subEntities
              : [];
            if (subs.length > 0) {
              return subs.map((sub: any) =>
                attachFields(sub, `${node.name}:${sub.name}`),
              );
            }
            return [attachFields(node, node.name)];
          }),
        );
      } catch {
        // Never fail the entities endpoint because of schema enrichment.
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
  },
);

/**
 * Reveal ONE stored secret of ONE connector the caller's workspace owns.
 *
 * This replaces `POST /decrypt`, which took ciphertext from the request body
 * and returned its plaintext. That endpoint was a cross-tenant decryption
 * oracle: ENCRYPTION_KEY is global, the ciphertext was never bound to a
 * workspace, and membership was the only gate — so any member of any
 * workspace could decrypt ciphertext harvested from another tenant, a DB
 * dump or a backup, and any VIEWER could read admin-managed credentials.
 * (An earlier fix closed the padding-oracle half by collapsing distinct
 * decryption errors to one opaque message; the plaintext-on-success half is
 * what this removes.)
 *
 * The primitive is gone rather than narrowed: the server reads the
 * ciphertext from its OWN record, addressed by connector id scoped to the
 * URL workspace, so nothing decryptable can be supplied by the caller. The
 * gate is admin/owner — the same people who may edit these credentials —
 * and every reveal is logged with actor, connector and field, because
 * showing a credential should leave a trace.
 */
dataSourceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/reveal-secret",
    tags: ["Connectors"],
    summary: "Reveal one stored secret of a connector (admin/owner only)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              field: z.string().min(1).max(128).openapi({
                description:
                  "Top-level config field name declared encrypted by the connector's schema.",
              }),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const { field } = await c.req.json();

      if (!workspaceId || !id || !Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid connector id" }, 400);
      }
      if (typeof field !== "string" || !field) {
        return c.json({ success: false, error: "field is required" }, 400);
      }

      // Revealing a credential is an admin/owner act — the same bar as
      // editing it. Membership is NOT enough (a viewer must not read the
      // credentials an admin configured).
      const user = c.get("user");
      if (!user || !(await workspaceService.isAdmin(workspaceId, user.id))) {
        return c.json(
          {
            success: false,
            error:
              "Revealing a connector secret requires the admin or owner workspace role",
          },
          403,
        );
      }

      // The ciphertext comes from OUR record for THIS workspace — never from
      // the caller. This is what makes the oracle impossible.
      const dataSource = await DataSource.findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
      }).lean();
      if (!dataSource) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }

      // Only fields the connector's schema declares secret may be revealed,
      // so this cannot be used to walk arbitrary config.
      const schema = await syncConnectorRegistry.getConfigSchemaForType(
        (dataSource as { type: string }).type,
        workspaceId,
      );
      const declared = (schema?.fields ?? []).find(
        (f: ConnectorFieldSchema) => f.name === field,
      );
      const isSecret =
        declared &&
        (declared.encrypted === true || declared.type === "password");
      if (!isSecret) {
        return c.json(
          { success: false, error: "That field is not a connector secret" },
          400,
        );
      }

      const stored = (dataSource as { config?: Record<string, unknown> })
        .config?.[field];
      if (typeof stored !== "string" || !stored) {
        return c.json({
          success: true,
          data: { value: "", wasEncrypted: false },
        });
      }

      logger.info("Connector secret revealed", {
        workspaceId,
        connectorId: id,
        field,
        actorId: user.id,
      });

      if (!stored.includes(":")) {
        // Stored in the clear (legacy rows predating schema-driven
        // encryption): hand it back, but say so.
        return c.json({
          success: true,
          data: { value: stored, wasEncrypted: false },
        });
      }

      try {
        return c.json({
          success: true,
          data: { value: decryptEncrypted(stored), wasEncrypted: true },
        });
      } catch (error) {
        // One opaque message: distinct decryption failures against the
        // unauthenticated AES-256-CBC scheme are a padding oracle.
        logger.error("Connector secret decryption failed", {
          error,
          workspaceId,
          connectorId: id,
          field,
        });
        return c.json({ success: false, error: "Decryption failed" }, 400);
      }
    } catch (error) {
      logger.error("Reveal-secret endpoint error", { error });
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
