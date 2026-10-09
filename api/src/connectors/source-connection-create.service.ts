/**
 * Creating a SOURCE connection: a credential configured with a connector.
 *
 * Shared by `POST /connections/sources` and the MCP `create_connection`
 * tool, so both validate the connector type, encrypt by the connector's own
 * config schema and store the row the same way. A second hand-written copy
 * of this path is how a credential ends up stored in plaintext on one of
 * them; there is one.
 */
import { connectorRegistry } from "./registry";
import { connectorTypeExists } from "./workspace/catalog";
import { isWorkspaceConnectorType } from "./workspace/SandboxedConnector";
import { SourceConnection } from "../database/workspace-schema";
import { encryptString } from "../services/crypto.service";
import { syncConnectorRegistry } from "../sync/connector-registry";

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

/** A caller mistake: the message is safe to show and names no secret. */
export class SourceConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConnectionInputError";
  }
}

export interface CreateSourceConnectionInput {
  workspaceId: string;
  userId: string;
  name: string;
  /** Connector type: `stripe`, `close`, `ws:<slug>`, … */
  type: string;
  description?: string;
  /** Plain config values; secrets are encrypted here, by the connector's schema. */
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  targetDatabases?: unknown[];
  isActive?: boolean;
}

/**
 * Refuse a connector type this workspace cannot use. A `ws:` type is one the
 * workspace wrote, so the answer comes from its index rather than from the
 * global registry, and a blocked connector is refused here rather than at
 * the first sync.
 */
export async function assertConnectorTypeUsable(
  type: string,
  workspaceId: string,
): Promise<void> {
  if (isWorkspaceConnectorType(type)) {
    const exists = await connectorTypeExists(type, workspaceId);
    if (!exists.ok) throw new SourceConnectionInputError(exists.reason);
    return;
  }
  if (!connectorRegistry.hasConnector(type)) {
    throw new SourceConnectionInputError(`Unsupported source type: ${type}`);
  }
}

/** Validate, encrypt and store a new source connection; returns the saved document. */
export async function createSourceConnection(
  input: CreateSourceConnectionInput,
) {
  const { workspaceId, name, type } = input;
  if (!name || !type) {
    throw new SourceConnectionInputError("Name and type are required");
  }
  await assertConnectorTypeUsable(type, workspaceId);

  // Load connector schema for schema-driven encryption
  const schema = await syncConnectorRegistry.getConfigSchemaForType(
    type,
    workspaceId,
  );
  const settings = (input.settings ?? {}) as Record<string, any>;

  const sourceConnection = new SourceConnection({
    workspaceId,
    name,
    type,
    description: input.description,
    config: applySchemaEncryption(input.config || {}, schema),
    settings: {
      sync_batch_size: settings.sync_batch_size || 100,
      rate_limit_delay_ms: settings.rate_limit_delay_ms || 200,
      max_retries: settings.max_retries || 3,
      timeout_ms: settings.timeout_ms || 30000,
      timezone: settings.timezone || "UTC",
    },
    targetDatabases: input.targetDatabases || [],
    createdBy: input.userId,
    isActive: input.isActive !== false,
  });

  await sourceConnection.save();
  return sourceConnection;
}
