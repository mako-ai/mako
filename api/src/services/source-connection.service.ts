/**
 * Writing a source connection (a credential configured with a connector):
 * the one construction and config-merge path, shared by the REST routes
 * behind the "New source connection" form (`routes/source-connections.ts`)
 * and the `create_source_connection` / `update_source_connection` MCP tools.
 *
 * It lives here rather than in the route so there is exactly one place that
 * decides which fields are secrets and encrypts them: a second copy would be
 * a second chance to store an API key in plaintext.
 *
 * No function here ever puts a config VALUE into a thrown message or a
 * return value — field names only.
 */
import { SourceConnection } from "../database/workspace-schema";
import { connectorRegistry } from "../connectors/registry";
import { connectorTypeExists } from "../connectors/workspace/catalog";
import { isWorkspaceConnectorType } from "../connectors/workspace/SandboxedConnector";
import { encryptString } from "./crypto.service";
import { restoreKeptSecrets } from "../utils/connection-secrets";

export type ConnectorFieldSchema = {
  name: string;
  type: string;
  encrypted?: boolean;
  required?: boolean;
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
 * Every call site sits inside a try/catch that maps a throw to a failure.
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

/**
 * Is `type` a connector this workspace may configure a connection with? A
 * `ws:` type is one this workspace wrote, so the answer comes from its index
 * rather than from the global registry, and a blocked connector is refused
 * here rather than at the first sync.
 */
export async function checkSourceConnectorType(
  type: string,
  workspaceId: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isWorkspaceConnectorType(type)) {
    if (!workspaceId) return { ok: false, error: "workspaceId is required" };
    const exists = await connectorTypeExists(type, workspaceId);
    return exists.ok ? { ok: true } : { ok: false, error: exists.reason };
  }
  if (!connectorRegistry.hasConnector(type)) {
    return { ok: false, error: `Unsupported source type: ${type}` };
  }
  return { ok: true };
}

export interface CreateSourceConnectionInput {
  workspaceId: string;
  createdBy: string;
  name: string;
  type: string;
  description?: string;
  /** Plaintext config; secret fields are encrypted with `schema` here. */
  config: Record<string, unknown>;
  /** The connector's config schema (`getConfigSchemaForType`). */
  schema: { fields: ConnectorFieldSchema[] } | null;
  settings?: Partial<{
    sync_batch_size: number;
    rate_limit_delay_ms: number;
    max_retries: number;
    timeout_ms: number;
    timezone: string;
  }>;
  targetDatabases?: unknown[];
  isActive?: boolean;
}

/** Construct and save a source connection, secrets encrypted by schema. */
export async function createSourceConnection(
  input: CreateSourceConnectionInput,
) {
  const sourceConnection = new SourceConnection({
    workspaceId: input.workspaceId,
    name: input.name,
    type: input.type,
    description: input.description,
    config: applySchemaEncryption(input.config || {}, input.schema),
    settings: {
      sync_batch_size: input.settings?.sync_batch_size || 100,
      rate_limit_delay_ms: input.settings?.rate_limit_delay_ms || 200,
      max_retries: input.settings?.max_retries || 3,
      timeout_ms: input.settings?.timeout_ms || 30000,
      timezone: input.settings?.timezone || "UTC",
    },
    targetDatabases: input.targetDatabases || [],
    createdBy: input.createdBy,
    isActive: input.isActive !== false,
  });
  await sourceConnection.save();
  return sourceConnection;
}

/**
 * Merge an incoming config patch over the stored one.
 *
 * Keys the patch omits keep their stored value, and an echoed
 * {@link SECRET_KEPT} sentinel becomes the stored secret again, so editing a
 * non-secret field can neither wipe nor re-encrypt the key. Only keys whose
 * value actually differs count as a change. The result is NOT yet encrypted:
 * pass it through {@link applySchemaEncryption} before saving.
 */
export function mergeSourceConnectionConfig(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean } {
  const incoming = restoreKeptSecrets(patch, currentConfig);
  const config = { ...currentConfig };
  let changed = false;
  for (const key in incoming) {
    if (incoming[key] !== currentConfig[key]) {
      config[key] = incoming[key];
      changed = true;
    }
  }
  return { config, changed };
}
