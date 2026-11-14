/**
 * A source connection waiting for its key, and the one-time link that sets it.
 *
 * An agent that creates a connection over MCP should not need the API key:
 * a key typed into a chat lands in its transcript. Instead `create_connection`
 * stores the connection WITHOUT its secret fields, inactive, with a
 * `keyRequest`, and hands back a Mako link. The user opens the link, signs
 * in, and pastes the key into the app; the agent sees the connection turn
 * `ready` through inspect_connection / list_connections.
 *
 * The link:
 *
 *   - carries a random 256-bit token; only its SHA-256 is stored, so a
 *     database read does not yield a working link;
 *   - needs a signed-in session of one of the connection's managers (the
 *     bar for editing its key, who can also read it back) — never an API
 *     key or MCP client;
 *   - expires after {@link KEY_REQUEST_TTL_MS};
 *   - works once: the key is stored and the request removed in one atomic
 *     update filtered on the token, so two submissions cannot both win. A key
 *     that fails the connector's check is taken back out and the request put
 *     back, so the person can correct a typo with the same link;
 *   - sets only the fields the request names (the connector's secret
 *     fields), so it cannot change where the key is sent.
 *
 * Values are encrypted by the connector's schema (applySchemaEncryption) and
 * never logged or returned.
 */
import { createHash, randomBytes } from "node:crypto";
import { Types } from "mongoose";

import { callableFor } from "../connections/callable";
import {
  SourceConnection,
  type ISourceConnectionKeyRequest,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { probeConnection } from "./probe.service";
import { ConnectorBindingError } from "./workspace/resolver";
import {
  SourceConnectionInputError,
  applySchemaEncryption,
  assertCredentialCharacters,
  isSecretField,
  type ConnectorFieldSchema,
} from "./source-connection-create.service";

const logger = loggers.connector();

/** How long a key link works. */
export const KEY_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export type KeyRequestStatus = "ready" | "awaiting_key" | "key_link_expired";

export function hashKeyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh request for `fields`, and the token its link carries. */
export function newKeyRequest(input: {
  fields: string[];
  requestedBy: string;
  now?: Date;
}): { token: string; keyRequest: ISourceConnectionKeyRequest } {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    keyRequest: {
      tokenHash: hashKeyToken(token),
      expiresAt: new Date(now.getTime() + KEY_REQUEST_TTL_MS),
      fields: input.fields,
      requestedBy: input.requestedBy,
      createdAt: now,
    },
  };
}

/**
 * The app's page for a key link. The token rides in the fragment: a browser
 * never sends it to a server, so it stays out of access logs, analytics page
 * paths and Referer headers. The page sends it in a request body.
 */
export function keyLinkUrl(workspaceId: string, token: string): string {
  const base = (
    process.env.CLIENT_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:5173"
  ).replace(/\/+$/, "");
  return `${base}/connection-key/${encodeURIComponent(workspaceId)}#${encodeURIComponent(token)}`;
}

export function keyRequestStatus(
  keyRequest: Pick<ISourceConnectionKeyRequest, "expiresAt"> | null | undefined,
  now: Date = new Date(),
): KeyRequestStatus {
  if (!keyRequest) return "ready";
  return new Date(keyRequest.expiresAt).getTime() > now.getTime()
    ? "awaiting_key"
    : "key_link_expired";
}

/**
 * What an agent is told about a connection's key: its status and, while it
 * waits, which fields and until when. Never the token or a value.
 */
export function describeKeyStatus(
  keyRequest: ISourceConnectionKeyRequest | null | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  const status = keyRequestStatus(keyRequest, now);
  if (!keyRequest || status === "ready") return { status };
  return {
    status,
    awaitingFields: keyRequest.fields,
    keyLinkExpiresAt: new Date(keyRequest.expiresAt).toISOString(),
    ...(status === "key_link_expired"
      ? {
          keyHint:
            "The key link expired. Ask the user to open this connection in Mako and paste the key in its settings.",
        }
      : {}),
  };
}

/** A caller-facing refusal: names fields, never values. */
export class KeyRequestError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "expired"
      | "forbidden"
      | "invalid_input"
      | "check_failed"
      /** The connection's connector binding does not resolve. */
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "KeyRequestError";
  }
}

export const KEY_LINK_NOT_FOUND =
  "This key link is not valid, or the key was already set.";
export const KEY_LINK_EXPIRED =
  "This key link has expired. Open the connection in Mako and paste the key in its settings, or ask your agent for a new connection.";

export interface KeyFieldDescriptor {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description?: string;
  placeholder?: string;
}

interface PendingRow {
  _id: Types.ObjectId;
  name: string;
  type: string;
  connectorDefinitionId?: Types.ObjectId;
  config?: Record<string, unknown>;
  createdBy?: string;
  managers?: string[];
  keyRequest?: ISourceConnectionKeyRequest;
}

/**
 * Who may use a link: answers a refusal to show, or null. The route passes
 * the connection's manager check — a key is set by the people who configure
 * the connection, the same bar as its edit form, since they can read it back.
 */
export type KeyLinkAuthorizer = (connection: {
  createdBy?: string;
  managers?: string[];
}) => Promise<string | null>;

async function findPending(
  workspaceId: string,
  token: string,
  authorize?: KeyLinkAuthorizer,
): Promise<PendingRow> {
  if (!token) throw new KeyRequestError("not_found", KEY_LINK_NOT_FOUND);
  const row = (await SourceConnection.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    "keyRequest.tokenHash": hashKeyToken(token),
  })
    .select(
      "_id name type connectorDefinitionId config createdBy managers keyRequest",
    )
    .lean()) as PendingRow | null;
  if (!row?.keyRequest) {
    throw new KeyRequestError("not_found", KEY_LINK_NOT_FOUND);
  }
  const refusal = authorize ? await authorize(row) : null;
  if (refusal) throw new KeyRequestError("forbidden", refusal);
  if (keyRequestStatus(row.keyRequest) === "key_link_expired") {
    throw new KeyRequestError("expired", KEY_LINK_EXPIRED);
  }
  return row;
}

/** The schema of the connector the connection is bound to (resolver.ts). */
async function schemaFor(
  row: PendingRow,
  workspaceId: string,
): Promise<{ fields: ConnectorFieldSchema[] } | null> {
  try {
    return (await syncConnectorRegistry.getConfigSchemaForType(
      row.type,
      workspaceId,
      row,
    )) as { fields: ConnectorFieldSchema[] } | null;
  } catch (error) {
    // Its connector is gone or its name moved: the key is not stored.
    if (error instanceof ConnectorBindingError) {
      throw new KeyRequestError("conflict", error.message);
    }
    throw error;
  }
}

type RawField = ConnectorFieldSchema & {
  label?: string;
  required?: boolean;
  description?: string;
  helperText?: string;
  placeholder?: string;
};

export interface KeyDestination {
  /** Where requests carrying the key go, when the connector says so. */
  address: string | null;
  /** The settings the agent chose, secrets left out: how the key is sent. */
  settings: Array<{ name: string; label: string; value: string }>;
}

/** One stored non-secret value as text; an item list shows its names only. */
function settingText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        item && typeof item === "object"
          ? String((item as { name?: unknown }).name ?? "")
          : String(item),
      )
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Where a pasted key would go. The agent chose this config, and where a key
 * is sent is a person's choice (the edit route refuses address changes from
 * an API key), so the page shows it and the person confirms it.
 */
export function describeDestination(
  type: string,
  config: Record<string, unknown>,
  fields: RawField[],
): KeyDestination {
  let address: string | null;
  try {
    address = callableFor(type)?.baseUrl(config) || null;
  } catch {
    address = null;
  }
  const settings = fields
    .filter(field => !isSecretField(field))
    .filter(field => {
      const value = config[field.name];
      return (
        value !== undefined &&
        value !== null &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0)
      );
    })
    .map(field => ({
      name: field.name,
      label: field.label || field.name,
      value: settingText(config[field.name]),
    }))
    .filter(setting => setting.value !== "");
  return { address, settings };
}

/** The form the link's page shows: the requested fields only. */
export async function loadKeyRequest(
  workspaceId: string,
  token: string,
  authorize?: KeyLinkAuthorizer,
) {
  const row = await findPending(workspaceId, token, authorize);
  const schema = await schemaFor(row, workspaceId);
  const byName = new Map(
    ((schema?.fields ?? []) as RawField[]).map(field => [field.name, field]),
  );
  const fields: KeyFieldDescriptor[] = (
    row.keyRequest as ISourceConnectionKeyRequest
  ).fields.map(name => {
    const field = byName.get(name);
    return {
      name,
      label: field?.label || name,
      type: field?.type || "password",
      required: field?.required === true,
      ...(field?.helperText || field?.description
        ? { description: field.helperText || field.description }
        : {}),
      ...(field?.placeholder ? { placeholder: field.placeholder } : {}),
    };
  });
  return {
    connectionId: String(row._id),
    name: row.name,
    connector: row.type,
    destination: describeDestination(
      row.type,
      row.config ?? {},
      (schema?.fields ?? []) as RawField[],
    ),
    fields,
    expiresAt: new Date(
      (row.keyRequest as ISourceConnectionKeyRequest).expiresAt,
    ).toISOString(),
  };
}

/**
 * Store the key a person pasted, once. Returns the connection's identity and
 * the check result; throws {@link KeyRequestError} with a message safe to show.
 */
export async function submitKey(input: {
  workspaceId: string;
  token: string;
  userId: string;
  values: Record<string, unknown>;
  /** The person confirmed the destination the page showed. */
  confirmedDestination: boolean;
  authorize?: KeyLinkAuthorizer;
  check?: boolean;
}): Promise<{
  connectionId: string;
  name: string;
  connector: string;
  check: { success: boolean; message?: string } | { skipped: true };
}> {
  const { workspaceId, token, userId, check = true } = input;
  const row = await findPending(workspaceId, token, input.authorize);
  const request = row.keyRequest as ISourceConnectionKeyRequest;
  const requested = new Set(request.fields);
  if (input.confirmedDestination !== true) {
    throw new KeyRequestError(
      "invalid_input",
      "Confirm where the key is sent before saving it.",
    );
  }

  const unknown = Object.keys(input.values).filter(key => !requested.has(key));
  if (unknown.length > 0) {
    throw new KeyRequestError(
      "invalid_input",
      `This link sets only: ${request.fields.join(", ")}. Unexpected field(s): ${unknown.join(", ")}.`,
    );
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.values)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new KeyRequestError("invalid_input", `Field ${key} must be text.`);
    }
    values[key] = value;
  }

  const schema = await schemaFor(row, workspaceId);
  const fields = (schema?.fields ?? []) as RawField[];
  const missing = fields
    .filter(field => requested.has(field.name) && field.required === true)
    .map(field => field.name)
    .filter(name => !values[name]);
  if (missing.length > 0 || Object.keys(values).length === 0) {
    throw new KeyRequestError(
      "invalid_input",
      `Fill in: ${(missing.length > 0 ? missing : request.fields).join(", ")}.`,
    );
  }
  // Only secret fields are ever requested; refuse anything else the
  // connector's schema no longer marks secret, rather than store it.
  const notSecret = Object.keys(values).filter(name => {
    const field = fields.find(candidate => candidate.name === name);
    return !field || !isSecretField(field);
  });
  if (notSecret.length > 0) {
    throw new KeyRequestError(
      "invalid_input",
      `The connector no longer declares ${notSecret.join(", ")} as a secret field. Edit the connection in Mako instead.`,
    );
  }

  try {
    assertCredentialCharacters(values, schema);
    const refusal = callableFor(row.type)?.configRefusal?.({
      ...(row.config ?? {}),
      ...values,
    });
    if (refusal) throw new SourceConnectionInputError(refusal);
  } catch (error) {
    if (error instanceof SourceConnectionInputError) {
      throw new KeyRequestError("invalid_input", error.message);
    }
    throw error;
  }

  const encrypted = applySchemaEncryption(values, schema) as Record<
    string,
    string
  >;
  const sets = Object.fromEntries(
    Object.entries(encrypted).map(([key, value]) => [`config.${key}`, value]),
  );

  // The claim: stores the key and consumes the link in one update, filtered
  // on the token and its expiry. A second submission finds nothing.
  const claimed = await SourceConnection.updateOne(
    {
      _id: row._id,
      workspaceId: new Types.ObjectId(workspaceId),
      "keyRequest.tokenHash": request.tokenHash,
      "keyRequest.expiresAt": { $gt: new Date() },
    },
    { $set: { ...sets, isActive: true }, $unset: { keyRequest: "" } },
  );
  if (claimed.modifiedCount !== 1) {
    throw new KeyRequestError("not_found", KEY_LINK_NOT_FOUND);
  }
  const connectionId = String(row._id);
  logger.info("Source connection key set from a key link", {
    workspaceId,
    connectionId,
    connector: row.type,
    setBy: userId,
  });

  const identity = { connectionId, name: row.name, connector: row.type };
  if (!check) return { ...identity, check: { skipped: true } };

  let result: { success: boolean; message?: string };
  try {
    result = (await probeConnection({ workspaceId, connectionId })).check;
  } catch (error) {
    result = {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.success) return { ...identity, check: result };

  // A wrong key: take it back out and put the request back, so the same link
  // works for the corrected one. Only if the row still holds exactly what
  // this call wrote: a key a manager saved in the form meanwhile is theirs.
  await SourceConnection.updateOne(
    {
      _id: row._id,
      workspaceId: new Types.ObjectId(workspaceId),
      keyRequest: { $exists: false },
      ...sets,
    },
    {
      $unset: Object.fromEntries(Object.keys(sets).map(key => [key, ""])),
      $set: { keyRequest: request, isActive: false },
    },
  );
  logger.info("Key from a key link failed its check and was removed", {
    workspaceId,
    connectionId,
    connector: row.type,
  });
  throw new KeyRequestError(
    "check_failed",
    `The key did not work, so it was not kept: ${result.message ?? "no message from the connector"}`,
  );
}

/**
 * The fields a create_connection call leaves for the link: the connector's
 * secret fields the form would show for this config (a Custom API with a
 * bearer token is not asked for a password), when the call passed none of
 * them. A call that passes a key inline gets no link.
 */
export function fieldsForKeyLink(
  config: Record<string, unknown>,
  fields: Array<{
    name: string;
    required: boolean;
    secret: boolean;
    showIf?: { field: string; equals: string[] };
  }>,
): string[] {
  const shown = fields.filter(
    field =>
      field.secret &&
      (!field.showIf ||
        field.showIf.equals.includes(String(config[field.showIf.field]))),
  );
  const given = (name: string) =>
    config[name] !== undefined && config[name] !== "";
  if (shown.some(field => given(field.name))) return [];
  return shown.map(field => field.name);
}
