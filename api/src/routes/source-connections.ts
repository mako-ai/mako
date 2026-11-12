/**
 * Source-connection CRUD (credentials configured with a connector).
 *
 * Primary mount: `/api/workspaces/:workspaceId/connections/sources`
 * Deprecated alias: `/api/workspaces/:workspaceId/connectors`
 *
 * This is not the connector *catalog* (`routes/connectors.ts`, `/api/connectors`)
 * and not an app's DuckDB data sources (bindings).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { decryptEncrypted, isEncryptedValue } from "../services/crypto.service";
import {
  SourceConnection,
  type IConnectionWriter,
} from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import {
  PROBE_DEFAULT_LIMIT,
  PROBE_MAX_LIMIT,
  ProbeError,
  probeConnection,
  runConnectionCheck,
} from "../connectors/probe.service";
import {
  type ConnectorFieldSchema,
  SourceConnectionInputError,
  applySchemaEncryption,
  assertCredentialCharacters,
  createSourceConnection,
} from "../connectors/source-connection-create.service";
import {
  KeyRequestError,
  type KeyLinkAuthorizer,
  loadKeyRequest,
  submitKey,
} from "../connectors/connection-key-request.service";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { Types } from "mongoose";
import {
  VIEWER_REFUSAL,
  actingManagers,
  changeRefusal,
  managersOf,
  mayChangeSourceConnection,
  mayCreateSourceConnection,
  peopleOf,
  type Caller,
} from "../access/source-connection-access";
import {
  WRITERS_IN_APP_ONLY,
  nextWriters,
  publicWriters,
  recentWriters,
  SOURCE_LISTABLE_PRINCIPAL,
  writersEditor,
  writersOutsideRefusal,
} from "../access/connection-writers-list";
import { callableFor } from "../connections/callable";
import { mayWrite } from "../connections/proxy.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  SECRET_KEPT,
  redactConnectionSecrets,
  restoreKeptSecrets,
} from "../utils/connection-secrets";

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

// The schema-driven encryption helper lives with the create path it guards
// (connectors/source-connection-create.service.ts); re-exported for the
// update route below and for existing importers of this module.
export {
  applySchemaEncryption,
  SecretEncryptionError,
} from "../connectors/source-connection-create.service";
export type { ConnectorFieldSchema } from "../connectors/source-connection-create.service";

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
    if (
      (field.encrypted === true || field.type === "password") &&
      typeof val === "string" &&
      val
    ) {
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

/** Who is asking: whether they may change a connection is part of its answer. */
async function callerOf(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<Caller> {
  const userId = (c.get("user") as { id?: string } | undefined)?.id;
  const people = peopleOf(workspaceId);
  return {
    ...people,
    role: userId ? await people.roleOf(userId) : null,
    userId,
  };
}

async function publicSourceConnection(
  doc: unknown,
  workspaceId: string,
  caller: Caller,
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
  // Only the managers who can act today: a creator recorded as `system`
  // (seeded or imported connections), someone who left, or a member since
  // made a viewer is not shown. With no one left, the workspace owner.
  const managers = await actingManagers(record, caller);
  return {
    ...record,
    config: redactSourceConfig(record.config, schema),
    managers,
    canEdit: await mayChangeSourceConnection(caller, record, managers),
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

      if (!_workspaceId) {
        return c.json(
          { success: false, error: "Workspace ID is required" },
          400,
        );
      }

      const sourceConnections = await SourceConnection.find({
        workspaceId: _workspaceId,
      })
        .sort({ createdAt: -1 })
        .lean();

      const caller = await callerOf(c, _workspaceId);
      const data = await Promise.all(
        sourceConnections.map(row =>
          publicSourceConnection(row, _workspaceId, caller),
        ),
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
      const { workspaceId: _workspaceId, id } = c.req.valid("param");
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
        data: await publicSourceConnection(
          sourceConnection,
          _workspaceId,
          await callerOf(c, _workspaceId),
        ),
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
      if (!workspaceId) {
        return c.json(
          { success: false, error: "workspaceId is required" },
          400,
        );
      }
      const caller = await callerOf(c, workspaceId);
      if (!mayCreateSourceConnection(caller.role)) {
        return c.json({ success: false, error: VIEWER_REFUSAL }, 403);
      }
      const body = await c.req.json();

      let sourceConnection;
      try {
        sourceConnection = await createSourceConnection({
          workspaceId,
          userId: user.id,
          name: body.name,
          type: body.type,
          description: body.description,
          config: body.config,
          settings: body.settings,
          targetDatabases: body.targetDatabases,
          isActive: body.isActive,
        });
      } catch (error) {
        if (error instanceof SourceConnectionInputError) {
          return c.json({ success: false, error: error.message }, 400);
        }
        throw error;
      }

      return c.json(
        {
          success: true,
          data: await publicSourceConnection(
            sourceConnection.toObject(),
            workspaceId,
            caller,
          ),
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

/**
 * Whether an update changes the connection's type, a field its call profile
 * reads its base URL from, or another field only the app changes: how the
 * key is sent, what reads, static headers (connections/callable.ts).
 */
function changesAddress(
  body: { type?: unknown; config?: unknown },
  current: { type: string; config?: unknown },
): boolean {
  if (body.type !== undefined && body.type !== current.type) return true;
  const incoming = body.config as Record<string, unknown> | undefined;
  if (!incoming || typeof incoming !== "object") return false;
  const stored = (current.config ?? {}) as Record<string, unknown>;
  const callable = callableFor(current.type);
  return [
    ...(callable?.baseUrlFields ?? []),
    ...(callable?.appOnlyFields ?? []),
  ].some(
    field =>
      incoming[field] !== undefined &&
      JSON.stringify(incoming[field]) !== JSON.stringify(stored[field]),
  );
}

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
      const { workspaceId, id } = c.req.valid("param");
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
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, sourceConnection))) {
        return c.json(
          { success: false, error: changeRefusal(caller.role) },
          403,
        );
      }

      // Get the current values (decrypted) for comparison
      const currentValues = sourceConnection.toObject();

      // Where a key is sent is a person's choice, in the app: an API key or
      // agent cannot point a stored credential at another address.
      if (
        c.get("authType") !== "session" &&
        changesAddress(body, currentValues)
      ) {
        return c.json(
          {
            success: false,
            error:
              "The address, how the key is sent and the headers can only be changed in the app",
          },
          403,
        );
      }

      // Track if any changes were made
      let hasChanges = false;

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
        let configChanged = false;

        // Create a new config object starting with current values.
        // Echoed {@link SECRET_KEPT} sentinels become the stored secret again
        // so editing a non-secret field cannot wipe or re-encrypt the key.
        const incoming = restoreKeptSecrets(
          body.config as Record<string, unknown>,
          currentConfig,
        );
        const newConfig = { ...currentConfig };

        // Only update fields that are different
        for (const key in incoming) {
          if (incoming[key] !== currentConfig[key]) {
            newConfig[key] = incoming[key];
            configChanged = true;
          }
        }

        // Only update config if something changed
        if (configChanged) {
          const schema = await syncConnectorRegistry.getConfigSchemaForType(
            sourceConnection.type,
            workspaceId,
          );
          // Only what this call changes: a stored value stays as it is.
          const changed = Object.fromEntries(
            Object.keys(incoming)
              .filter(key => incoming[key] !== currentConfig[key])
              .map(key => [key, incoming[key]]),
          );
          try {
            assertCredentialCharacters(changed, schema);
            const refusal = callableFor(sourceConnection.type)?.configRefusal?.(
              newConfig,
            );
            if (refusal) throw new SourceConnectionInputError(refusal);
          } catch (error) {
            if (error instanceof SourceConnectionInputError) {
              return c.json({ success: false, error: error.message }, 400);
            }
            throw error;
          }
          sourceConnection.config = applySchemaEncryption(newConfig, schema);
          hasChanges = true;
          // The key a link waited for, set in the form instead (an expired
          // link's way out): the connection stops waiting and turns on.
          const awaited = sourceConnection.keyRequest?.fields ?? [];
          if (
            awaited.length > 0 &&
            awaited.every(field => {
              const value = newConfig[field];
              return value !== undefined && value !== "" && value !== null;
            })
          ) {
            sourceConnection.keyRequest = undefined;
            sourceConnection.isActive = true;
          }
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

      // Still waiting for its key after this update: it cannot be switched
      // on (the same answer as PATCH /enable). Setting the key above ends
      // the wait and turns it on.
      if (body.isActive === true && sourceConnection.keyRequest) {
        return c.json(
          {
            success: false,
            error:
              "This connection is waiting for its key. Set the key (through its key link, or in its settings) before enabling it.",
          },
          409,
        );
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
          caller,
        ),
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
      const { workspaceId, id } = c.req.valid("param");
      if (!isSourceConnectionId(id)) {
        return c.json(
          { success: false, error: "Invalid source connection ID format" },
          400,
        );
      }

      const existing = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { createdBy: 1, managers: 1 },
      ).lean();
      if (!existing) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, existing))) {
        return c.json(
          { success: false, error: changeRefusal(caller.role) },
          403,
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
    };
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
      const { workspaceId, id } = c.req.valid("param");
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

      const existing = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { createdBy: 1, managers: 1, keyRequest: 1 },
      ).lean();
      if (!existing) {
        return c.json(
          { success: false, error: "Source connection not found" },
          404,
        );
      }
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, existing))) {
        return c.json(
          { success: false, error: changeRefusal(caller.role) },
          403,
        );
      }
      // A connection still waiting for its key has nothing to sync with.
      if (body.enabled && existing.keyRequest) {
        return c.json(
          {
            success: false,
            error:
              "This connection is waiting for its key. Set the key (through its key link, or in its settings) before enabling it.",
          },
          409,
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
          returnDocument: "after",
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
          caller,
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
 * gate is the connection's managers and the workspace owner — the same people
 * who may edit these credentials — and every reveal is logged with actor, connector and field, because
 * showing a credential should leave a trace.
 */
sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/reveal-secret",
    tags: ["Source Connections"],
    summary:
      "Reveal one stored secret of a source connection (its managers and the workspace owner only)",
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

      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: VIEWER_REFUSAL }, 403);
      }
      // A key is shown to a person, in the app: never to an API key, MCP
      // client or agent.
      if (c.get("authType") !== "session") {
        return c.json(
          { success: false, error: "Keys can only be revealed in the app" },
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

      // Revealing a credential is a manager's act — the same bar as editing
      // it. Being an admin is NOT enough: only the people the connection's
      // managers picked (and the workspace owner) see its key.
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, sourceConnection))) {
        return c.json(
          { success: false, error: changeRefusal(caller.role) },
          403,
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
      const isSecret =
        declared &&
        (declared.encrypted === true || declared.type === "password");
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

// --- Key links ---------------------------------------------------------------
// An agent creates a connection without its key and hands the user a link
// (connectors/connection-key-request.service.ts). These two routes are the
// link's page: what it asks for and where the key goes, and the key the
// person pastes. A person in the app only — never an API key or MCP client —
// and one of the connection's managers, the bar for editing its key. The
// token travels in the body, never in a path a log or analytics records.

const KeyTokenBody = z.object({
  token: z.string().min(1).max(200).openapi({
    description: "The token from the key link's fragment.",
  }),
});

const KEY_REQUEST_HTTP_STATUS = {
  not_found: 404,
  expired: 410,
  forbidden: 403,
  invalid_input: 400,
  check_failed: 422,
} as const;

/** Refusal for a caller who may not use a key link at all, or null. */
function keyLinkRefusal(c: AuthenticatedContext): Response | null {
  if (c.get("authType") !== "session" || !c.get("user")) {
    return c.json(
      { success: false, error: "Key links are opened in the app, signed in" },
      403,
    );
  }
  return null;
}

/** The manager check, run on the connection the token names. */
function keyLinkAuthorizer(caller: Caller): KeyLinkAuthorizer {
  return async connection =>
    (await mayChangeSourceConnection(caller, connection))
      ? null
      : changeRefusal(caller.role);
}

function keyRequestErrorResponse(c: AuthenticatedContext, error: unknown) {
  if (error instanceof KeyRequestError) {
    return c.json(
      { success: false, error: error.message, code: error.code },
      KEY_REQUEST_HTTP_STATUS[error.code],
    );
  }
  logger.error("Key link endpoint error", {
    error: error instanceof Error ? error.message : String(error),
  });
  return c.json({ success: false, error: "Could not use this key link" }, 500);
}

sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/key-requests/lookup",
    tags: ["Source Connections"],
    summary:
      "What a key link asks for: the connection, where its key is sent, and its secret fields",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: { content: { "application/json": { schema: KeyTokenBody } } },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const refused = keyLinkRefusal(c);
    if (refused) return refused;
    try {
      const { token } = c.req.valid("json");
      const caller = await callerOf(c, workspaceId);
      return c.json({
        success: true,
        data: await loadKeyRequest(
          workspaceId,
          token,
          keyLinkAuthorizer(caller),
        ),
      });
    } catch (error) {
      return keyRequestErrorResponse(c, error);
    }
  },
);

sourceConnectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/key-requests/submit",
    tags: ["Source Connections"],
    summary:
      "Set a waiting connection's key through its one-time key link (checked, then stored encrypted)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: KeyTokenBody.extend({
              config: z.record(z.string(), z.string()).openapi({
                description:
                  "Values for the fields the link asks for, keyed by field name.",
              }),
              confirmedDestination: z.boolean().openapi({
                description:
                  "The person confirmed the address and settings the page showed.",
              }),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const refused = keyLinkRefusal(c);
    if (refused) return refused;
    try {
      const { token, config, confirmedDestination } = c.req.valid("json");
      const caller = await callerOf(c, workspaceId);
      const result = await submitKey({
        workspaceId,
        token,
        userId: (c.get("user") as { id: string }).id,
        values: config,
        confirmedDestination,
        authorize: keyLinkAuthorizer(caller),
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      return keyRequestErrorResponse(c, error);
    }
  },
);

// --- Who configures this connection -----------------------------------------
// Its managers (access/source-connection-access.ts): the creator first, then
// whoever a manager adds. Anyone in the workspace sees them on the row
// (`managers`, `canEdit`); only a manager or the workspace owner changes
// them, in the app.

const MAX_MANAGERS = 50;

sourceConnectionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/managers",
    tags: ["Source Connections"],
    summary: "Change who configures this source connection",
    security: AUTH_SECURITY,
    request: {
      params: SourceIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              managers: z
                .array(z.string().min(1).max(64))
                .min(1)
                .max(MAX_MANAGERS),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const user = c.get("user");
    // People pick who holds a key, in the app: never an API key, MCP client
    // or agent, whatever it is asked.
    if (c.get("authType") !== "session" || !user?.id) {
      return c.json(
        { success: false, error: "Managers can only be changed in the app" },
        403,
      );
    }
    if (!workspaceId || !isSourceConnectionId(id)) {
      return c.json(
        { success: false, error: "Invalid source connection ID format" },
        400,
      );
    }
    const row = await SourceConnection.findOne({ _id: id, workspaceId });
    if (!row) {
      return c.json(
        { success: false, error: "Source connection not found" },
        404,
      );
    }
    const caller = await callerOf(c, workspaceId);
    if (!(await mayChangeSourceConnection(caller, row))) {
      return c.json({ success: false, error: changeRefusal(caller.role) }, 403);
    }
    const { managers } = c.req.valid("json");
    const next = [...new Set(managers)];
    // Every manager is a member who may configure connections: a viewer, or
    // someone outside the workspace, would hold a key they cannot use.
    const roles = await Promise.all(next.map(e => caller.roleOf(e)));
    const refused = next.filter((_, i) => !mayCreateSourceConnection(roles[i]));
    if (refused.length > 0) {
      return c.json(
        {
          success: false,
          error:
            "Managers must be members or admins of this workspace, not viewers.",
        },
        400,
      );
    }
    const before = managersOf(row);
    row.set("managers", next);
    await row.save();
    logger.info("Source connection managers changed", {
      workspaceId,
      connectionId: id,
      userId: user.id,
      added: next.filter(e => !before.includes(e)),
      removed: before.filter(e => !next.includes(e)),
    });
    return c.json({ success: true, data: { managers: next } });
  },
);

/** @deprecated use sourceConnectionRoutes */
export const dataSourceRoutes = sourceConnectionRoutes;

// --- Who may write through this connection's proxy ---------------------------
// The same Access tab as a database connection's (access/connection-writes.ts):
// everyone reads (when live reads are on), or only the live readers listed
// and the writers; the listed people and workflows write, anywhere through the connection. Anyone in the workspace may look;
// the connection's managers (and the workspace owner) change it, in the app.
// Syncs are not concerned.

const SourceWriterSchema = z.object({
  // `workflow:*`: every deployed workflow; `workflow:<name>`: that one.
  principal: z
    .string()
    .regex(SOURCE_LISTABLE_PRINCIPAL)
    .openapi({ example: "workflow:*" }),
});

/** One entry per principal. */
function sourceWriters<T extends { principal: string }>(writers: T[]): T[] {
  const seen = new Set<string>();
  return writers.filter(w => !seen.has(w.principal) && seen.add(w.principal));
}

/**
 * The list as the Access tab shows it, one entry per principal. A `where`
 * stored on a source writer (the list's schema is shared with database
 * connections) is ignored by the proxy, so it is not shown either.
 */
function publicSourceWriters(writers: IConnectionWriter[] | undefined) {
  return sourceWriters(publicWriters(writers)).map(w => ({
    ...w,
    where: null,
  }));
}

sourceConnectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/writers",
    tags: ["Source Connections"],
    summary: "Who may read live and write through this source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    if (!workspaceId || !isSourceConnectionId(id)) {
      return c.json(
        { success: false, error: "Invalid source connection ID format" },
        400,
      );
    }
    const row = await SourceConnection.findOne({ _id: id, workspaceId })
      .select("writers liveReads liveReaders type managers createdBy")
      .lean();
    if (!row) {
      return c.json(
        { success: false, error: "Source connection not found" },
        404,
      );
    }
    const caller = await callerOf(c, workspaceId);
    const canEdit =
      c.get("authType") === "session" &&
      (await mayChangeSourceConnection(caller, row));
    return c.json({
      success: true,
      data: {
        writers: publicSourceWriters(row.writers),
        canEdit,
        // Absent (every connection older than the proxy) means off.
        liveReads: row.liveReads === true,
        // Null: everyone in the workspace reads live (when on).
        liveReaders: row.liveReaders
          ? publicSourceWriters(row.liveReaders)
          : null,
        // Whether the proxy can call this connection at all yet.
        callable: callableFor(row.type) !== null,
        recent: await recentWriters(id, principal =>
          mayWrite(row.writers, principal),
        ),
      },
    });
  },
);

sourceConnectionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/writers",
    tags: ["Source Connections"],
    summary:
      "Change who may read live and write through this source connection",
    security: AUTH_SECURITY,
    request: {
      params: SourceIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              writers: z.array(SourceWriterSchema).max(200),
              liveReads: z.boolean().optional(),
              // Null: everyone reads live. A list, even empty: only its
              // principals and the writers. Omitted: unchanged.
              liveReaders: z
                .array(SourceWriterSchema)
                .max(200)
                .nullable()
                .optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const userId = writersEditor(c.get("authType"), c.get("user"));
    if (!userId) {
      return c.json({ success: false, error: WRITERS_IN_APP_ONLY }, 403);
    }
    if (!workspaceId || !isSourceConnectionId(id)) {
      return c.json(
        { success: false, error: "Invalid source connection ID format" },
        400,
      );
    }
    const row = await SourceConnection.findOne({ _id: id, workspaceId });
    if (!row) {
      return c.json(
        { success: false, error: "Source connection not found" },
        404,
      );
    }
    // The same people who configure the connection decide who writes
    // through it: its managers, and the workspace owner.
    const caller = await callerOf(c, workspaceId);
    if (!(await mayChangeSourceConnection(caller, row))) {
      return c.json({ success: false, error: changeRefusal(caller.role) }, 403);
    }
    const json = c.req.valid("json");
    const writers = sourceWriters(json.writers);
    const { liveReads, liveReaders } = json;
    // Plain entries: a stored `where` is ignored on a source connection.
    const stored = sourceWriters(
      (row.writers ?? []).map(w => ({
        principal: w.principal,
        addedBy: w.addedBy,
        addedAt: w.addedAt,
      })),
    );
    const outside = await writersOutsideRefusal(workspaceId, writers, stored);
    if (outside) return c.json({ success: false, error: outside }, 400);
    row.writers = nextWriters(stored, writers, userId);
    if (liveReads !== undefined) row.liveReads = liveReads;
    if (liveReaders === null) {
      row.liveReaders = undefined;
    } else if (liveReaders !== undefined) {
      const readers = sourceWriters(liveReaders);
      const storedReaders = sourceWriters(
        (row.liveReaders ?? []).map(w => ({
          principal: w.principal,
          addedBy: w.addedBy,
          addedAt: w.addedAt,
        })),
      );
      const strangers = await writersOutsideRefusal(
        workspaceId,
        readers,
        storedReaders,
        { readers: true },
      );
      if (strangers) return c.json({ success: false, error: strangers }, 400);
      row.liveReaders = nextWriters(storedReaders, readers, userId);
    }
    await row.save();
    logger.info("Source connection writers changed", {
      workspaceId,
      connectionId: id,
      userId,
      writers: row.writers.length,
      liveReads: row.liveReads === true,
      liveReaders: row.liveReaders ? row.liveReaders.length : "everyone",
    });
    return c.json({ success: true });
  },
);
