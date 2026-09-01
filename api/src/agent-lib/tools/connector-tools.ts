/**
 * Read-only connector discovery, for an agent authoring `flows/<slug>.yml`.
 *
 * A flow file references its source connector by id and names the entities to
 * sync (`FlowFile.source.connectorId`, `FlowFile.entityFilter`). An agent
 * cannot invent either. Before these tools nothing over MCP could list
 * connectors at all — `list_data_sources` is the in-browser DuckDB tool, a
 * different thing with a confusingly similar name — so an agent could resolve
 * a BigQuery destination but never the Stripe connector feeding it.
 *
 * NO CONFIG VALUES ARE RETURNED, from either tool. A connector's `config` is
 * where its credential lives, and the model decrypts it on read via a getter,
 * so any path that returns `config` returns the secret. `inspect_connector`
 * returns the config field *names* and whether each is a secret — which is
 * what an agent actually needs ("what does this connector require?") — and
 * never a value. Both results are built field-by-field: an allowlist, never a
 * spread of the document, because a spread inherits every field added later.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { Connector as DataSource } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { syncConnectorRegistry } from "../../sync/connector-registry";

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

export function createConnectorTools(workspaceId: string) {
  return {
    list_connectors: tool({
      description: [
        "List the data connectors (Stripe, Close, PostHog, GCS, …) configured in this workspace.",
        "Use this to resolve the `source.connectorId` of a flow definition — a flow file references its connector by id, and the id cannot be guessed.",
        "Returns identity only. Connector credentials are never returned by any tool.",
        "Note: this is NOT `list_data_sources`, which lists in-browser DuckDB materializations for dashboards.",
      ].join("\n"),
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const rows = await DataSource.find({
            workspaceId: new Types.ObjectId(workspaceId),
          })
            // Projection, not just an allowlist below: `config` is decrypted
            // by a getter, so the safest handling is to never load it.
            .select("_id name type description isActive")
            .sort({ name: 1 })
            .lean();

          return {
            connectors: rows.map(row => ({
              id: String(row._id),
              name: (row as { name?: string }).name ?? "",
              type: (row as { type?: string }).type ?? "",
              description: (row as { description?: string }).description ?? "",
              active: (row as { isActive?: boolean }).isActive !== false,
            })),
          };
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
        "Inspect one connector: the entities it can sync, whether it supports incremental pulls, and the config fields it defines.",
        "Use this to fill a flow definition's `entityFilter` (an entity the connector does not offer produces a flow that runs and syncs nothing) and to decide whether `sync.mode: incremental` is even valid for it.",
        "Config field NAMES and whether each is a secret are returned; values never are.",
      ].join("\n"),
      inputSchema: z.object({
        connectorId: z.string().describe("Connector id from list_connectors."),
      }),
      execute: async ({ connectorId }: { connectorId: string }) => {
        if (!Types.ObjectId.isValid(connectorId)) {
          return { error: `Invalid connectorId: ${connectorId}` };
        }
        try {
          const row = await DataSource.findOne({
            _id: new Types.ObjectId(connectorId),
            workspaceId: new Types.ObjectId(workspaceId),
          })
            .select("_id name type description isActive")
            .lean();
          if (!row) {
            return {
              error:
                "Connector not found in this workspace. Call list_connectors for valid ids.",
            };
          }

          const type = (row as { type?: string }).type ?? "";
          const schema = await syncConnectorRegistry
            .getConfigSchemaForType(type)
            .catch(() => null);

          // Entities and incremental capabilities come from a metadata-only
          // instance — `getIncrementalCapabilities` is documented as safe to
          // call on a dummy, and nothing here needs a live credential.
          let entities: string[] = [];
          let incremental: Record<string, unknown> | undefined;
          try {
            const connector = await syncConnectorRegistry.getConnector({
              id: String(row._id),
              name: (row as { name?: string }).name ?? "",
              type,
              active: true,
              connection: {},
              settings: {},
            });
            if (connector) {
              entities = connector.getMetadata().supportedEntities ?? [];
              incremental =
                connector.getIncrementalCapabilities() as unknown as Record<
                  string,
                  unknown
                >;
            }
          } catch (error) {
            // A connector whose class fails to instantiate still has a
            // schema worth returning; say so rather than failing the call.
            logger.warn("Connector metadata unavailable", {
              workspaceId,
              type,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return {
            id: String(row._id),
            name: (row as { name?: string }).name ?? "",
            type,
            active: (row as { isActive?: boolean }).isActive !== false,
            entities,
            incremental: incremental ?? { supported: false, mode: "none" },
            configFields: describeFields(
              (schema as { fields?: unknown } | null)?.fields,
            ),
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
  };
}
