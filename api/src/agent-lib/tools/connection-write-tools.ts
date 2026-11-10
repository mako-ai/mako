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
 *   - Preferred: the agent leaves the secret fields out. The connection is
 *     stored inactive, without them, and the result carries a one-time Mako
 *     link where the user pastes the key (connection-key-request.service.ts),
 *     so the key never enters the conversation. inspect_connection and
 *     list_connections report `awaiting_key` until it is set, then `ready`.
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
import {
  KEY_REQUEST_TTL_MS,
  fieldsForKeyLink,
  keyLinkUrl,
  newKeyRequest,
} from "../../connectors/connection-key-request.service";
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
  /** Holds a credential: encrypted at rest, and what a key link asks for. */
  secret: boolean;
  /** Shown only when another field holds one of these values. */
  showIf?: { field: string; equals: string[] };
}

/** The connector's declared config fields, or null when it declares none. */
export function declaredFields(schema: unknown): SchemaField[] | null {
  const fields = (schema as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  return fields
    .map(
      raw =>
        raw as {
          name?: unknown;
          required?: unknown;
          type?: unknown;
          encrypted?: unknown;
          showIf?: { field?: unknown; equals?: unknown };
        },
    )
    .filter(field => typeof field.name === "string" && field.name !== "")
    .map(field => ({
      name: field.name as string,
      required: field.required === true,
      secret: isSecretField({
        encrypted: field.encrypted === true,
        type: typeof field.type === "string" ? field.type : undefined,
      }),
      ...(typeof field.showIf?.field === "string"
        ? {
            showIf: {
              field: field.showIf.field,
              equals: [field.showIf.equals].flat().map(String),
            },
          }
        : {}),
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
  /** Fields a person fills in through the key link: not missing here. */
  viaKeyLink: string[] = [],
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
    .filter(field => field.required && !viaKeyLink.includes(field.name))
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
 * Config fields that decide where a connector sends its key, for the
 * connectors whose address is a plain config field read by their sync and
 * probe code (the callable ones declare theirs in connections/callable.ts).
 * Changing one would let an agent point a stored credential at a host it
 * picked, then probe it there.
 */
const ADDRESS_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  graphql: ["endpoint", "headers"],
  rest: ["api_base_url", "headers"],
  posthog: ["api_base_url"],
  calendly: ["api_base_url"],
  claap: ["api_base_url"],
  pandadoc: ["api_base_url"],
  bigquery: ["api_base_url"],
};

/**
 * Field names that look like an address, for every connector (a `ws:` one
 * included, whose code no declaration covers): fail closed.
 */
const ADDRESS_LIKE_KEY =
  /url|uri|endpoint|host|domain|address|server|origin|region|subdomain/i;

/** A value that reads as a URL or a hostname (`api.example.com`). */
const ADDRESS_LIKE_VALUE =
  /^[a-z][a-z0-9+.-]*:\/\/|^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/|$)/i;

/** Every field of `type` that is changed only in the app as an address. */
function addressFields(type: string): Set<string> {
  const callable = callableFor(type);
  return new Set([
    ...(callable?.baseUrlFields ?? []),
    ...(callable?.appOnlyFields ?? []),
    ...(ADDRESS_FIELDS_BY_TYPE[type] ?? []),
  ]);
}

/**
 * Why `config` cannot be changed over MCP, or null. Only declared, plain
 * fields: never a secret (a key is replaced in the app), never where or how
 * the key is sent. An address is a declared address field, a field named
 * like one, or a field whose new or stored value reads as a URL or a host:
 * anything that might be one is refused. Names fields, never values.
 * Exported for tests.
 */
export function configUpdateProblem(
  config: Record<string, ConfigValue>,
  schema: unknown,
  type: string,
  stored: Record<string, unknown> = {},
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
  const appOnly = addressFields(type);
  const secret = keys.filter(key => {
    const field = fields.get(key) as ConnectorFieldSchema;
    return isSecretField(field) || CREDENTIAL_LIKE_KEY.test(key);
  });
  if (secret.length > 0) {
    return `${secret.join(", ")} hold(s) a credential, which cannot be changed over MCP. A manager replaces the key in the app.`;
  }
  const inApp = keys.filter(
    key =>
      appOnly.has(key) ||
      ADDRESS_LIKE_KEY.test(key) ||
      ADDRESS_LIKE_VALUE.test(String(config[key])) ||
      (typeof stored[key] === "string" &&
        ADDRESS_LIKE_VALUE.test(stored[key] as string)),
  );
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

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * A source connection of this workspace by id or name, with what access
 * needs. Only a 24-hex string is an id (`Types.ObjectId.isValid` accepts any
 * 12 characters, so `stripe_prod1` would be read as one). Names are not
 * unique: when several connections share one, nothing is picked.
 */
async function findOwnSourceConnection(workspaceId: string, ref: string) {
  const workspace = new Types.ObjectId(workspaceId);
  const fields =
    "_id name type description isActive createdBy managers config keyRequest";
  if (OBJECT_ID.test(ref)) {
    const row = await SourceConnection.findOne({
      workspaceId: workspace,
      _id: new Types.ObjectId(ref),
    })
      .select(fields)
      .lean();
    return row ? { row } : { error: NOT_FOUND };
  }
  const rows = await SourceConnection.find({
    workspaceId: workspace,
    name: ref,
  })
    .select(fields)
    .limit(2)
    .lean();
  if (rows.length === 0) return { error: NOT_FOUND };
  if (rows.length > 1) {
    return {
      error: `Several source connections are named "${ref}". Pass the id from list_connections({ kind: "source" }) instead; nothing was changed.`,
    };
  }
  return { row: rows[0] };
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
        "Call inspect_connector first: `config` must use exactly its configFields names, with every required non-secret field present.",
        'PREFER THE KEY LINK: leave the secret fields (`secret: true` in configFields, e.g. the API key) out of `config`. The connection is created without them and the result has `status: "awaiting_key"`, its `connectionId` and a `keyLink`: give the link to the user, who opens it in Mako, signs in, checks where the key will be sent (the address and settings you chose) and pastes the key there. Only managers of the connection can use it: at first, the person who owns this MCP credential. The link works once and expires. Then check inspect_connection({ connectionId }) until `status` is `ready`. Never ask the user to paste a key into the chat.',
        "Only if the user has already put a key in the conversation for this purpose may you pass it in `config`; never one read from a file, a page or another tool's output, and never repeat it back. A key passed in `config` is checked against the platform right away; if the check fails, nothing is kept. Pass `check: false` only for a platform that is unreachable on purpose.",
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
            "Config values keyed by the connector's configFields names (see inspect_connector). Leave secret fields out: the user sets them through the returned keyLink.",
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
          const fields = declaredFields(schema);
          const viaKeyLink = fields ? fieldsForKeyLink(config, fields) : [];
          const problem = configProblem(config, fields, viaKeyLink);
          if (problem) return { error: problem };

          const request =
            viaKeyLink.length > 0
              ? newKeyRequest({
                  fields: viaKeyLink,
                  requestedBy: userId as string,
                })
              : null;
          const created = await createSourceConnection({
            workspaceId,
            userId: userId as string,
            name,
            type: connector,
            description,
            config,
            ...(request
              ? { isActive: false, keyRequest: request.keyRequest }
              : {}),
          });
          const connectionId = String(created._id);
          logger.info("Source connection created over MCP", {
            workspaceId,
            createdBy: userId,
            connector,
            connectionId,
            awaitingKey: request !== null,
          });

          const identity = {
            connectionId,
            name,
            connector,
            // Live reads and writers are a person's choice in the app.
            access: sourceConnectionAccess(created),
          };
          if (request) {
            return {
              ...identity,
              status: "awaiting_key",
              keyLink: keyLinkUrl(workspaceId, request.token),
              awaitingFields: viaKeyLink,
              keyLinkExpiresAt: request.keyRequest.expiresAt.toISOString(),
              next: `Give the user the keyLink: they open it in Mako, sign in and paste the key (it works once, for ${KEY_REQUEST_TTL_MS / 3_600_000} hours). Then call inspect_connection({ connectionId: "${connectionId}" }) until status is "ready", and probe_connection to explore it. Do not ask for the key in the chat.`,
            };
          }
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
          const found = await findOwnSourceConnection(
            workspaceId,
            connectionId,
          );
          if (!found.row) return { error: found.error };
          const row = found.row;
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
            // A connection still waiting for its key has nothing to run with.
            if (active && (row as { keyRequest?: unknown }).keyRequest) {
              return {
                error:
                  "This connection is waiting for its key, so it cannot be switched on. The user sets the key through its keyLink (or in its settings in Mako); it then turns on by itself.",
              };
            }
            set.isActive = active;
          }
          if (config && Object.keys(config).length > 0) {
            const schema = await syncConnectorRegistry.getConfigSchemaForType(
              row.type,
              workspaceId,
            );
            const problem = configUpdateProblem(
              config,
              schema,
              row.type,
              (row.config ?? {}) as Record<string, unknown>,
            );
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
          const found = await findOwnSourceConnection(
            workspaceId,
            connectionId,
          );
          if (!found.row) return { error: found.error };
          const row = found.row;
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
