/** Revealing one stored secret to a person allowed to change the connection. */
import { createRoute, z } from "@hono/zod-openapi";
import { decryptEncrypted } from "../../services/crypto.service";
import { SourceConnection } from "../../database/workspace-schema";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { type ConnectorFieldSchema } from "../../connectors/source-connection-create.service";
import { loggers } from "../../logging";
import { Types } from "mongoose";
import {
  VIEWER_REFUSAL,
  changeRefusal,
  mayChangeSourceConnection,
} from "../../access/source-connection-access";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { WorkspaceParam, isSourceConnectionId, callerOf } from "./shared";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.connector();

export const sourceConnectionRevealSecretRoutes = createRouter();

/**
 * Reveal ONE stored secret of ONE connector the caller's workspace owns.
 *
 * This replaces `POST /decrypt`, which took ciphertext from the request body
 * and returned its plaintext. That endpoint was a cross-tenant decryption
 * oracle: ENCRYPTION_KEY is global, the ciphertext was never bound to a
 * workspace, and membership was the only gate — so any member of any
 * workspace could decrypt ciphertext harvested from another tenant, a DB
 * dump or a backup, and any VIEWER could read admin-managed credentials.
 * (An earlier fix closed the padding-oracle half by collapsing distinct
 * decryption errors to one opaque message; the plaintext-on-success half is
 * what this removes.)
 *
 * The primitive is gone rather than narrowed: the server reads the
 * ciphertext from its OWN record, addressed by connector id scoped to the
 * URL workspace, so nothing decryptable can be supplied by the caller. The
 * gate is the connection's managers and the workspace owner — the same people
 * who may edit these credentials — and every reveal is logged with actor, connector and field, because
 * showing a credential should leave a trace.
 */
sourceConnectionRevealSecretRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/reveal-secret",
    tags: ["Source Connections"],
    summary:
      "Reveal one stored secret of a source connection (its managers and the workspace owner only)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              field: z.string().min(1).max(128).openapi({
                description:
                  "Top-level config field name declared encrypted by the connector's schema.",
              }),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const { field } = await c.req.json();

      if (!workspaceId || !isSourceConnectionId(id)) {
        return fail(c, 400, "Invalid source connection ID format");
      }
      if (typeof field !== "string" || !field) {
        return fail(c, 400, "field is required");
      }

      const user = c.get("user");
      if (!user) {
        return fail(c, 403, VIEWER_REFUSAL);
      }
      // A key is shown to a person, in the app: never to an API key, MCP
      // client or agent.
      if (c.get("authType") !== "session") {
        return fail(c, 403, "Keys can only be revealed in the app");
      }

      // The ciphertext comes from OUR record for THIS workspace — never from
      // the caller. This is what makes the oracle impossible.
      const sourceConnection = await SourceConnection.findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
      }).lean();
      if (!sourceConnection) {
        return fail(c, 404, "Source connection not found");
      }

      // Revealing a credential is a manager's act — the same bar as editing
      // it. Being an admin is NOT enough: only the people the connection's
      // managers picked (and the workspace owner) see its key.
      const caller = await callerOf(c, workspaceId);
      if (!(await mayChangeSourceConnection(caller, sourceConnection))) {
        return fail(c, 403, changeRefusal(caller.role));
      }

      // Only fields the connector's schema declares secret may be revealed,
      // so this cannot be used to walk arbitrary config.
      const schema = await syncConnectorRegistry.getConfigSchemaForType(
        (sourceConnection as { type: string }).type,
        workspaceId,
      );
      const declared = (schema?.fields ?? []).find(
        (f: ConnectorFieldSchema) => f.name === field,
      );
      const isSecret =
        declared &&
        (declared.encrypted === true || declared.type === "password");
      if (!isSecret) {
        return fail(c, 400, "That field is not a source-connection secret");
      }

      const stored = (sourceConnection as { config?: Record<string, unknown> })
        .config?.[field];
      if (typeof stored !== "string" || !stored) {
        return c.json({
          success: true,
          data: { value: "", wasEncrypted: false },
        });
      }

      logger.info("Source connection secret revealed", {
        workspaceId,
        sourceConnectionId: id,
        field,
        actorId: user.id,
      });

      if (!stored.includes(":")) {
        // Stored in the clear (legacy rows predating schema-driven
        // encryption): hand it back, but say so.
        return c.json({
          success: true,
          data: { value: stored, wasEncrypted: false },
        });
      }

      try {
        return c.json({
          success: true,
          data: { value: decryptEncrypted(stored), wasEncrypted: true },
        });
      } catch (error) {
        // One opaque message: distinct decryption failures against the
        // unauthenticated AES-256-CBC scheme are a padding oracle.
        logger.error("Source connection secret decryption failed", {
          error,
          workspaceId,
          sourceConnectionId: id,
          field,
        });
        return fail(c, 400, "Decryption failed");
      }
    } catch (error) {
      logger.error("Reveal-secret endpoint error", { error });
      return failFromThrown(c, error, "Unknown error");
    }
  },
);
