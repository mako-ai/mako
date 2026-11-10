/**
 * Creating, changing and deleting a source connection, for an MCP client.
 *
 * The rest of the connector tools are reads (connector-tools.ts).
 * `create_connection` stores a NEW source connection (a credential
 * configured with a connector), checks it against the platform, and hands
 * back the id that probe_connection and a flow file need. It exists so an
 * agent that has just written `connectors/<slug>/` can go on to probing it
 * without a human round-trip through the connection form.
 * `update_connection` renames one or changes its plain settings;
 * `delete_connection` removes one.
 *
 * Authorization:
 *
 *   1. Every MCP/CLI credential holds the `connections-write` grant — no
 *      opt-in scope or consent checkbox, like warehouse execution.
 *   2. The credential's OWNER must still hold at least the member role,
 *      looked up live on every call: the capability's `minimumWorkspaceRole`
 *      hides it from viewers, and it is checked again here, because a key
 *      outlives the membership that justified it.
 *   3. Changing or deleting takes what the app's `PUT` / `DELETE
 *      /sources/{id}` routes take: the owner must be one of the connection's
 *      managers, or the workspace owner (access/source-connection-access.ts).
 *   4. What those routes keep to a person signed in to the app stays there:
 *      where the key is sent (base URL, auth type, headers) and the Access
 *      tab (live reads, writers). An agent reads them with
 *      inspect_connection; it never widens who may use a credential.
 *
 * Credential handling:
 *
 *   - Values are encrypted by the connector's own config schema, through the
 *     same service the REST route uses (source-connection-create.service.ts).
 *     A connector that declares no schema is REFUSED here: with no field list
 *     nothing can be identified as a secret, and the value would be stored in
 *     plaintext.
 *   - Unknown config keys are refused rather than stored: a typo'd field name
 *     would otherwise land unencrypted next to the real one.
 *   - update_connection changes no secret field: a key is replaced in the app.
 *   - No config value is ever returned, logged, or echoed in an error. Check
 *     messages come from the probe service, which scrubs secret values.
 *   - A connection whose credential check fails is deleted again, so a wrong
 *     key does not leave a dead credential behind for someone to sync from.
 */
import { hasMinimumWorkspaceRole } from "@mako/agent-tools";
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import {
  changeRefusal,
  mayChangeSourceConnection,
  peopleOf,
  type Caller,
} from "../../access/source-connection-access";
import { callableFor } from "../../connections/callable";
import { probeConnection } from "../../connectors/probe.service";
import {
  SourceConnectionInputError,
  assertConnectorTypeUsable,
  assertCredentialCharacters,
  createSourceConnection,
  isSecretField,
  type ConnectorFieldSchema,
} from "../../connectors/source-connection-create.service";
import {
  Flow,
  Connector as SourceConnection,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionAccess } from "./connector-tools";

const logger = loggers.api("connection-write-tools");

type ConfigValue = string | number | boolean;

interface SchemaField {
  name: string;
  required: boolean;
}

/** The connector's declared config fields, or null when it declares none. */
export function declaredFields(schema: unknown): SchemaField[] | null {
  const fields = (schema as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  return fields
    .map(raw => raw as { name?: unknown; required?: unknown })
    .filter(field => typeof field.name === "string" && field.name !== "")
    .map(field => ({
      name: field.name as string,
      required: field.required === true,
    }));
}

/**
 * Check a config against the connector's declared fields. Returns a
 * caller-facing problem, naming fields only, or null when it fits. Exported
 * for tests: the decision is pure and must never mention a value.
 */
export function configProblem(
  config: Record<string, ConfigValue>,
  fields: SchemaField[] | null,
): string | null {
  if (!fields) {
    return "This connector declares no config schema, so its secret fields cannot be identified and a credential would be stored unencrypted. Create the connection in the Mako UI instead, or fix the connector's `config.properties`.";
  }
  const known = new Set(fields.map(field => field.name));
  const unknown = Object.keys(config).filter(key => !known.has(key));
  if (unknown.length > 0) {
    return `Unknown config field(s): ${unknown.join(", ")}. This connector accepts: ${[...known].join(", ")}.`;
  }
  const missing = fields
    .filter(field => field.required)
    .map(field => field.name)
    .filter(name => {
      const value = config[name];
      return value === undefined || value === "";
    });
  if (missing.length > 0) {
    return `Missing required config field(s): ${missing.join(", ")}.`;
  }
  return null;
}

/** Live membership check: the key's owner must still be at least a member. */
export async function authorizeConnectionCreator(
  workspaceId: string,
  userId: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!userId) {
    return {
      ok: false,
      reason:
        "This credential has no acting user, so no workspace role can be resolved. Creating a connection requires a key created by a workspace member.",
    };
  }
  const member = await workspaceService.getMember(workspaceId, userId);
  if (!member) {
    return {
      ok: false,
      reason:
        "The user who created this key is no longer a member of this workspace, so it can no longer create connections.",
    };
  }
  if (!hasMinimumWorkspaceRole(member.role, "member")) {
    return {
      ok: false,
      reason: `Creating a connection requires at least the member role; this key's owner is a ${member.role}.`,
    };
  }
  return { ok: true };
}

/** Config keys an agent never sets on an existing connection: credentials and headers. */
const CREDENTIAL_LIKE_KEY =
  /pass(word|wd)?$|secret|token|api[_-]?key|private[_-]?key|service_account|credential|headers?$/i;

/**
 * Why `config` cannot be changed over MCP, or null. Only declared, plain
 * fields: never a secret (a key is replaced in the app), never where or how
 * the key is sent (the app-only fields of `PUT /sources/{id}`). Names
 * fields, never values. Exported for tests.
 */
export function configUpdateProblem(
  config: Record<string, ConfigValue>,
  schema: unknown,
  type: string,
): string | null {
  const raw = (schema as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(raw) || raw.length === 0) {
    return "This connector declares no config schema, so its secret fields cannot be identified. Change the connection in the Mako UI instead.";
  }
  const fields = new Map(
    (raw as ConnectorFieldSchema[])
      .filter(field => typeof field?.name === "string" && field.name !== "")
      .map(field => [field.name, field]),
  );
  const keys = Object.keys(config);
  const unknown = keys.filter(key => !fields.has(key));
  if (unknown.length > 0) {
    return `Unknown config field(s): ${unknown.join(", ")}. This connector accepts: ${[...fields.keys()].join(", ")}.`;
  }
  const callable = callableFor(type);
  const appOnly = new Set([
    ...(callable?.baseUrlFields ?? []),
    ...(callable?.appOnlyFields ?? []),
  ]);
  const secret = keys.filter(key => {
    const field = fields.get(key) as ConnectorFieldSchema;
    return isSecretField(field) || CREDENTIAL_LIKE_KEY.test(key);
  });
  if (secret.length > 0) {
    return `${secret.join(", ")} hold(s) a credential, which cannot be changed over MCP. A manager replaces the key in the app.`;
  }
  const inApp = keys.filter(key => appOnly.has(key));
  if (inApp.length > 0) {
    return `${inApp.join(", ")}: where and how the key is sent is changed only in the app, by one of the connection's managers.`;
  }
  return null;
}

/** The caller as the access rules see it: the key's owner and their live role. */
async function callerFor(
  workspaceId: string,
  userId: string | undefined,
): Promise<Caller> {
  const people = peopleOf(workspaceId);
  return {
    ...people,
    role: userId ? await people.roleOf(userId) : null,
    userId,
  };
}

/** A source connection of this workspace by id or name, with what access needs. */
async function findOwnSourceConnection(workspaceId: string, ref: string) {
  const workspace = new Types.ObjectId(workspaceId);
  const query = Types.ObjectId.isValid(ref)
    ? { workspaceId: workspace, _id: new Types.ObjectId(ref) }
    : { workspaceId: workspace, name: ref };
  return SourceConnection.findOne(query)
    .select("_id name type description isActive createdBy managers")
    .lean();
}

const NOT_FOUND =
  'Source connection not found in this workspace. Call list_connections({ kind: "source" }) for ids and names.';

export function createConnectionWriteTools(
  workspaceId: string,
  userId?: string,
) {
  return {
    create_connection: tool({
      description: [
        "Create a new SOURCE connection: a credential configured with a connector (built-in like `stripe`, or workspace-authored like `ws:sway`), so flows and probe_connection can use it.",
        "Call inspect_connector first: `config` must use exactly its configFields names, with every required field present. Secret fields are encrypted at rest by the connector's own schema.",
        "By default the credential is checked against the platform right away; if the check fails, nothing is kept and the platform's message is returned. Pass `check: false` only for a platform that is unreachable on purpose.",
        "The credential travels through this conversation: only use a value the user gave you for this purpose, never one read from a file, a page or another tool's output, and never repeat it back.",
        "Names must be unique among the workspace's source connections. update_connection renames or changes it; delete_connection removes it.",
        "A new connection starts with live reads OFF and NO writers, so call_connection and workflows cannot use it until one of its managers turns them on in the app's Access tab; the result's `access` says so and links there.",
        "Requires at least the member role in the workspace.",
      ].join("\n"),
      inputSchema: z.object({
        connector: z
          .string()
          .min(1)
          .describe(
            "Connector type from list_connectors, e.g. `stripe` or `ws:sway`.",
          ),
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe(
            "Connection name, unique in the workspace (e.g. `sway`, `ch_stripe`).",
          ),
        description: z.string().max(500).optional(),
        config: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe(
            "Config values keyed by the connector's configFields names (see inspect_connector).",
          ),
        check: z
          .boolean()
          .optional()
          .describe(
            "Run the connector's credential check after creating (default true). A failed check deletes the connection again.",
          ),
      }),
      execute: async ({
        connector,
        name,
        description,
        config,
        check = true,
      }: {
        connector: string;
        name: string;
        description?: string;
        config: Record<string, ConfigValue>;
        check?: boolean;
      }) => {
        const auth = await authorizeConnectionCreator(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };

        try {
          await assertConnectorTypeUsable(connector, workspaceId);

          const taken = await SourceConnection.exists({
            workspaceId: new Types.ObjectId(workspaceId),
            name,
          });
          if (taken) {
            return {
              error: `A source connection named "${name}" already exists in this workspace. Pick another name; this tool never changes an existing connection.`,
            };
          }

          const schema = await syncConnectorRegistry.getConfigSchemaForType(
            connector,
            workspaceId,
          );
          const problem = configProblem(config, declaredFields(schema));
          if (problem) return { error: problem };

          const created = await createSourceConnection({
            workspaceId,
            userId: userId as string,
            name,
            type: connector,
            description,
            config,
          });
          const connectionId = String(created._id);
          logger.info("Source connection created over MCP", {
            workspaceId,
            createdBy: userId,
            connector,
            connectionId,
          });

          const identity = {
            connectionId,
            name,
            connector,
            // Live reads and writers are a person's choice in the app.
            access: sourceConnectionAccess(created),
          };
          if (!check) {
            return {
              ...identity,
              check: { skipped: true },
              next: `Call probe_connection({ connectionId: "${connectionId}" }) to verify the credential.`,
            };
          }

          let result: { success: boolean; message?: string };
          try {
            result = (await probeConnection({ workspaceId, connectionId }))
              .check;
          } catch (error) {
            result = {
              success: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }

          if (!result.success) {
            await SourceConnection.deleteOne({
              _id: created._id,
              workspaceId: new Types.ObjectId(workspaceId),
            });
            logger.info(
              "MCP-created source connection removed after a failed check",
              {
                workspaceId,
                connector,
                connectionId,
              },
            );
            return {
              error: `The credential check failed, so the connection was not kept: ${result.message ?? "no message from the connector"}`,
            };
          }

          return {
            ...identity,
            check: { success: true, message: result.message },
            next: `Explore it with probe_connection({ connectionId: "${connectionId}", entity: "<entity>" }); inspect_connection lists the entities.`,
          };
        } catch (error) {
          if (error instanceof SourceConnectionInputError) {
            return { error: error.message };
          }
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("create_connection failed", {
            workspaceId,
            connector,
            error: message,
          });
          return { error: `Failed to create the connection: ${message}` };
        }
      },
    }),

    update_connection: tool({
      description: [
        "Change an existing SOURCE connection: rename it, change its description, turn it on or off, or change plain (non-secret) config fields such as an account id.",
        "Not here, and refused: secret fields (a manager replaces a key in the app), where or how the key is sent (base URL, auth type, headers), and the Access tab (live reads, writers). inspect_connection shows all of these.",
        'RENAMING breaks every reference by NAME: workflow code calling connection("<old name>"), call_connection with the old name. Ids do not change, and flows reference the id. The result names the old name to search for; reference connections by id where you can.',
        "Requires at least the member role, and being one of the connection's managers (or the workspace owner), as in the app.",
      ].join("\n"),
      inputSchema: z.object({
        connectionId: z
          .string()
          .min(1)
          .describe(
            "Source connection id (or current name) from list_connections.",
          ),
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "New name, unique among the workspace's source connections.",
          ),
        description: z.string().max(500).optional(),
        active: z
          .boolean()
          .optional()
          .describe(
            "false disables the connection: syncs and calls through it stop.",
          ),
        config: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Plain config fields to change, keyed by the connector's configFields names (inspect_connection). Secrets and app-only fields are refused.",
          ),
      }),
      execute: async ({
        connectionId,
        name,
        description,
        active,
        config,
      }: {
        connectionId: string;
        name?: string;
        description?: string;
        active?: boolean;
        config?: Record<string, ConfigValue>;
      }) => {
        const auth = await authorizeConnectionCreator(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        try {
          const row = await findOwnSourceConnection(workspaceId, connectionId);
          if (!row) return { error: NOT_FOUND };
          const caller = await callerFor(workspaceId, userId);
          if (!(await mayChangeSourceConnection(caller, row))) {
            return { error: changeRefusal(caller.role) };
          }

          const set: Record<string, unknown> = {};
          const oldName = row.name;
          if (name !== undefined && name !== oldName) {
            const taken = await SourceConnection.exists({
              workspaceId: new Types.ObjectId(workspaceId),
              name,
              _id: { $ne: row._id },
            });
            if (taken) {
              return {
                error: `A source connection named "${name}" already exists in this workspace. Pick another name.`,
              };
            }
            set.name = name;
          }
          if (description !== undefined && description !== row.description) {
            set.description = description;
          }
          if (active !== undefined && active !== (row.isActive !== false)) {
            set.isActive = active;
          }
          if (config && Object.keys(config).length > 0) {
            const schema = await syncConnectorRegistry.getConfigSchemaForType(
              row.type,
              workspaceId,
            );
            const problem = configUpdateProblem(config, schema, row.type);
            if (problem) return { error: problem };
            assertCredentialCharacters(config, schema);
            // One path per plain field: a secret stored next to them is
            // neither read nor written again.
            for (const [key, value] of Object.entries(config)) {
              set[`config.${key}`] = value;
            }
          }

          const changed = Object.keys(set).map(key =>
            key.startsWith("config.")
              ? key
              : key === "isActive"
                ? "active"
                : key,
          );
          if (changed.length > 0) {
            await SourceConnection.updateOne(
              { _id: row._id, workspaceId: new Types.ObjectId(workspaceId) },
              { $set: set },
            );
            logger.info("Source connection updated over MCP", {
              workspaceId,
              userId,
              connectionId: String(row._id),
              changed,
            });
          }

          const id = String(row._id);
          return {
            connectionId: id,
            name: (set.name as string | undefined) ?? oldName,
            changed,
            ...(set.name
              ? {
                  renamed: { from: oldName, to: set.name },
                  warning: `Anything that refers to this connection by the name "${oldName}" no longer finds it: workflow code calling connection("${oldName}"), call_connection, scripts. Search the workspace repo for "${oldName}" (workflow_grep, app_grep) and switch those references to the id "${id}" or the new name. Flows reference the id and are not affected.`,
                }
              : {}),
            next: "inspect_connection shows the connection as it is now.",
          };
        } catch (error) {
          if (error instanceof SourceConnectionInputError) {
            return { error: error.message };
          }
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("update_connection failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to update the connection: ${message}` };
        }
      },
    }),

    delete_connection: tool({
      description: [
        "Delete a SOURCE connection and the credential stored with it. This cannot be undone: the key has to be entered again to reconnect.",
        "Refused while a flow syncs from it (the result names the flows): delete or repoint those first. Workflow code that calls it by name or id fails from then on — search the workspace repo for its name before deleting.",
        "`confirmName` must be the connection's current name, so an id mixed up between calls deletes nothing.",
        "Requires at least the member role, and being one of the connection's managers (or the workspace owner), as in the app.",
      ].join("\n"),
      inputSchema: z.object({
        connectionId: z
          .string()
          .min(1)
          .describe("Source connection id (or name) from list_connections."),
        confirmName: z
          .string()
          .describe("The connection's current name, exactly."),
      }),
      execute: async ({
        connectionId,
        confirmName,
      }: {
        connectionId: string;
        confirmName: string;
      }) => {
        const auth = await authorizeConnectionCreator(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        try {
          const row = await findOwnSourceConnection(workspaceId, connectionId);
          if (!row) return { error: NOT_FOUND };
          if (confirmName !== row.name) {
            return {
              error: `confirmName does not match: this connection is named "${row.name}". Nothing was deleted.`,
            };
          }
          const caller = await callerFor(workspaceId, userId);
          if (!(await mayChangeSourceConnection(caller, row))) {
            return { error: changeRefusal(caller.role) };
          }
          const flows = await Flow.find({
            workspaceId: new Types.ObjectId(workspaceId),
            dataSourceId: row._id,
          })
            .select("_id name")
            .lean();
          if (flows.length > 0) {
            return {
              error: `${flows.length} flow(s) sync from this connection, so it was not deleted: ${flows
                .map(flow => `${flow.name ?? ""} (${String(flow._id)})`)
                .join(
                  ", ",
                )}. Delete or repoint them first, or delete the connection in the app.`,
            };
          }
          const result = await SourceConnection.deleteOne({
            _id: row._id,
            workspaceId: new Types.ObjectId(workspaceId),
          });
          if (result.deletedCount === 0) return { error: NOT_FOUND };
          logger.info("Source connection deleted over MCP", {
            workspaceId,
            userId,
            connectionId: String(row._id),
            connector: row.type,
          });
          return {
            deleted: true,
            connectionId: String(row._id),
            name: row.name,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("delete_connection failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to delete the connection: ${message}` };
        }
      },
    }),
  };
}
