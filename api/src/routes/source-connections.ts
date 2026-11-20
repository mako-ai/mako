/**
 * Source-connection CRUD (credentials configured with a connector).
 *
 * Primary mount: `/api/workspaces/:workspaceId/connections/sources`
 * Deprecated alias: `/api/workspaces/:workspaceId/connectors`
 *
 * This is not the connector *catalog* (`routes/connectors.ts`, `/api/connectors`)
 * and not an app's DuckDB data sources (bindings).
 *
 * This file holds the access middleware, the config redaction every answer
 * goes through, and create/read/update/delete/enable; the rest of a
 * connection's surface is in ./source-connections/, mounted below in its
 * original registration order.
 */
import { serviceAccountConfigRefusal } from "../connections/google-service-account";
import { createRoute } from "@hono/zod-openapi";
import { isEncryptedValue } from "../services/crypto.service";
import { SourceConnection } from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import {
  type ConnectorFieldSchema,
  SourceConnectionInputError,
  applySchemaEncryption,
  isOrphanConnectorType,
  ORPHAN_TYPE_MESSAGE,
  assertCredentialCharacters,
  createSourceConnection,
} from "../connectors/source-connection-create.service";
import { loggers } from "../logging";
import { forgetConnectionBoxes } from "../connectors/workspace/boxes/scheduler";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  VIEWER_REFUSAL,
  actingManagers,
  changeRefusal,
  mayChangeSourceConnection,
  mayCreateSourceConnection,
  type Caller,
} from "../access/source-connection-access";
import { callableFor } from "../connections/callable";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  SECRET_KEPT,
  redactConnectionSecrets,
  restoreKeptSecrets,
} from "../utils/connection-secrets";
import {
  WorkspaceParam,
  SourceIdParam,
  isSourceConnectionId,
  asSourceRecord,
  OpenBody,
  callerOf,
} from "./source-connections/shared";
import { sourceConnectionVerificationRoutes } from "./source-connections/verification";
import { sourceConnectionEntityRoutes } from "./source-connections/entities";
import { sourceConnectionRevealSecretRoutes } from "./source-connections/reveal-secret";
import { sourceConnectionKeyLinkRoutes } from "./source-connections/key-links";
import { sourceConnectionManagerRoutes } from "./source-connections/managers";
import { sourceConnectionWriterRoutes } from "./source-connections/writers";
import { fail, failFromThrown } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.connector();

export const sourceConnectionRoutes = createRouter();

// Apply unified auth middleware to all source-connection routes
sourceConnectionRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
sourceConnectionRoutes.use("*", requireWorkspaceAccess({ validateId: true }));

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
        return fail(c, 400, "Workspace ID is required");
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
      return failFromThrown(c, error, "Unknown error");
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
        return fail(c, 400, "Invalid source connection ID format");
      }

      const sourceConnection = await SourceConnection.findOne({
        _id: id,
        workspaceId: _workspaceId,
      }).lean();

      if (!sourceConnection) {
        return fail(c, 404, "Source connection not found");
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
      return failFromThrown(c, error, "Unknown error");
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
        return fail(c, 401, "Unauthorized");
      }
      if (!workspaceId) {
        return fail(c, 400, "workspaceId is required");
      }
      const caller = await callerOf(c, workspaceId);
      if (!mayCreateSourceConnection(caller.role)) {
        return fail(c, 403, VIEWER_REFUSAL);
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
          return fail(c, 400, error.message);
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
      return failFromThrown(c, error, "Unknown error");
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
        return fail(c, 400, "Invalid source connection ID format");
      }
      const body = await c.req.json();

      // Find existing source connection
      const sourceConnection = await SourceConnection.findOne({
        _id: id,
        workspaceId,
      });

      if (!sourceConnection) {
        return fail(c, 404, "Source connection not found");
      }
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, sourceConnection))) {
        return fail(c, 403, changeRefusal(caller.role));
      }

      // Get the current values (decrypted) for comparison
      const currentValues = sourceConnection.toObject();

      // A type whose connector was removed: only name, description and
      // switching off still work. Nothing else is written.
      const orphan = await isOrphanConnectorType(
        sourceConnection.type,
        workspaceId,
      );
      const orphanRefusal = () => fail(c, 409, ORPHAN_TYPE_MESSAGE);

      // Where a key is sent is a person's choice, in the app: an API key or
      // agent cannot point a stored credential at another address.
      if (
        c.get("authType") !== "session" &&
        changesAddress(body, currentValues)
      ) {
        return fail(
          c,
          403,
          "The address, how the key is sent and the headers can only be changed in the app",
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
        if (
          orphan ||
          (await isOrphanConnectorType(String(body.type), workspaceId))
        ) {
          return orphanRefusal();
        }
        sourceConnection.type = body.type;
        hasChanges = true;
      }
      if (
        body.isActive !== undefined &&
        body.isActive !== currentValues.isActive
      ) {
        if (orphan && body.isActive) return orphanRefusal();
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
          if (orphan) return orphanRefusal();
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
            const refusal =
              callableFor(sourceConnection.type)?.configRefusal?.(newConfig) ??
              serviceAccountConfigRefusal(newConfig);
            if (refusal) throw new SourceConnectionInputError(refusal);
          } catch (error) {
            if (error instanceof SourceConnectionInputError) {
              return fail(c, 400, error.message);
            }
            throw error;
          }
          sourceConnection.config = applySchemaEncryption(newConfig, schema);
          hasChanges = true;
          // A new credential: the connection's leased boxes and templates
          // were made under the old one.
          forgetConnectionBoxes(String(sourceConnection._id));
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
          if (orphan) return orphanRefusal();
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
          if (orphan) return orphanRefusal();
          sourceConnection.targetDatabases = body.targetDatabases;
          hasChanges = true;
        }
      }

      // Still waiting for its key after this update: it cannot be switched
      // on (the same answer as PATCH /enable). Setting the key above ends
      // the wait and turns it on.
      if (body.isActive === true && sourceConnection.keyRequest) {
        return fail(
          c,
          409,
          "This connection is waiting for its key. Set the key (through its key link, or in its settings) before enabling it.",
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
      return failFromThrown(c, error, "Unknown error");
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
        return fail(c, 400, "Invalid source connection ID format");
      }

      const existing = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { createdBy: 1, managers: 1 },
      ).lean();
      if (!existing) {
        return fail(c, 404, "Source connection not found");
      }
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, existing))) {
        return fail(c, 403, changeRefusal(caller.role));
      }

      const result = await SourceConnection.deleteOne({
        _id: id,
        workspaceId,
      });

      if (result.deletedCount === 0) {
        return fail(c, 404, "Source connection not found");
      }
      forgetConnectionBoxes(id);

      return c.json({
        success: true,
        message: "Connector deleted successfully",
      });
    } catch (error) {
      return failFromThrown(c, error, "Unknown error");
    }
  },
);

// Checking credentials (test, probe) — ./source-connections/verification.ts
sourceConnectionRoutes.route("/", sourceConnectionVerificationRoutes);

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
        return fail(c, 400, "Invalid source connection ID format");
      }
      const body = await c.req.json();

      if (typeof body.enabled !== "boolean") {
        return fail(c, 400, "Enabled field must be a boolean");
      }

      const existing = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { createdBy: 1, managers: 1, keyRequest: 1 },
      ).lean();
      if (!existing) {
        return fail(c, 404, "Source connection not found");
      }
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, existing))) {
        return fail(c, 403, changeRefusal(caller.role));
      }
      // A connection still waiting for its key has nothing to sync with.
      if (body.enabled && existing.keyRequest) {
        return fail(
          c,
          409,
          "This connection is waiting for its key. Set the key (through its key link, or in its settings) before enabling it.",
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
        return fail(c, 404, "Source connection not found");
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
      return failFromThrown(c, error, "Unknown error");
    }
  },
);

// The rest of a connection's surface, in its original registration order.
sourceConnectionRoutes.route("/", sourceConnectionEntityRoutes);
sourceConnectionRoutes.route("/", sourceConnectionRevealSecretRoutes);
sourceConnectionRoutes.route("/", sourceConnectionKeyLinkRoutes);
sourceConnectionRoutes.route("/", sourceConnectionManagerRoutes);
sourceConnectionRoutes.route("/", sourceConnectionWriterRoutes);
