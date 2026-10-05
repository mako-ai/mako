/**
 * Creating and updating a SOURCE connection over MCP — the step a flow file
 * cannot do, and until now the one that needed a human at the "New source
 * connection" form.
 *
 * Authorization is deliberately two checks, the same shape as
 * `invite_workspace_member`:
 *
 *   1. The credential must carry the `sources:write` scope (grant
 *      `sources-write`), which is never implicit and never a default. The MCP
 *      server hides these tools from every session without it.
 *   2. The acting user must STILL be an owner or admin of the workspace,
 *      looked up live on every call (the capability registry's
 *      `minimumWorkspaceRole` refuses a lower role on the MCP call path, and
 *      {@link authorizeSourceWriter} re-checks here). A key outlives the
 *      membership that justified it.
 *
 * THE CREDENTIAL IS WRITE-ONLY. A config goes in, is validated against the
 * connector's own form schema, and is encrypted by the same
 * `applySchemaEncryption` the REST route uses (`services/source-connection
 * .service.ts`, one construction path). Nothing comes back out: results are
 * built field by field from names and booleans, never from the config, and
 * every caller-facing message — including a vendor error from the optional
 * credential check — is scrubbed of every string the config held before it
 * is returned. Nothing here logs a config value either.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { probeConnection, redactSecrets } from "../../connectors/probe.service";
import { SourceConnection } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  applySchemaEncryption,
  checkSourceConnectorType,
  containsSecretSentinel,
  createSourceConnection,
  isSecretConfigField,
  mergeSourceConnectionConfig,
  secretConfigValues,
  type ConnectorFieldSchema,
} from "../../services/source-connection.service";
import { workspaceService } from "../../services/workspace.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { SECRET_KEPT } from "../../utils/connection-secrets";

const logger = loggers.api("source-connection-tools");

export interface SourceWriterAuthorization {
  ok: boolean;
  /** Caller-facing reason, safe to return as a tool result. */
  reason?: string;
}

/**
 * Is the acting user an owner or admin of the workspace RIGHT NOW? The same
 * question `assertOwnerOrAdmin` asks for the flow pipeline routes
 * (`workspaceService.hasRole(…, ["owner", "admin"])`), answered from live
 * membership rather than from anything the credential carries.
 *
 * Shared by the connection tools here and the flow backfill/stream tools.
 */
export async function authorizeSourceWriter(
  workspaceId: string,
  userId: string | undefined,
): Promise<SourceWriterAuthorization> {
  if (!userId) {
    return {
      ok: false,
      reason:
        "This credential has no acting user, so no workspace role can be resolved. Source connections and flow runs can only be managed by a key created by an owner or admin.",
    };
  }
  const allowed = await workspaceService.hasRole(workspaceId, userId, [
    "owner",
    "admin",
  ]);
  if (!allowed) {
    return {
      ok: false,
      reason:
        "Managing source connections and flow runs requires the owner or admin role, and this credential's user does not hold it in this workspace (any more).",
    };
  }
  return { ok: true };
}

type ConfigSchema = { fields: ConnectorFieldSchema[] };

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Check a config against the connector's form schema: no unknown field, the
 * right primitive per declared type, and — for the config that would be
 * STORED — every required field present. Recurses into `object_array` items
 * by their `itemFields`. Problems name fields, never values.
 */
export function validateSourceConfig(
  schema: ConfigSchema,
  config: Record<string, unknown>,
  options: { requireAll: boolean },
): string[] {
  const problems: string[] = [];
  const check = (
    fields: ConnectorFieldSchema[],
    target: Record<string, unknown>,
    prefix: string,
  ): void => {
    const byName = new Map(fields.map(field => [field.name, field]));
    const unknown = Object.keys(target).filter(key => !byName.has(key));
    if (unknown.length > 0) {
      problems.push(
        `Unknown config field(s): ${unknown.map(key => prefix + key).join(", ")}. ${prefix ? `Items of ${prefix.replace(/\[\d+\]\.$/, "")} take` : "This connector takes"}: ${[...byName.keys()].join(", ") || "(no fields)"}.`,
      );
    }
    for (const field of fields) {
      const name = prefix + field.name;
      const value = target[field.name];
      if (!hasValue(value)) {
        if (options.requireAll && field.required === true) {
          problems.push(`Missing required config field: ${name}.`);
        }
        continue;
      }
      if (value === SECRET_KEPT) continue;
      if (isSecretConfigField(field) && typeof value !== "string") {
        problems.push(`Config field ${name} is a secret and must be a string.`);
      } else if (
        field.type === "number" &&
        typeof value !== "number" &&
        !(
          typeof value === "string" &&
          value.trim() !== "" &&
          Number.isFinite(Number(value))
        )
      ) {
        problems.push(`Config field ${name} must be a number.`);
      } else if (field.type === "boolean" && typeof value !== "boolean") {
        problems.push(`Config field ${name} must be a boolean.`);
      } else if (field.type === "object_array") {
        if (!Array.isArray(value)) {
          problems.push(`Config field ${name} must be an array.`);
        } else if (field.itemFields?.length) {
          value.forEach((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              problems.push(
                `Config field ${name}[${index}] must be an object.`,
              );
            } else {
              check(
                field.itemFields as ConnectorFieldSchema[],
                item as Record<string, unknown>,
                `${name}[${index}].`,
              );
            }
          });
        }
      }
    }
  };
  check(schema.fields, config, "");
  return problems;
}

/**
 * The connector's form schema, or a reason it cannot be used. Fails closed:
 * without a schema there is no way to tell which fields are secrets, and the
 * REST route would store them unencrypted — this path refuses instead.
 */
async function loadConfigSchema(
  workspaceId: string,
  connector: string,
): Promise<{ ok: true; schema: ConfigSchema } | { ok: false; error: string }> {
  let schema: unknown;
  try {
    schema = await syncConnectorRegistry.getConfigSchemaForType(
      connector,
      workspaceId,
    );
  } catch (error) {
    return {
      ok: false,
      error: `Could not load the config schema of connector "${connector}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const fields = (schema as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) {
    return {
      ok: false,
      error: `Connector "${connector}" has no config schema, so its secret fields cannot be identified. Configure this connection in the Mako UI instead.`,
    };
  }
  return { ok: true, schema: { fields: fields as ConnectorFieldSchema[] } };
}

/**
 * What a tool's messages are scrubbed of: the values of the connector's
 * secret fields in `config` (and the credentials inside them), longest first.
 */
function scrubListFor(
  config: Record<string, unknown>,
  schema: ConfigSchema,
): string[] {
  return secretConfigValues(config, schema).sort((a, b) => b.length - a.length);
}

/** Field names, whether each is a secret, and whether a value is stored. */
function describeStoredFields(
  schema: ConfigSchema,
  config: Record<string, unknown>,
) {
  return schema.fields.map(field => ({
    name: field.name,
    secret: isSecretConfigField(field),
    set: hasValue(config[field.name]),
  }));
}

/**
 * Optional live credential check: the probe service's check-only mode (no
 * entity read), which already scrubs every config string from its result.
 */
async function runCheck(
  workspaceId: string,
  connectionId: string,
  secrets: readonly string[],
): Promise<{ success: boolean; message?: string }> {
  try {
    const probe = await probeConnection({ workspaceId, connectionId });
    return {
      success: probe.check?.success === true,
      ...(probe.check?.message ? { message: probe.check.message } : {}),
    };
  } catch (error) {
    return {
      success: false,
      message: redactSecrets(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    };
  }
}

const configInput = z
  .record(z.string(), z.unknown())
  .describe(
    "Config fields by name (inspect_connector lists them, with which are secrets). Secret values are write-only: stored encrypted, never returned.",
  );

const checkInput = z
  .boolean()
  .optional()
  .describe(
    "Run the connector's credential check after saving (default true). The result is scrubbed of every config value.",
  );

export function createSourceConnectionTools(
  workspaceId: string,
  userId?: string,
) {
  return {
    create_source_connection: tool({
      description: [
        "Create a SOURCE connection: a credential configured with a connector from list_connectors (`stripe`, `close`, `ws:<slug>`, …) — what a flow's `source.connection_id` names.",
        "`config` is validated against the connector's own config fields (inspect_connector lists them and which are secrets): unknown fields and missing required fields are refused. Secret fields are encrypted with the same path as the UI's form and are WRITE-ONLY — never returned, logged or echoed in an error.",
        "Returns the new connection id and, unless `check: false`, the result of the connector's credential check. Next: probe_connection to read a page of an entity, then write flows/<slug>.yml.",
        "Requires the 'sources:write' scope AND that the credential's user is an owner or admin of the workspace.",
        "To keep secret VALUES out of your own context, a client may call this tool by posting the JSON-RPC request to the MCP endpoint from a shell pipeline that reads the value from a secret manager.",
      ].join("\n"),
      inputSchema: z.object({
        connector: z
          .string()
          .min(1)
          .describe("Connector type from list_connectors, e.g. `stripe`."),
        name: z
          .string()
          .min(1)
          .describe("Display name of the connection, e.g. `fr_stripe`."),
        description: z.string().optional(),
        config: configInput,
        check: checkInput,
      }),
      execute: async ({
        connector,
        name,
        description,
        config,
        check,
      }: {
        connector: string;
        name: string;
        description?: string;
        config: Record<string, unknown>;
        check?: boolean;
      }) => {
        // Filled once the schema says which fields are secrets: their
        // values only — never the sentinel, never a non-secret value, so a
        // message naming __mako_secret_kept__ or a field path stays intact.
        let secrets: string[] = [];
        const scrub = (message: string) => redactSecrets(message, secrets);

        const auth = await authorizeSourceWriter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };

        try {
          const supported = await checkSourceConnectorType(
            connector,
            workspaceId,
          );
          if (!supported.ok) return { error: scrub(supported.error) };

          const loaded = await loadConfigSchema(workspaceId, connector);
          if (!loaded.ok) return { error: scrub(loaded.error) };
          secrets = scrubListFor(config, loaded.schema);
          const problems = validateSourceConfig(loaded.schema, config, {
            requireAll: true,
          });
          if (containsSecretSentinel(config)) {
            problems.push(
              `${SECRET_KEPT} only keeps a stored secret on update_source_connection; a new connection has none to keep.`,
            );
          }
          if (problems.length > 0) {
            return {
              error: scrub(problems.join(" ")),
              problems: problems.map(scrub),
            };
          }

          const saved = await createSourceConnection({
            workspaceId,
            createdBy: userId as string,
            name,
            type: connector,
            description,
            config,
            schema: loaded.schema,
          });
          const id = saved._id.toString();
          logger.info("Source connection created over MCP", {
            workspaceId,
            connectionId: id,
            connector,
            createdBy: userId,
          });

          return {
            id,
            name: saved.name,
            connector,
            active: saved.isActive !== false,
            configFields: describeStoredFields(loaded.schema, config),
            ...(check === false
              ? {}
              : { check: await runCheck(workspaceId, id, secrets) }),
            next: "probe_connection({ connectionId, entity }) reads one live page; a flow file references this id as source.connection_id.",
          };
        } catch (error) {
          const message = scrub(
            error instanceof Error ? error.message : "Unknown error",
          );
          logger.error("create_source_connection failed", {
            workspaceId,
            connector,
            error: message,
          });
          return { error: `Failed to create source connection: ${message}` };
        }
      },
    }),

    update_source_connection: tool({
      description: [
        "Update the config of an existing SOURCE connection (id from list_connections, kind `source`) — e.g. rotate an API key or change an account id.",
        `\`config\` is a PATCH at the top level: a field you omit keeps its stored value, so omit a top-level secret (or pass "${SECRET_KEPT}") to keep it. "${SECRET_KEPT}" over a secret that is not stored is refused.`,
        `A list field (an array of items) is REPLACED by the array you send. Inside it, an item's secret that you omit or pass as "${SECRET_KEPT}" keeps its stored value only when exactly ONE stored item agrees with your item on every non-secret field that is non-empty on both sides (strings compared as text; never matched by position). Otherwise an explicit "${SECRET_KEPT}" is refused, and an omitted or empty secret is refused if that field is required, else saved without a value and listed in \`warnings\`. To change an item's non-secret fields AND keep its secret, send the secret again.`,
        "Unknown fields are refused, and the merged config must still carry every required field.",
        "Secret fields are WRITE-ONLY — never returned, logged or echoed in an error. Unless `check: false`, the connector's credential check runs after saving.",
        "Requires the 'sources:write' scope AND that the credential's user is an owner or admin of the workspace.",
      ].join("\n"),
      inputSchema: z.object({
        connectionId: z
          .string()
          .describe("Source connection id from list_connections."),
        config: configInput,
        check: checkInput,
      }),
      execute: async ({
        connectionId,
        config,
        check,
      }: {
        connectionId: string;
        config: Record<string, unknown>;
        check?: boolean;
      }) => {
        // Filled once the schema says which fields are secrets: their
        // values only — never the sentinel, never a non-secret value, so a
        // message naming __mako_secret_kept__ or a field path stays intact.
        let secrets: string[] = [];
        const scrub = (message: string) => redactSecrets(message, secrets);

        const auth = await authorizeSourceWriter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        if (!Types.ObjectId.isValid(connectionId)) {
          return {
            error: "Invalid connectionId. Call list_connections for valid ids.",
          };
        }

        try {
          const doc = await SourceConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          });
          if (!doc) {
            return {
              error:
                "Source connection not found in this workspace. Call list_connections for valid ids.",
            };
          }
          const connector = doc.type;
          const loaded = await loadConfigSchema(workspaceId, connector);
          if (!loaded.ok) return { error: scrub(loaded.error) };
          secrets = scrubListFor(config, loaded.schema);

          const patchProblems = validateSourceConfig(loaded.schema, config, {
            requireAll: false,
          });
          const current = (doc.toObject().config ?? {}) as Record<
            string,
            unknown
          >;
          const merged = mergeSourceConnectionConfig(
            current,
            config,
            loaded.schema,
          );
          const problems = [
            ...patchProblems,
            // Never store the literal sentinel: where there is no stored
            // secret it can stand for, say so instead of dropping it.
            ...merged.unresolved.map(
              path =>
                `${SECRET_KEPT} at ${path} has no stored secret to keep; pass the value.`,
            ),
            ...validateSourceConfig(loaded.schema, merged.config, {
              requireAll: true,
            }).filter(problem => problem.startsWith("Missing required")),
          ];
          if (problems.length > 0) {
            return {
              error: scrub(problems.join(" ")),
              problems: problems.map(scrub),
            };
          }

          const updatedFields = Object.keys(config).filter(
            key => merged.config[key] !== current[key],
          );
          if (merged.changed) {
            doc.config = applySchemaEncryption(merged.config, loaded.schema);
            await doc.save();
            logger.info("Source connection updated over MCP", {
              workspaceId,
              connectionId,
              connector,
              updatedBy: userId,
              fields: updatedFields,
            });
          }

          return {
            id: connectionId,
            name: doc.name,
            connector,
            updated: merged.changed,
            updatedFields,
            ...(merged.omitted.length > 0
              ? {
                  warnings: merged.omitted.map(
                    path =>
                      `${path}: no value sent and no stored item with the same fields to keep one from — saved without it.`,
                  ),
                }
              : {}),
            configFields: describeStoredFields(loaded.schema, merged.config),
            ...(check === false
              ? {}
              : {
                  check: await runCheck(workspaceId, connectionId, secrets),
                }),
          };
        } catch (error) {
          const message = scrub(
            error instanceof Error ? error.message : "Unknown error",
          );
          logger.error("update_source_connection failed", {
            workspaceId,
            connectionId,
            error: message,
          });
          return { error: `Failed to update source connection: ${message}` };
        }
      },
    }),
  };
}
