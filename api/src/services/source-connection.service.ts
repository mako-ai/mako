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
import {
  SECRET_KEPT,
  credentialFragments,
  restoreKeptSecrets,
} from "../utils/connection-secrets";

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
 * THE rule for "is this config field a credential?" — what is encrypted at
 * rest, what reads replace with {@link SECRET_KEPT}, what the agent tools
 * call a secret, and what flow tools scrub from run output. One predicate so
 * those can never disagree. (A workspace connector's `airbyte_secret: true`
 * arrives here as `encrypted: true`, see spec-translation.ts.)
 */
export function isSecretConfigField(field: {
  encrypted?: boolean;
  type?: string;
}): boolean {
  return field.encrypted === true || field.type === "password";
}

/**
 * The plaintext values of every schema-secret field in `config`, including
 * inside `object_array` items, plus the credentials inside each (a JSON
 * blob's string leaves, a `Bearer X` token — see credentialFragments).
 * Secret fields only — a region, an account id or an entity name is not a
 * credential and must not be scrubbed as one.
 */
export function secretConfigValues(
  config: unknown,
  schema: { fields: ConnectorFieldSchema[] },
): string[] {
  const found = new Set<string>();
  const walk = (target: unknown, fields: ConnectorFieldSchema[]): void => {
    if (!target || typeof target !== "object") return;
    for (const field of fields) {
      const value = (target as Record<string, unknown>)[field.name];
      if (field.type === "object_array" && Array.isArray(value)) {
        for (const item of value) walk(item, field.itemFields ?? []);
      } else if (
        isSecretConfigField(field) &&
        typeof value === "string" &&
        value &&
        value !== SECRET_KEPT
      ) {
        credentialFragments(value).forEach(fragment => found.add(fragment));
      }
    }
  };
  walk(config, schema.fields);
  return [...found];
}

/** True when the sentinel appears anywhere in `value` (nested included). */
export function containsSecretSentinel(value: unknown): boolean {
  if (value === SECRET_KEPT) return true;
  if (Array.isArray(value)) return value.some(containsSecretSentinel);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      containsSecretSentinel,
    );
  }
  return false;
}

/**
 * A config that would store the literal {@link SECRET_KEPT} sentinel as a
 * credential. Names the problem, never a value.
 */
export class SecretSentinelError extends Error {
  constructor() {
    super(
      `config contains ${SECRET_KEPT} where there is no stored secret to keep`,
    );
    this.name = "SecretSentinelError";
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

      if (isSecretConfigField(field) && typeof val === "string" && val) {
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

/**
 * Construct and save a source connection, secrets encrypted by schema. A new
 * connection has no stored secret, so a {@link SECRET_KEPT} anywhere in its
 * config is refused rather than encrypted and stored as the credential.
 */
export async function createSourceConnection(
  input: CreateSourceConnectionInput,
) {
  if (containsSecretSentinel(input.config)) throw new SecretSentinelError();
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

/** undefined, null and "" all mean "no value" to the edit form. */
const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === "";

/**
 * Do two non-secret item values agree, the way the edit form round-trips
 * them? Primitives compare as strings (a select stringifies `true`, a
 * number input may send "5"); structured values compare as JSON. Callers
 * skip empty values on either side before asking.
 */
const sameItemValue = (a: unknown, b: unknown): boolean => {
  const primitive = (value: unknown) =>
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
  if (primitive(a) && primitive(b)) return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Merge an incoming `object_array` over the stored one, item by item.
 *
 * A kept secret inside an item — an explicit {@link SECRET_KEPT}, or the
 * secret field omitted or empty — is restored ONLY from the stored item
 * whose declared NON-secret fields agree with the incoming item's, and only
 * when exactly one stored item does. Never by position: the edit form can
 * remove or reorder items, and matching by index would hand one account's
 * token to another. Agreement is normalised to what the form sends: a field
 * empty (undefined / null / "") on either side is ignored, primitives
 * compare as strings, and only fields declared in `itemFields` count.
 *
 * An explicit sentinel with no unique match is dropped and reported in
 * `unresolved`; an omitted/empty secret with no unique match is left out and
 * reported in `omitted` (callers decide: MCP refuses a required one, the
 * REST route saves and warns).
 */
function mergeObjectArray(
  incoming: unknown[],
  stored: unknown,
  itemFields: ConnectorFieldSchema[],
  path: string,
  unresolved: string[],
  omitted: string[],
): unknown[] {
  const secretNames = itemFields
    .filter(field => isSecretConfigField(field))
    .map(field => field.name);
  const matchNames = itemFields
    .filter(field => !isSecretConfigField(field))
    .map(field => field.name);
  const storedItems = (Array.isArray(stored) ? stored : []).filter(
    isPlainObject,
  );
  return incoming.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item)) {
      if (containsSecretSentinel(item)) unresolved.push(itemPath);
      return item;
    }
    const matches = storedItems.filter(candidate =>
      matchNames.every(
        name =>
          isEmptyValue(item[name]) ||
          isEmptyValue(candidate[name]) ||
          sameItemValue(item[name], candidate[name]),
      ),
    );
    const match = matches.length === 1 ? matches[0] : null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (secretNames.includes(key)) continue;
      if (containsSecretSentinel(value)) {
        // A sentinel in a non-secret field has nothing it could stand for.
        unresolved.push(`${itemPath}.${key}`);
        continue;
      }
      out[key] = value;
    }
    for (const name of secretNames) {
      const value = item[name];
      const kept = match?.[name];
      const keptValue = typeof kept === "string" && kept ? kept : undefined;
      if (value === SECRET_KEPT) {
        if (keptValue !== undefined) out[name] = keptValue;
        else unresolved.push(`${itemPath}.${name}`);
      } else if (isEmptyValue(value)) {
        if (keptValue !== undefined) out[name] = keptValue;
        else {
          if (value !== undefined) out[name] = value;
          omitted.push(`${itemPath}.${name}`);
        }
      } else {
        out[name] = value;
      }
    }
    return out;
  });
}

/**
 * Merge an incoming config patch over the stored one.
 *
 * - Keys the patch omits keep their stored value.
 * - A top-level {@link SECRET_KEPT} keeps the stored secret; over a stored
 *   value that is empty or absent there is nothing to keep, so it is
 *   reported in `unresolved` (and dropped, never stored).
 * - Inside an `object_array` (per the connector `schema`), items are matched
 *   to stored items by their non-secret fields, never by position — see
 *   {@link mergeObjectArray}.
 * - A sentinel anywhere else it cannot stand for a stored secret is reported
 *   in `unresolved` and dropped.
 *
 * Callers must refuse a non-empty `unresolved` rather than save; `omitted`
 * lists item secrets left out or empty with no stored item to keep them
 * from (saved without them). Only keys
 * whose value actually differs count as a change. The result is NOT yet
 * encrypted: pass it through {@link applySchemaEncryption} before saving.
 */
export function mergeSourceConnectionConfig(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
  schema: { fields: ConnectorFieldSchema[] } | null,
): {
  config: Record<string, unknown>;
  changed: boolean;
  unresolved: string[];
  omitted: string[];
} {
  const unresolved: string[] = [];
  const omitted: string[] = [];
  const fieldsByName = new Map(
    (schema?.fields ?? []).map(field => [field.name, field]),
  );
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = fieldsByName.get(key);
    if (value === SECRET_KEPT) {
      const stored = currentConfig[key];
      if (typeof stored === "string" && stored) resolved[key] = stored;
      else unresolved.push(key);
    } else if (
      field?.type === "object_array" &&
      Array.isArray(value) &&
      field.itemFields?.length
    ) {
      resolved[key] = mergeObjectArray(
        value,
        currentConfig[key],
        field.itemFields,
        key,
        unresolved,
        omitted,
      );
    } else if (containsSecretSentinel(value)) {
      // Nested somewhere no schema says how to match: never guess.
      unresolved.push(key);
    } else {
      resolved[key] = value;
    }
  }
  // The masked `scheme://user:*****@` connection string the read returned
  // gets its stored password back (no sentinels are left to restore here).
  const incoming = restoreKeptSecrets(resolved, currentConfig);
  const config = { ...currentConfig };
  let changed = false;
  for (const key in incoming) {
    if (incoming[key] !== currentConfig[key]) {
      config[key] = incoming[key];
      changed = true;
    }
  }
  return { config, changed, unresolved, omitted };
}
