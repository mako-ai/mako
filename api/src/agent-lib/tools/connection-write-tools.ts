/**
 * Creating a source connection, for an MCP client.
 *
 * The rest of the connector tools are reads (connector-tools.ts). This is the
 * one write: it stores a NEW source connection (a credential configured with
 * a connector), checks it against the platform, and hands back the id that
 * probe_connection and a flow file need. It exists so an agent that has just
 * written `connectors/<slug>/` can go on to probing it without a human
 * round-trip through the connection form.
 *
 * Authorization:
 *
 *   1. Every MCP/CLI credential holds the `connections-write` grant — no
 *      opt-in scope or consent checkbox, like warehouse execution.
 *   2. The credential's OWNER must still hold at least the member role,
 *      looked up live on every call: the capability's `minimumWorkspaceRole`
 *      hides it from viewers, and it is checked again here, because a key
 *      outlives the membership that justified it.
 *   3. It only CREATES. It cannot read, change or delete an existing
 *      connection, so a key holding it cannot swap the credential behind a
 *      running flow or exfiltrate one.
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
  KEY_REQUEST_TTL_MS,
  fieldsForKeyLink,
  keyLinkUrl,
  newKeyRequest,
} from "../../connectors/connection-key-request.service";
import { probeConnection } from "../../connectors/probe.service";
import {
  SourceConnectionInputError,
  assertConnectorTypeUsable,
  createSourceConnection,
  isSecretField,
} from "../../connectors/source-connection-create.service";
import { Connector as SourceConnection } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";

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

export function createConnectionWriteTools(
  workspaceId: string,
  userId?: string,
) {
  return {
    create_connection: tool({
      description: [
        "Create a new SOURCE connection: a credential configured with a connector (built-in like `stripe`, or workspace-authored like `ws:sway`), so flows and probe_connection can use it.",
        "Call inspect_connector first: `config` must use exactly its configFields names, with every required non-secret field present.",
        'PREFER THE KEY LINK: leave the secret fields (`secret: true` in configFields, e.g. the API key) out of `config`. The connection is created without them and the result has `status: "awaiting_key"`, its `connectionId` and a `keyLink`: give the link to the user, who opens it in Mako, signs in and pastes the key there. The link works once and expires. Then check inspect_connection({ connectionId }) until `status` is `ready`. Never ask the user to paste a key into the chat.',
        "Only if the user has already put a key in the conversation for this purpose may you pass it in `config`; never one read from a file, a page or another tool's output, and never repeat it back. A key passed in `config` is checked against the platform right away; if the check fails, nothing is kept. Pass `check: false` only for a platform that is unreachable on purpose.",
        "Creates only — it cannot read, update or delete an existing connection. Names must be unique among the workspace's source connections.",
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
        keyLink: z
          .boolean()
          .optional()
          .describe(
            "Ask for every secret field absent from `config` through a key link, even when none is required. Without it, a link is returned whenever a required secret field is absent.",
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
        keyLink = false,
        check = true,
      }: {
        connector: string;
        name: string;
        description?: string;
        config: Record<string, ConfigValue>;
        keyLink?: boolean;
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
          const viaKeyLink = fields
            ? fieldsForKeyLink(config, fields, keyLink)
            : [];
          const problem = configProblem(config, fields, viaKeyLink);
          if (problem) return { error: problem };
          if (keyLink && viaKeyLink.length === 0) {
            return {
              error:
                "No secret field is left for a key link: this connector declares none, or `config` already holds them all.",
            };
          }

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

          const identity = { connectionId, name, connector };
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
  };
}
