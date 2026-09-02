/**
 * A live probe of one connection: does the credential work, and what does one
 * page of an entity look like, straight from the platform behind it.
 *
 * Vocabulary: a CONNECTOR is code (`stripe`, `ws:vercel-ai-gateway`) and a
 * CONNECTION is a credential a workspace configured with it. A connector is
 * defined once — `check` + entities + `read` — and until now the only thing
 * that ever drove a connection was a flow. That makes "does my new Vercel key
 * actually work?" a question answered by creating a flow, waiting for a run,
 * and reading the destination table. The probe drives the connection
 * directly instead, through the same `BaseConnector` contract the sync engine
 * uses, so what it shows is exactly what a flow would land: same code, same
 * credential, same pagination — one bounded page, written nowhere.
 *
 * Three rules, and every surface (MCP tool, REST route, CLI) inherits them
 * because they live here rather than at the edge:
 *
 *   - BOUNDED. One chunk of one API page (`maxIterations: 1`), at most
 *     `limit` records returned. A probe is a look, not a sync.
 *   - READ-ONLY. Nothing is written to any destination, no cursor is
 *     checkpointed, no flow state is touched. The one write is the workspace
 *     connector's `lastCheck` mark, which the existing `/test` route already
 *     makes and which a probe is a superset of.
 *   - NO CREDENTIAL LEAVES. The connector runs with the decrypted config, and
 *     a vendor error message or a record could echo part of it back (an
 *     "invalid key: sk_…" message, a URL with the token in its query string).
 *     Every string value of the config is scrubbed from the whole result
 *     before it is returned.
 */
import { Types } from "mongoose";

import type {
  BaseConnector,
  ConnectionTestResult,
  ConnectorEntitySchema,
} from "./base/BaseConnector";
import {
  SandboxedConnector,
  isWorkspaceConnectorType,
  slugFromType,
} from "./workspace/SandboxedConnector";
import { recordConnectionCheck } from "./workspace/reconcile.service";
import { SourceConnection } from "../database/workspace-schema";
import { loggers } from "../logging";
import { syncConnectorRegistry } from "../sync/connector-registry";
import {
  sourceConnectionManager,
  type SourceConnectionConfig,
} from "../sync/database-data-source-manager";

const logger = loggers.connector();

/** Records returned when the caller does not say. */
export const PROBE_DEFAULT_LIMIT = 20;
/** The most a single probe will ever return: a look, not an export. */
export const PROBE_MAX_LIMIT = 200;
/**
 * Wall-clock budget for the whole probe. A workspace connector may have to
 * boot a sandbox first, so this is generous; a sync that needs longer than
 * this for ONE page is what flows are for.
 */
export const PROBE_TIMEOUT_MS = 90_000;

export type ProbeErrorCode =
  | "invalid_input"
  | "not_found"
  | "connector_unavailable"
  | "unknown_entity"
  | "timeout";

export class ProbeError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProbeError";
  }

  /** HTTP status the REST route answers with. */
  get status(): 400 | 404 | 500 | 504 {
    switch (this.code) {
      case "invalid_input":
      case "unknown_entity":
        return 400;
      case "not_found":
        return 404;
      case "timeout":
        return 504;
      default:
        return 500;
    }
  }
}

export interface ProbeInput {
  workspaceId: string;
  /** The configured source connection (a `connectors` row), from list_connections. */
  connectionId: string;
  /** Entity to read one page of. Omit to check the credential only. */
  entity?: string;
  /** Records to return, 1..PROBE_MAX_LIMIT. Default PROBE_DEFAULT_LIMIT. */
  limit?: number;
  /** Keep only these top-level fields of each record. */
  fields?: string[];
  /** Ask for records changed since this instant, where the connector can. */
  since?: Date;
  /** Override the wall-clock budget (tests). */
  timeoutMs?: number;
}

export interface ProbeResult {
  connection: { id: string; name: string; connector: string };
  check: ConnectionTestResult;
  /** Present when an entity was probed and the check passed. */
  entity?: {
    name: string;
    /** Declared field types, when the connector can say. */
    schema: Record<string, string> | null;
    records: unknown[];
    /** Records returned (after `limit`). */
    count: number;
    /** Records the page actually held before `limit` was applied. */
    received: number;
    /** True when the page held more records than `limit`. */
    truncated: boolean;
    /** True when the platform has further pages after this one. */
    hasMore: boolean;
    /** What the connector logged while reading, for whoever wrote it. */
    logs: Array<{ level: string; message: string }>;
  };
  durationMs: number;
}

/**
 * Test a connector's credential and, for a workspace connector, record the
 * outcome against the indexed definition.
 *
 * Shared by the probe and by `POST /connectors/:id/test`: a connection check
 * that ran for real is the only evidence that may move a workspace connector
 * to `verified`, and a probe is that check plus a read.
 */
export async function runConnectionCheck(input: {
  workspaceId: string;
  sourceConnection: SourceConnectionConfig;
  connector: BaseConnector;
}): Promise<ConnectionTestResult> {
  const { workspaceId, sourceConnection, connector } = input;

  // Pin the check to the code this instance will run, before running it, so
  // a concurrent push cannot make the result refer to a different revision.
  const workspaceSourceSha =
    connector instanceof SandboxedConnector
      ? await connector.sourceShaForConnectionCheck()
      : undefined;

  const result = await connector.testConnection();

  if (isWorkspaceConnectorType(sourceConnection.type)) {
    if (!workspaceSourceSha) {
      throw new Error(
        `Workspace connector ${sourceConnection.type} resolved to an unexpected implementation`,
      );
    }
    await recordConnectionCheck({
      workspaceId,
      slug: slugFromType(sourceConnection.type),
      sourceSha: workspaceSourceSha,
      success: result.success === true,
      message: result.message,
    }).catch(error =>
      logger.warn("Could not record a workspace connector check", {
        workspaceId,
        type: sourceConnection.type,
        error,
      }),
    );
  }

  return result;
}

/**
 * Every string the config holds that is long enough to be a credential.
 *
 * All of them, not only the fields the schema marks secret: a schema that
 * forgot `airbyte_secret` is exactly the case in which a value must still not
 * reach an agent's context. Short values (a region, a port, "self") are left
 * alone — scrubbing "eu" out of every record would be noise, not safety.
 */
export function secretValuesOf(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 6) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(config);
  // Longest first, so a value that contains another is scrubbed whole.
  return [...found].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each secret in `text`. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
    // JSON-escaped form too: a secret with a quote or a backslash in it
    // appears differently inside a serialized record than in prose.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join("[redacted]");
  }
  return out;
}

/** Scrub secrets out of an arbitrary JSON-serializable value. */
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  return JSON.parse(redactSecrets(JSON.stringify(value), secrets)) as T;
}

function schemaFields(
  schema: ConnectorEntitySchema | null,
): Record<string, string> | null {
  if (!schema) return null;
  return Object.fromEntries(
    Object.entries(schema.fields).map(([name, field]) => [name, field.type]),
  );
}

function pickFields(record: unknown, fields: string[]): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const source = record as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) picked[field] = source[field];
  }
  return picked;
}

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProbeError(
            "timeout",
            `${what} did not finish within ${Math.round(ms / 1000)}s. ` +
              "A probe reads one page; if the platform is that slow, sync it with a flow instead.",
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return PROBE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROBE_MAX_LIMIT) {
    throw new ProbeError(
      "invalid_input",
      `limit must be an integer between 1 and ${PROBE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function normalizeFields(fields: string[] | undefined): string[] | undefined {
  if (fields === undefined) return undefined;
  const cleaned = fields.map(f => String(f).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new ProbeError(
      "invalid_input",
      "fields must name at least one field",
    );
  }
  return cleaned;
}

/**
 * Probe a connector: check its credential, then read one bounded page of an
 * entity when one is named. Throws `ProbeError` for caller mistakes and for
 * the deadline; anything else the connector throws is passed through with
 * its secrets scrubbed.
 */
export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  const { workspaceId, connectionId } = input;
  const limit = normalizeLimit(input.limit);
  const fields = normalizeFields(input.fields);
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (!Types.ObjectId.isValid(connectionId)) {
    throw new ProbeError(
      "invalid_input",
      `Invalid connectionId: ${connectionId}`,
    );
  }

  // The id is the caller's; the workspace is the one the caller was
  // authorized for. A probe by id alone would let a member of one workspace
  // exercise another workspace's credential against a live platform.
  const owned = await SourceConnection.findOne(
    { _id: new Types.ObjectId(connectionId), workspaceId },
    { _id: 1 },
  ).lean();
  if (!owned) {
    throw new ProbeError(
      "not_found",
      'Connection not found in this workspace. Call list_connections({ kind: "source" }) for valid ids.',
    );
  }

  const sourceConnection =
    await sourceConnectionManager.getSourceConnection(connectionId);
  if (!sourceConnection) {
    throw new ProbeError("not_found", "Connection not found");
  }
  const secrets = secretValuesOf(sourceConnection.connection);

  const run = async (): Promise<ProbeResult> => {
    const connector =
      await syncConnectorRegistry.getConnectorFor(sourceConnection);
    if (!connector) {
      throw new ProbeError(
        "connector_unavailable",
        `No connector implementation is available for type "${sourceConnection.type}".`,
      );
    }

    const identity = {
      id: sourceConnection.id,
      name: sourceConnection.name,
      connector: sourceConnection.type,
    };

    const check = await runConnectionCheck({
      workspaceId,
      sourceConnection,
      connector,
    });

    if (!input.entity || !check.success) {
      return {
        connection: identity,
        check,
        durationMs: Date.now() - started,
      };
    }

    const entity = input.entity;
    // An entity the connector does not declare is refused up front rather
    // than read as an empty page: "no such entity" is actionable, "0 records"
    // sends the caller looking for a data problem that is a typo.
    const declared = connector.getAvailableEntities();
    if (declared.length > 0 && !declared.includes(entity)) {
      throw new ProbeError(
        "unknown_entity",
        `The connection "${sourceConnection.name}" (${sourceConnection.type}) has no entity "${entity}". ` +
          `It offers: ${declared.join(", ")}.`,
      );
    }

    const records: unknown[] = [];
    let received = 0;
    const logs: Array<{ level: string; message: string }> = [];

    const state = await connector.fetchEntityChunk({
      entity,
      since: input.since,
      batchSize: limit,
      maxIterations: 1,
      onBatch: async batch => {
        received += batch.length;
        const room = limit - records.length;
        if (room > 0) records.push(...batch.slice(0, room));
      },
      onLog: (level, message) => {
        logs.push({ level, message });
      },
    });

    const schema = await connector.resolveSchema(entity).catch(error => {
      logger.warn("Probe could not resolve the entity schema", {
        workspaceId,
        connectionId,
        entity,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    return {
      connection: identity,
      check,
      entity: {
        name: entity,
        schema: schemaFields(schema),
        records: fields ? records.map(r => pickFields(r, fields)) : records,
        count: records.length,
        received,
        truncated: received > records.length,
        hasMore: state.hasMore === true,
        logs: logs.slice(0, 50),
      },
      durationMs: Date.now() - started,
    };
  };

  try {
    const result = await withDeadline(run(), timeoutMs, "The probe");
    return redactValue(result, secrets);
  } catch (error) {
    if (error instanceof ProbeError) {
      error.message = redactSecrets(error.message, secrets);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }
}
