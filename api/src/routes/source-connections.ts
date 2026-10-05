/**
 * Source-connection CRUD (credentials configured with a connector).
 *
 * Primary mount: `/api/workspaces/:workspaceId/connections/sources`
 * Deprecated alias: `/api/workspaces/:workspaceId/connectors`
 *
 * This is not the connector *catalog* (`routes/connectors.ts`, `/api/connectors`)
 * and not DuckDB dashboard data sources (`routes/resource-data-sources.ts`).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { decryptEncrypted, isEncryptedValue } from "../services/crypto.service";
import { SourceConnection } from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import {
  PROBE_DEFAULT_LIMIT,
  PROBE_MAX_LIMIT,
  ProbeError,
  probeConnection,
  runConnectionCheck,
} from "../connectors/probe.service";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { Types } from "mongoose";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  SECRET_KEPT,
  redactConnectionSecrets,
} from "../utils/connection-secrets";
import {
  type ConnectorFieldSchema,
  SecretSentinelError,
  applySchemaEncryption,
  checkSourceConnectorType,
  createSourceConnection,
  isSecretConfigField,
  mergeSourceConnectionConfig,
} from "../services/source-connection.service";

const logger = loggers.connector();

export const sourceConnectionRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const SourceIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

/**
 * Deep links are `/cx/:id` with `[a-zA-Z0-9-]+`, so values like `undefined`
 * and `new` are legal URLs. Asking mongoose to cast those is a 500
 * CastError (`Cast to ObjectId failed for value "undefined"`). Refuse them
 * here instead — same bar as `GET /databases/:id`.
 */
function isSourceConnectionId(id: string | undefined): id is string {
  return typeof id === "string" && Types.ObjectId.isValid(id);
}

function asSourceRecord(doc: unknown): Record<string, unknown> {
  return (doc ?? {}) as Record<string, unknown>;
}
const OpenBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

// Apply unified auth middleware to all source-connection routes
sourceConnectionRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
sourceConnectionRoutes.use("*", async (c: AuthenticatedContext, next) => {
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

// Schema-driven encryption and the create/merge path live in the service,
// shared with the MCP tools; re-exported for existing importers.
export {
  applySchemaEncryption,
  SecretEncryptionError,
} from "../services/source-connection.service";
export type { ConnectorFieldSchema } from "../services/source-connection.service";

function applySecretPlaceholders(
  target: Record<string, unknown>,
  fields: ConnectorFieldSchema[],
): void {
  for (const field of fields) {
    const val = target[field.name];
    if (field.type === "object_array" && Array.isArray(val)) {
      const itemFields = field.itemFields;
      if (itemFields && itemFields.length > 0) {
        target[field.name] = val.map(item => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item;
          }
          const copy = { ...(item as Record<string, unknown>) };
          applySecretPlaceholders(copy, itemFields);
          return copy;
        });
      }
      continue;
    }
    if (isSecretConfigField(field) && typeof val === "string" && val) {
      target[field.name] = SECRET_KEPT;
    }
  }
}

/**
 * Credentials are write-only. Same contract as `GET /databases/:id`: secret
 * fields become {@link SECRET_KEPT}, everything else (account ids, URLs)
 * stays so the edit form can round-trip.
 *
 * Fail CLOSED when the connector schema is missing: any value already in
 * AES `iv:hex` form is ciphertext, whatever its field is named (`headers`
 * on GraphQL/REST is the one that slips past the database-connection
 * secret-key regex).
 */
function redactCiphertextLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    return isEncryptedValue(value) ? SECRET_KEPT : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactCiphertextLeaves(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactCiphertextLeaves(nested),
      ]),
    );
  }
  return value;
}

function redactSourceConfig(
  config: unknown,
  schema: { fields: ConnectorFieldSchema[] } | null,
): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const redacted = redactConnectionSecrets(config as Record<string, unknown>);
  if (schema?.fields) applySecretPlaceholders(redacted, schema.fields);
  return redactCiphertextLeaves(redacted) as Record<string, unknown>;
}

async function publicSourceConnection(
  doc: unknown,
  workspaceId: string | undefined,
): Promise<Record<string, unknown>> {
  const record = asSourceRecord(doc);
  let schema: { fields: ConnectorFieldSchema[] } | null = null;
  try {
    schema = await syncConnectorRegistry.getConfigSchemaForType(
      String(record.type ?? ""),
      workspaceId,
    );
  } catch (error) {
    logger.warn("Could not load connector schema while redacting config", {
      type: record.type,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ...record,
    config: redactSourceConfig(record.config, schema),
  };
}

sourceConnectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Source Connections"],
    summary: "List source connections",
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

      const sourceConnections = await SourceConnection.find({
        workspaceId: _workspaceId,
        // TODO: Add permission check
      })
        .sort({ createdAt: -1 })
        .lean();

      const data = await Promise.all(
        sourceConnections.map(row => publicSourceConnection(row, _workspaceId)),
      );
      return c.json({ success: true, data });
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Source Connections"],
    summary: "Get a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const _workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }

      const sourceConnection = await SourceConnection.findOne({
        _id: id,
        workspaceId: _workspaceId,
      }).lean();

      if (!sourceConnection) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      return c.json({
        success: true,
        data: await publicSourceConnection(sourceConnection, _workspaceId),
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Source Connections"],
    summary: "Create a source connection",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const user = c.get("user");
      if (!user?.id) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
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
      const supported = await checkSourceConnectorType(body.type, workspaceId);
      if (!supported.ok) {
        return c.json({ success: false, error: supported.error }, 400);
      }

      // Load connector schema for schema-driven encryption
      const schema = await syncConnectorRegistry.getConfigSchemaForType(
        body.type,
        workspaceId,
      );

      const sourceConnection = await createSourceConnection({
        workspaceId: workspaceId as string,
        createdBy: user.id,
        name: body.name,
        type: body.type,
        description: body.description,
        config: body.config || {},
        schema,
        settings: body.settings,
        targetDatabases: body.targetDatabases,
        isActive: body.isActive,
      });

      return c.json(
        {
          success: true,
          data: await publicSourceConnection(
            sourceConnection.toObject(),
            workspaceId,
          ),
          message: "Connector created successfully",
        },
        201,
      );
    } catch (error) {
      if (error instanceof SecretSentinelError) {
        return c.json({ success: false, error: error.message }, 400);
      }
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Source Connections"],
    summary: "Update a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }
      const body = await c.req.json();

      // Find existing source connection
      const sourceConnection = await SourceConnection.findOne({
        _id: id,
        workspaceId,
      });

      if (!sourceConnection) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      // Get the current values (decrypted) for comparison
      const currentValues = sourceConnection.toObject();

      // Track if any changes were made
      let hasChanges = false;
      // Item secrets saved WITHOUT a value (sent empty or omitted, with no
      // stored item to keep them from): saved as before, but said out loud.
      let warnings: string[] = [];

      // Update only fields that have changed
      if (body.name !== undefined && body.name !== currentValues.name) {
        sourceConnection.name = body.name;
        hasChanges = true;
      }
      if (
        body.description !== undefined &&
        body.description !== currentValues.description
      ) {
        sourceConnection.description = body.description;
        hasChanges = true;
      }
      if (body.type !== undefined && body.type !== currentValues.type) {
        sourceConnection.type = body.type;
        hasChanges = true;
      }
      if (
        body.isActive !== undefined &&
        body.isActive !== currentValues.isActive
      ) {
        sourceConnection.isActive = body.isActive;
        hasChanges = true;
      }

      // Handle config updates - only update changed fields
      if (body.config !== undefined) {
        const currentConfig = (currentValues.config || {}) as Record<
          string,
          unknown
        >;
        // The schema says which item fields are secrets, which is what
        // matches a kept secret inside an array item to its stored item.
        const schema = await syncConnectorRegistry.getConfigSchemaForType(
          sourceConnection.type,
          workspaceId,
        );
        // Echoed {@link SECRET_KEPT} sentinels become the stored secret again
        // so editing a non-secret field cannot wipe or re-encrypt the key.
        const {
          config: newConfig,
          changed: configChanged,
          unresolved,
          omitted,
        } = mergeSourceConnectionConfig(
          currentConfig,
          body.config as Record<string, unknown>,
          schema,
        );
        // A sentinel with no stored secret to stand for: refuse, save
        // nothing (no field above has been persisted yet). Paths, never
        // values.
        if (unresolved.length > 0) {
          return c.json(
            {
              success: false,
              error: `${SECRET_KEPT} has no stored secret to keep at: ${unresolved.join(", ")}. Send the value instead.`,
              unresolved,
            },
            400,
          );
        }

        warnings = omitted.map(
          path =>
            `${path}: no value sent and no stored item with the same fields to keep one from — saved without it.`,
        );

        // Only update config if something changed
        if (configChanged) {
          sourceConnection.config = applySchemaEncryption(newConfig, schema);
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
          sourceConnection.settings = newSettings;
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
          sourceConnection.targetDatabases = body.targetDatabases;
          hasChanges = true;
        }
      }

      // Only save if there were actual changes
      if (hasChanges) {
        await sourceConnection.save();
      }

      return c.json({
        success: true,
        data: await publicSourceConnection(
          sourceConnection.toObject(),
          workspaceId,
        ),
        message: hasChanges
          ? "Connector updated successfully"
          : "No changes detected",
        ...(warnings.length > 0 ? { warnings } : {}),
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Source Connections"],
    summary: "Delete a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }

      const result = await SourceConnection.deleteOne({
        _id: id,
        workspaceId,
      });

      if (result.deletedCount === 0) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Source Connections"],
    summary: "Test a source connection",
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
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }

      // The id in the URL is the caller's; the workspace in the URL is the
      // one the middleware authorized. Testing a source connection by id alone would
      // let a member of one workspace exercise another's credential — and,
      // now that the outcome is recorded, write to another's index row.
      const ownershipCheck = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { _id: 1 },
      ).lean();
      if (!ownershipCheck) {
        return c.json(
          {
            success: false,
            error: "Source connection not found in this workspace",
          },
          404,
        );
      }

      // Use manager to load decrypted configuration before testing
      const ds = await sourceConnectionManager.getSourceConnection(id);

      if (!ds) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      // Get connector and test connection
      const connector = await syncConnectorRegistry.getConnectorFor(ds);
      if (!connector) {
        return c.json(
          {
            success: false,
            error: `No connector available for type: ${ds.type}`,
          },
          500,
        );
      }

      // Runs the check and, for a workspace connector, records it: a real
      // credential and a real answer is the only evidence that may move a
      // workspace connector to `verified`. Shared with the probe, which is
      // this check plus a read.
      const result = await runConnectionCheck({
        workspaceId,
        sourceConnection: ds,
        connector,
      });

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

const ProbeBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({
        entity: z.string().optional().openapi({
          description:
            "Entity to read one page of. Omit to check the credential only.",
        }),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PROBE_MAX_LIMIT)
          .optional()
          .openapi({
            description: `Maximum records to return (default ${PROBE_DEFAULT_LIMIT}).`,
          }),
        fields: z.array(z.string()).optional().openapi({
          description: "Keep only these top-level fields of each record.",
        }),
        since: z.string().optional().openapi({
          description:
            "ISO 8601 instant: records changed since then, where the connector supports it.",
        }),
      }),
    },
  },
};

/**
 * The live probe: the check above plus one bounded page of an entity, read
 * from the platform behind the connection and written nowhere. Same service
 * as the `probe_connection` MCP tool and `mako connection probe`, so the
 * three surfaces cannot drift on what "bounded", "read-only" and "no
 * credential in the result" mean. Primary mount:
 * `/api/workspaces/:workspaceId/connections/sources`. `/connectors` is the
 * deprecated alias of the same router.
 */
sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/probe",
    tags: ["Source Connections"],
    summary:
      "Probe a source connection live: check its credential and read one page of an entity",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: ProbeBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    if (!workspaceId) {
      return c.json({ success: false, error: "Workspace ID is required" }, 400);
    }
    if (!isSourceConnectionId(id)) {
      return c.json(
        { success: false, error: "Invalid source connection ID format" },
        400,
      );
    }

    let body: {
      entity?: string;
      limit?: number;
      fields?: string[];
      since?: string;
    } = {};
    try {
      const raw = await c.req.text();
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return c.json({ success: false, error: "Body must be JSON" }, 400);
    }

    let since: Date | undefined;
    if (body.since !== undefined) {
      since = new Date(body.since);
      if (Number.isNaN(since.getTime())) {
        return c.json(
          { success: false, error: `since is not a valid ISO 8601 instant` },
          400,
        );
      }
    }

    try {
      const data = await probeConnection({
        workspaceId,
        connectionId: id,
        entity: body.entity,
        limit: body.limit,
        fields: body.fields,
        since,
      });
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof ProbeError) {
        return c.json(
          { success: false, error: error.message, code: error.code },
          error.status,
        );
      }
      logger.error("Connection probe failed", {
        workspaceId,
        connectionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/enable",
    tags: ["Source Connections"],
    summary: "Enable or disable a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }
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

      const sourceConnection = await SourceConnection.findOneAndUpdate(
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

      if (!sourceConnection) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      return c.json({
        success: true,
        data: await publicSourceConnection(
          sourceConnection.toObject(),
          workspaceId,
        ),
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

sourceConnectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/entities",
    tags: ["Source Connections"],
    summary: "List entities for a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }

      // First, verify the source connection belongs to the workspace
      const ownershipCheck = await SourceConnection.findOne(
        { _id: id, workspaceId: workspaceId },
        { _id: 1 },
      ).lean();
      if (!ownershipCheck) {
        return c.json(
          {
            success: false,
            error: "Source connection not found in this workspace",
          },
          404,
        );
      }

      // Now get the full config using the manager
      const sourceConnection =
        await sourceConnectionManager.getSourceConnection(id);

      if (!sourceConnection) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      // Get connector and its entities
      const connector =
        await syncConnectorRegistry.getConnectorFor(sourceConnection);
      if (!connector) {
        return c.json(
          {
            success: false,
            error: `No connector available for type: ${sourceConnection.type}`,
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
sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/reveal-secret",
    tags: ["Source Connections"],
    summary:
      "Reveal one stored secret of a source connection (admin/owner only)",
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

      if (!workspaceId || !isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
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
              "Revealing a source-connection secret requires the admin or owner workspace role",
          },
          403,
        );
      }

      // The ciphertext comes from OUR record for THIS workspace — never from
      // the caller. This is what makes the oracle impossible.
      const sourceConnection = await SourceConnection.findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
      }).lean();
      if (!sourceConnection) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }

      // Only fields the connector's schema declares secret may be revealed,
      // so this cannot be used to walk arbitrary config.
      const schema = await syncConnectorRegistry.getConfigSchemaForType(
        (sourceConnection as { type: string }).type,
        workspaceId,
      );
      const declared = (schema?.fields ?? []).find(
        (f: ConnectorFieldSchema) => f.name === field,
      );
      const isSecret = declared && isSecretConfigField(declared);
      if (!isSecret) {
        return c.json(
          {
            success: false,
            error: "That field is not a source-connection secret",
          },
          400,
        );
      }

      const stored = (sourceConnection as { config?: Record<string, unknown> })
        .config?.[field];
      if (typeof stored !== "string" || !stored) {
        return c.json({
          success: true,
          data: { value: "", wasEncrypted: false },
        });
      }

      logger.info("Source connection secret revealed", {
        workspaceId,
        sourceConnectionId: id,
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
        logger.error("Source connection secret decryption failed", {
          error,
          workspaceId,
          sourceConnectionId: id,
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

/** @deprecated use sourceConnectionRoutes */
export const dataSourceRoutes = sourceConnectionRoutes;
