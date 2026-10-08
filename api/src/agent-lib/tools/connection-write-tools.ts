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
 * Authorization, in layers (same shape as member-tools.ts):
 *
 *   1. The key must carry the `connections:write` scope (grant
 *      `connections-write`), which is never implicit and never a default.
 *      The capability registry hides the tool from keys without it and the
 *      runtime refuses it at execution.
 *   2. The key's OWNER must still hold at least the member role, looked up
 *      live on every call: the capability's `minimumWorkspaceRole`, and again
 *      here, because a key outlives the membership that justified it.
 *   3. It only CREATES. It cannot read, change or delete an existing
 *      connection, so a key holding it cannot swap the credential behind a
 *      running flow or exfiltrate one.
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
 *   - No config value is ever returned, logged, or echoed in an error. Check
 *     messages come from the probe service, which scrubs secret values.
 *   - A connection whose credential check fails is deleted again, so a wrong
 *     key does not leave a dead credential behind for someone to sync from.
 */
import { hasMinimumWorkspaceRole } from "@mako/agent-tools";
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { probeConnection } from "../../connectors/probe.service";
import {
  SourceConnectionInputError,
  assertConnectorTypeUsable,
  createSourceConnection,
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
        "Creates only — it cannot read, update or delete an existing connection. Names must be unique among the workspace's source connections.",
        "Requires an API key or OAuth grant with the 'connections:write' scope whose owner is at least a member of the workspace.",
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

          const identity = { connectionId, name, connector };
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
