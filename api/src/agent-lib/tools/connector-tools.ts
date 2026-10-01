/**
 * Connectors and connections, for an agent.
 *
 * Vocabulary, because the two words used to mean the same row:
 *
 *   - a CONNECTOR is code — `stripe`, `close`, `ws:vercel-ai-gateway` — the
 *     thing that knows how to check a credential and read entities. Built-in
 *     ones live in this repository; workspace ones live in the workspace
 *     repo under `connectors/<slug>/`.
 *   - a CONNECTION is a credential a workspace configured with a connector.
 *     Two kinds: a `database` connection (BigQuery, Postgres, MongoDB… — what
 *     `sql_execute_query` queries and a flow writes to) and a `source`
 *     connection (a Stripe key, a Vercel key — what a flow reads from).
 *
 * `list_connections` (universal-tools.ts) lists both kinds. The tools here
 * are the connector catalog (`list_connectors`, `inspect_connector`), the
 * inspection of one connection (`inspect_connection`), and the live probe of
 * a source connection (`probe_connection`: credential check plus one bounded
 * page of an entity, written nowhere — rules in `connectors/probe.service.ts`,
 * shared with the REST route and the CLI).
 *
 * NO CONFIG VALUES ARE RETURNED, from any tool. A connection's `config` is
 * where its credential lives, and the model decrypts it on read via a getter,
 * so any path that returns `config` returns the secret. `inspect_connection`
 * returns the config field *names* and whether each is a secret — which is
 * what an agent actually needs ("what does this connector require?") — and
 * never a value. Every result is built field-by-field: an allowlist, never a
 * spread of the document, because a spread inherits every field added later.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import {
  PROBE_DEFAULT_LIMIT,
  PROBE_MAX_LIMIT,
  ProbeError,
  probeConnection,
} from "../../connectors/probe.service";
import { connectorRegistry } from "../../connectors/registry";
import { listWorkspaceConnectors } from "../../connectors/workspace/catalog";
import { isWorkspaceConnectorType } from "../../connectors/workspace/SandboxedConnector";
import {
  Connector as SourceConnection,
  DatabaseConnection,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { summarizeConnectionForListing } from "./universal-tools";

const logger = loggers.api("connector-tools");

/** Field names whose VALUES are never returned, whatever the schema says. */
export interface ConnectorConfigField {
  name: string;
  type: string;
  required: boolean;
  /** True when this field holds a credential (encrypted at rest). */
  secret: boolean;
}

/**
 * Describe a connector's config fields without their values.
 *
 * `secret` mirrors exactly the rule `applySchemaEncryption` uses to decide
 * what to encrypt (`encrypted === true || type === "password"`), so what an
 * agent is told is a secret is the same set the route protects. If those two
 * ever disagree, the honest failure is here — hence the shared predicate
 * rather than a second hand-written list.
 */
export function isSecretField(field: {
  encrypted?: boolean;
  type?: string;
}): boolean {
  return field.encrypted === true || field.type === "password";
}

function describeFields(fields: unknown): ConnectorConfigField[] {
  if (!Array.isArray(fields)) return [];
  return fields.map(raw => {
    const field = (raw ?? {}) as {
      name?: unknown;
      type?: unknown;
      required?: unknown;
      encrypted?: boolean;
    };
    return {
      name: String(field.name ?? ""),
      type: String(field.type ?? "string"),
      required: field.required === true,
      secret: isSecretField({
        encrypted: field.encrypted,
        type: typeof field.type === "string" ? field.type : undefined,
      }),
    };
  });
}

const CONNECTION_NOT_FOUND =
  "Connection not found in this workspace. Call list_connections for valid ids.";

interface SourceRow {
  _id: Types.ObjectId;
  name?: string;
  type?: string;
  description?: string;
  isActive?: boolean;
}

/** A source connection's identity, from a projection that never loads `config`. */
async function findSourceConnection(
  workspaceId: string,
  connectionId: string,
): Promise<SourceRow | null> {
  return (await SourceConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("_id name type description isActive")
    .lean()) as SourceRow | null;
}

/**
 * What a connector offers — entities and incremental capabilities — from a
 * metadata-only instance. `getIncrementalCapabilities` is documented as safe
 * to call on a dummy, and nothing here needs a live credential.
 */
async function connectorCapabilities(
  workspaceId: string,
  type: string,
  identity: { id: string; name: string },
): Promise<{ entities: string[]; incremental: Record<string, unknown> }> {
  try {
    const connector = await syncConnectorRegistry.getConnectorFor({
      id: identity.id,
      name: identity.name,
      type,
      workspaceId,
      active: true,
      connection: {},
      settings: {},
    });
    if (connector) {
      return {
        entities: connector.getMetadata().supportedEntities ?? [],
        incremental:
          connector.getIncrementalCapabilities() as unknown as Record<
            string,
            unknown
          >,
      };
    }
  } catch (error) {
    // A connector whose class fails to instantiate still has a schema worth
    // returning; say so rather than failing the call.
    logger.warn("Connector metadata unavailable", {
      workspaceId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { entities: [], incremental: { supported: false, mode: "none" } };
}

/** Config field names (never values) for a connector type. */
async function configFieldsFor(
  workspaceId: string,
  type: string,
): Promise<ConnectorConfigField[]> {
  // The workspace is part of the question for a `ws:` connector: its spec —
  // and so which of its fields are secrets — belongs to this workspace.
  const schema = await syncConnectorRegistry
    .getConfigSchemaForType(type, workspaceId)
    .catch(() => null);
  return describeFields((schema as { fields?: unknown } | null)?.fields);
}

/** Describe one source connection: identity, what its connector offers, its fields. */
async function describeSourceConnection(
  workspaceId: string,
  row: SourceRow,
): Promise<Record<string, unknown>> {
  const type = row.type ?? "";
  const identity = { id: String(row._id), name: row.name ?? "" };
  const [capabilities, configFields] = await Promise.all([
    connectorCapabilities(workspaceId, type, identity),
    configFieldsFor(workspaceId, type),
  ]);
  return {
    id: identity.id,
    name: identity.name,
    kind: "source",
    connector: type,
    description: row.description ?? "",
    active: row.isActive !== false,
    entities: capabilities.entities,
    incremental: capabilities.incremental,
    configFields,
    next: "probe_connection reads one page of an entity live; a flow file references this id as source.connection_id.",
  };
}

/** The catalog: every connector this workspace can configure a connection with. */
async function listConnectorCatalog(workspaceId: string) {
  await connectorRegistry.ready();
  const wsId = new Types.ObjectId(workspaceId);

  // Which connections exist per connector, identity only. This is the link
  // an agent is usually after: "is Stripe configured here, and under which
  // name?" — never the credential.
  const rows = (await SourceConnection.find({ workspaceId: wsId })
    .select("_id name type isActive")
    .sort({ name: 1 })
    .lean()) as SourceRow[];
  const connectionsByType = new Map<
    string,
    Array<{ id: string; name: string; active: boolean }>
  >();
  for (const row of rows) {
    const type = row.type ?? "";
    const list = connectionsByType.get(type) ?? [];
    list.push({
      id: String(row._id),
      name: row.name ?? "",
      active: row.isActive !== false,
    });
    connectionsByType.set(type, list);
  }

  const builtin = connectorRegistry.getAllMetadata().map(entry => ({
    connector: entry.type,
    name: entry.metadata.name,
    version: entry.metadata.version,
    description: entry.metadata.description,
    source: "builtin" as const,
    usable: true,
    entities: entry.metadata.supportedEntities,
    incremental: entry.metadata.incremental,
    webhooks: entry.metadata.webhook.supported,
    connections: connectionsByType.get(entry.type) ?? [],
  }));

  const workspace = (await listWorkspaceConnectors(workspaceId)).map(entry => ({
    connector: entry.type,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    source: "workspace" as const,
    usable: entry.usable,
    status: entry.status,
    ...(entry.blockedReason ? { blockedReason: entry.blockedReason } : {}),
    ...(entry.lastCheckError ? { lastCheckError: entry.lastCheckError } : {}),
    entities: entry.supportedEntities,
    connections: connectionsByType.get(entry.type) ?? [],
  }));

  return {
    connectors: [...builtin, ...workspace].sort((a, b) =>
      a.connector.localeCompare(b.connector),
    ),
  };
}

export function createConnectorTools(workspaceId: string) {
  return {
    list_connectors: tool({
      description: [
        "List the CONNECTORS available to this workspace — the code a connection is configured with: built-in ones (Stripe, Close, PostHog, GCS, …) and the workspace's own (`ws:<slug>`, from `connectors/<slug>/` in its repo).",
        "Each entry carries the entities it can sync, whether incremental pulls are honest, and the `connections` already configured with it (id + name — never a credential).",
        "This is the catalog of what CAN be connected. For what IS connected, call list_connections (databases and sources), and inspect_connection / probe_connection for one of them.",
      ].join("\n"),
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await listConnectorCatalog(workspaceId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("list_connectors failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to list connectors: ${message}` };
        }
      },
    }),

    inspect_connector: tool({
      description: [
        "Inspect one CONNECTOR type from list_connectors (`stripe`, `ws:vercel-ai-gateway`, …): the entities it can sync, whether incremental is valid for it, and the config fields a connection with it needs (names and whether each is a secret; values never).",
        "Use it before asking a user to configure a connection, or to know what a flow can select. For a connection that already exists, call inspect_connection with its id.",
      ].join("\n"),
      inputSchema: z.object({
        connector: z
          .string()
          .optional()
          .describe(
            "Connector type from list_connectors, e.g. `stripe` or `ws:vercel-ai-gateway`.",
          ),
        connectorId: z
          .string()
          .optional()
          .describe(
            "Deprecated: a CONNECTION id. Use inspect_connection({ connectionId }) instead; accepted here so older callers keep working.",
          ),
      }),
      execute: async ({
        connector,
        connectorId,
      }: {
        connector?: string;
        connectorId?: string;
      }) => {
        try {
          // The old contract took a connection id under the connector's
          // name. Keep answering it, and say what to call next time.
          const legacyId =
            connectorId ??
            (connector && Types.ObjectId.isValid(connector)
              ? connector
              : undefined);
          if (legacyId) {
            const row = await findSourceConnection(workspaceId, legacyId);
            if (!row) return { error: CONNECTION_NOT_FOUND };
            return {
              ...(await describeSourceConnection(workspaceId, row)),
              deprecated:
                "This is a CONNECTION, not a connector. Call inspect_connection({ connectionId }) for it, and inspect_connector({ connector }) with a type from list_connectors for the code behind it.",
            };
          }
          if (!connector) {
            return {
              error:
                "Pass `connector` (a type from list_connectors) — or inspect_connection({ connectionId }) for a configured connection.",
            };
          }

          await connectorRegistry.ready();
          const catalog = await listConnectorCatalog(workspaceId);
          const entry = catalog.connectors.find(c => c.connector === connector);
          if (!entry) {
            return {
              error: `No connector "${connector}" is available to this workspace. Call list_connectors for the catalog.`,
            };
          }
          const capabilities = isWorkspaceConnectorType(connector)
            ? {
                entities: entry.entities,
                incremental: { supported: false, mode: "none" },
              }
            : await connectorCapabilities(workspaceId, connector, {
                id: "catalog",
                name: entry.name,
              });
          return {
            ...entry,
            entities: capabilities.entities.length
              ? capabilities.entities
              : entry.entities,
            incremental: capabilities.incremental,
            configFields: await configFieldsFor(workspaceId, connector),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("inspect_connector failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to inspect connector: ${message}` };
        }
      },
    }),

    inspect_connection: tool({
      description: [
        "Inspect one CONNECTION from list_connections, of either kind.",
        "A `source` connection (Stripe key, Vercel key, …) answers with its connector, the entities it can sync, whether incremental is valid, and the config field names (never values) — what a flow's `entities` and `sync.mode` need. A `database` connection answers with its engine and identity — then list_databases / list_tables / inspect_table for its schema.",
        "Credentials are never returned by any tool.",
      ].join("\n"),
      inputSchema: z.object({
        connectionId: z
          .string()
          .describe("Connection id from list_connections."),
      }),
      execute: async ({ connectionId }: { connectionId: string }) => {
        if (!Types.ObjectId.isValid(connectionId)) {
          return { error: `Invalid connectionId: ${connectionId}` };
        }
        try {
          const source = await findSourceConnection(workspaceId, connectionId);
          if (source) {
            return await describeSourceConnection(workspaceId, source);
          }

          // Not `.lean()`: the model decrypts `connection` through a getter,
          // and the summary needs the plaintext host / project (never a
          // password — `summarizeConnectionForListing` reads identity only).
          const database = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          }).select("_id name type connection allowAgentWrites");
          if (!database) return { error: CONNECTION_NOT_FOUND };
          const db = database as unknown as {
            _id: Types.ObjectId;
            name: string;
            type: string;
            connection?: Record<string, unknown>;
            allowAgentWrites?: boolean;
          };
          return {
            ...summarizeConnectionForListing(db),
            kind: "database",
            connector: db.type,
            allowAgentWrites: db.allowAgentWrites === true,
            next: "list_databases / list_tables / inspect_table describe its schema; sql_execute_query queries it; a flow file references this id as destination.connection_id.",
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("inspect_connection failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to inspect connection: ${message}` };
        }
      },
    }),

    probe_connection: tool({
      description: [
        "Run a SOURCE connection LIVE against the platform behind it: check that its credential works and, when `entity` is given, read one page of that entity (at most `limit` records) straight from the source API.",
        "Nothing is written anywhere — no destination table, no sync cursor — so this is safe to call repeatedly. Use it to verify a newly configured connection, to see the real shape of an entity before writing a flow, or for a quick exploratory look at a platform's data before it is in the warehouse.",
        "Get `connectionId` from list_connections (kind `source`) and the entity names from inspect_connection. A connection whose connector is workspace-authored (`ws:`) runs in a sandbox, so its first probe can take tens of seconds.",
        "Returns the check result, then `entity.records`, `entity.schema` (declared field types), `entity.hasMore` (further pages exist on the platform) and `entity.truncated` (the page held more than `limit`). `fields` keeps only the named top-level fields of each record. `since` (ISO 8601) asks for records changed since then, where the connector can.",
        "Credential values never appear in the result; if a vendor message would echo one, it is scrubbed.",
      ].join("\n"),
      inputSchema: z.object({
        connectionId: z
          .string()
          .describe("Source connection id from list_connections."),
        entity: z
          .string()
          .optional()
          .describe(
            "Entity to read one page of (from inspect_connection). Omit to check the credential only.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PROBE_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum records to return (default ${PROBE_DEFAULT_LIMIT}, max ${PROBE_MAX_LIMIT}).`,
          ),
        fields: z
          .array(z.string())
          .optional()
          .describe("Keep only these top-level fields of each record."),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 instant: ask for records changed since then, where the connector supports it.",
          ),
      }),
      execute: async ({
        connectionId,
        entity,
        limit,
        fields,
        since,
      }: {
        connectionId: string;
        entity?: string;
        limit?: number;
        fields?: string[];
        since?: string;
      }) => {
        let sinceDate: Date | undefined;
        if (since !== undefined) {
          sinceDate = new Date(since);
          if (Number.isNaN(sinceDate.getTime())) {
            return { error: `since is not a valid ISO 8601 instant: ${since}` };
          }
        }
        try {
          return await probeConnection({
            workspaceId,
            connectionId,
            entity,
            limit,
            fields,
            since: sinceDate,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          if (!(error instanceof ProbeError)) {
            logger.error("probe_connection failed", {
              workspaceId,
              connectionId,
              entity,
              error: message,
            });
          }
          return {
            error:
              error instanceof ProbeError
                ? message
                : `Probe failed: ${message}`,
            ...(error instanceof ProbeError ? { code: error.code } : {}),
          };
        }
      },
    }),
  };
}
