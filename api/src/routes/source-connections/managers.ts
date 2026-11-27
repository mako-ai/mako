/** Who configures a source connection: its managers. */
import { createRoute, z } from "@hono/zod-openapi";
import { connectionsRepo } from "../../repositories/connections";
import { loggers } from "../../logging";
import {
  listChange,
  recordAccessChange,
} from "../../access/connection-access-event";
import {
  changeRefusal,
  managersOf,
  mayChangeSourceConnection,
  mayCreateSourceConnection,
} from "../../access/source-connection-access";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { SourceIdParam, isSourceConnectionId, callerOf } from "./shared";
import { fail } from "../lib/respond";

const logger = loggers.connector();

export const sourceConnectionManagerRoutes = createRouter();

// --- Who configures this connection -----------------------------------------
// Its managers (access/source-connection-access.ts): the creator first, then
// whoever a manager adds. Anyone in the workspace sees them on the row
// (`managers`, `canEdit`); only a manager or the workspace owner changes
// them, in the app.

const MAX_MANAGERS = 50;

sourceConnectionManagerRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/managers",
    tags: ["Source Connections"],
    summary: "Change who configures this source connection",
    security: AUTH_SECURITY,
    request: {
      params: SourceIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              managers: z
                .array(z.string().min(1).max(64))
                .min(1)
                .max(MAX_MANAGERS),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const user = c.get("user");
    // This route takes a person signed in to the app, never an API key. An
    // MCP client goes through set_connection_access, which needs the
    // connections-access grant and checks the same rights.
    if (c.get("authType") !== "session" || !user?.id) {
      return fail(c, 403, "Managers can only be changed in the app");
    }
    if (!workspaceId || !isSourceConnectionId(id)) {
      return fail(c, 400, "Invalid source connection ID format");
    }
    const row = await connectionsRepo.findSourceConnectionById(id, workspaceId);
    if (!row) {
      return fail(c, 404, "Source connection not found");
    }
    const caller = await callerOf(c, workspaceId);
    if (!(await mayChangeSourceConnection(caller, row))) {
      return fail(c, 403, changeRefusal(caller.role));
    }
    const { managers } = c.req.valid("json");
    const next = [...new Set(managers)];
    // Every manager is a member who may configure connections: a viewer, or
    // someone outside the workspace, would hold a key they cannot use.
    const roles = await Promise.all(next.map(e => caller.roleOf(e)));
    const refused = next.filter((_, i) => !mayCreateSourceConnection(roles[i]));
    if (refused.length > 0) {
      return fail(
        c,
        400,
        "Managers must be members or admins of this workspace, not viewers.",
      );
    }
    const before = managersOf(row);
    await connectionsRepo.updateSourceConnection(id, workspaceId, {
      managers: next,
    });
    await recordAccessChange({
      workspaceId,
      connectionId: id,
      kind: "source",
      actor: user.id,
      via: "app",
      changes: { managers: listChange(before, next) },
    });
    logger.info("Source connection managers changed", {
      workspaceId,
      connectionId: id,
      userId: user.id,
      added: next.filter(e => !before.includes(e)),
      removed: before.filter(e => !next.includes(e)),
    });
    return c.json({ success: true, data: { managers: next } });
  },
);
