/** Checking a connection's credentials: the stored test and the live probe. */
import { createRoute, z } from "@hono/zod-openapi";
import { SourceConnection } from "../../database/workspace-schema";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import {
  PROBE_DEFAULT_LIMIT,
  PROBE_MAX_LIMIT,
  ProbeError,
  boxBusyProbeError,
  probeConnection,
  runConnectionCheck,
} from "../../connectors/probe.service";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { SourceIdParam, isSourceConnectionId } from "./shared";
import { fail, failFromThrown } from "../lib/respond";
import { actingPrincipal } from "../../access/connection-writes";
import { CUSTOM_API_TYPE } from "../../connections/kinds";

const logger = loggers.connector();

export const sourceConnectionVerificationRoutes = createRouter();

sourceConnectionVerificationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Source Connections"],
    summary: "Test a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId) {
        return fail(c, 400, "Workspace ID is required");
      }
      if (!isSourceConnectionId(id)) {
        return fail(c, 400, "Invalid source connection ID format");
      }

      // The id in the URL is the caller's; the workspace in the URL is the
      // one the middleware authorized. Testing a source connection by id alone would
      // let a member of one workspace exercise another's credential — and,
      // now that the outcome is recorded, write to another's index row.
      const ownershipCheck = await SourceConnection.findOne(
        { _id: id, workspaceId },
        { _id: 1 },
      ).lean();
      if (!ownershipCheck) {
        return fail(c, 404, "Source connection not found in this workspace");
      }

      // Use manager to load decrypted configuration before testing
      const ds = await sourceConnectionManager.getSourceConnection(
        id,
        workspaceId,
      );

      if (!ds) {
        return fail(c, 404, "Source connection not found");
      }

      // The stored Custom API Test carries the authenticated actor into the
      // check. Background probes and other connector types keep their existing
      // execution path.
      const actor = ds.type === CUSTOM_API_TYPE ? actingPrincipal() : undefined;
      if (ds.type === CUSTOM_API_TYPE && !actor) {
        return fail(
          c,
          401,
          "An authenticated actor is required to test this connection",
        );
      }

      // Get connector and test connection
      const connector = await syncConnectorRegistry.getConnectorFor(ds);
      if (!connector) {
        return fail(c, 500, `No connector available for type: ${ds.type}`);
      }

      // Runs the check and, for a workspace connector, records it: a real
      // credential and a real answer is the only evidence that may move a
      // workspace connector to `verified`. Shared with the probe, which is
      // this check plus a read.
      // MongoDB accepts uppercase ObjectId strings. Use canonical IDs in the
      // actor binding so equivalent URL spellings still refer to the same row.
      const checkWorkspaceId = actor ? workspaceId.toLowerCase() : workspaceId;
      const result = await runConnectionCheck({
        workspaceId: checkWorkspaceId,
        sourceConnection: ds,
        connector,
        ...(actor
          ? {
              testContext: {
                actor,
                workspaceId: checkWorkspaceId,
                connectionId: ds.id,
              },
            }
          : {}),
      });

      return c.json({
        success: true,
        data: result,
      });
    } catch (error) {
      // The connector box is full: nothing ran, so this is no failed check.
      const busy = boxBusyProbeError(error);
      if (busy) return fail(c, busy.status, busy.message, { code: busy.code });
      return failFromThrown(c, error, "Unknown error");
    }
  },
);

const ProbeBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({
        entity: z.string().optional().openapi({
          description:
            "Entity to read one page of. Omit to check the credential only.",
        }),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PROBE_MAX_LIMIT)
          .optional()
          .openapi({
            description: `Maximum records to return (default ${PROBE_DEFAULT_LIMIT}).`,
          }),
        fields: z.array(z.string()).optional().openapi({
          description: "Keep only these top-level fields of each record.",
        }),
        since: z.string().optional().openapi({
          description:
            "ISO 8601 instant: records changed since then, where the connector supports it.",
        }),
      }),
    },
  },
};

/**
 * The live probe: the check above plus one bounded page of an entity, read
 * from the platform behind the connection and written nowhere. Same service
 * as the `probe_connection` MCP tool and `mako connection probe`, so the
 * three surfaces cannot drift on what "bounded", "read-only" and "no
 * credential in the result" mean. Primary mount:
 * `/api/workspaces/:workspaceId/connections/sources`. `/connectors` is the
 * deprecated alias of the same router.
 */
sourceConnectionVerificationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/probe",
    tags: ["Source Connections"],
    summary:
      "Probe a source connection live: check its credential and read one page of an entity",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam, body: ProbeBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    if (!workspaceId) {
      return fail(c, 400, "Workspace ID is required");
    }
    if (!isSourceConnectionId(id)) {
      return fail(c, 400, "Invalid source connection ID format");
    }

    let body: {
      entity?: string;
      limit?: number;
      fields?: string[];
      since?: string;
    };
    try {
      const raw = await c.req.text();
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return fail(c, 400, "Body must be JSON");
    }

    let since: Date | undefined;
    if (body.since !== undefined) {
      since = new Date(body.since);
      if (Number.isNaN(since.getTime())) {
        return fail(c, 400, `since is not a valid ISO 8601 instant`);
      }
    }

    try {
      const data = await probeConnection({
        workspaceId,
        connectionId: id,
        entity: body.entity,
        limit: body.limit,
        fields: body.fields,
        since,
      });
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof ProbeError) {
        return fail(c, error.status, error.message, { code: error.code });
      }
      logger.error("Connection probe failed", {
        workspaceId,
        connectionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return failFromThrown(c, error, "Unknown error");
    }
  },
);
