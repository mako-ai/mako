/** Who may write through a source connection's proxy. */
import { createRoute, z } from "@hono/zod-openapi";
import type { IConnectionWriter } from "../../database/workspace-schema";
import {
  connectionsRepo,
  type UpdateSourceConnectionInput,
} from "../../repositories/connections";
import { loggers } from "../../logging";
import {
  changeRefusal,
  mayChangeSourceConnection,
} from "../../access/source-connection-access";
import {
  WRITERS_IN_APP_ONLY,
  nextWriters,
  publicWriters,
  recentWriters,
  SOURCE_LISTABLE_PRINCIPAL,
  writersEditor,
  writersOutsideRefusal,
} from "../../access/connection-writers-list";
import {
  listChange,
  recordAccessChange,
} from "../../access/connection-access-event";
import { callableFor } from "../../connections/callable";
import { mayWrite } from "../../connections/proxy.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { SourceIdParam, isSourceConnectionId, callerOf } from "./shared";
import { fail } from "../lib/respond";

const logger = loggers.connector();

export const sourceConnectionWriterRoutes = createRouter();

// --- Who may write through this connection's proxy ---------------------------
// The same Access tab as a database connection's (access/connection-writes.ts):
// everyone reads (when live reads are on), or only the live readers listed
// and the writers; the listed people and workflows write, anywhere through the connection. Anyone in the workspace may look;
// the connection's managers (and the workspace owner) change it, in the app.
// Syncs are not concerned.

const SourceWriterSchema = z.object({
  // `workflow:*`: every deployed workflow; `workflow:<name>`: that one.
  principal: z
    .string()
    .regex(SOURCE_LISTABLE_PRINCIPAL)
    .openapi({ example: "workflow:*" }),
});

/** One entry per principal. */
function sourceWriters<T extends { principal: string }>(writers: T[]): T[] {
  const seen = new Set<string>();
  return writers.filter(w => !seen.has(w.principal) && seen.add(w.principal));
}

/**
 * The list as the Access tab shows it, one entry per principal. A `where`
 * stored on a source writer (the list's schema is shared with database
 * connections) is ignored by the proxy, so it is not shown either.
 */
function publicSourceWriters(writers: IConnectionWriter[] | undefined) {
  return sourceWriters(publicWriters(writers)).map(w => ({
    ...w,
    where: null,
  }));
}

sourceConnectionWriterRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/writers",
    tags: ["Source Connections"],
    summary: "Who may read live and write through this source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    if (!workspaceId || !isSourceConnectionId(id)) {
      return fail(c, 400, "Invalid source connection ID format");
    }
    const row = await connectionsRepo.findSourceConnectionById(id, workspaceId);
    if (!row) {
      return fail(c, 404, "Source connection not found");
    }
    const caller = await callerOf(c, workspaceId);
    const canEdit =
      c.get("authType") === "session" &&
      (await mayChangeSourceConnection(caller, row));
    return c.json({
      success: true,
      data: {
        writers: publicSourceWriters(row.writers),
        canEdit,
        // Absent (every connection older than the proxy) means off.
        liveReads: row.liveReads === true,
        // Null: everyone in the workspace reads live (when on).
        liveReaders: row.liveReaders
          ? publicSourceWriters(row.liveReaders)
          : null,
        // Whether the proxy can call this connection at all yet.
        callable: callableFor(row.type) !== null,
        recent: await recentWriters(
          id,
          principal => mayWrite(row.writers, principal),
          workspaceId,
        ),
      },
    });
  },
);

sourceConnectionWriterRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/writers",
    tags: ["Source Connections"],
    summary:
      "Change who may read live and write through this source connection",
    security: AUTH_SECURITY,
    request: {
      params: SourceIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              writers: z.array(SourceWriterSchema).max(200),
              liveReads: z.boolean().optional(),
              // Null: everyone reads live. A list, even empty: only its
              // principals and the writers. Omitted: unchanged.
              liveReaders: z
                .array(SourceWriterSchema)
                .max(200)
                .nullable()
                .optional(),
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
    const userId = writersEditor(c.get("authType"), c.get("user"));
    if (!userId) {
      return fail(c, 403, WRITERS_IN_APP_ONLY);
    }
    if (!workspaceId || !isSourceConnectionId(id)) {
      return fail(c, 400, "Invalid source connection ID format");
    }
    const row = await connectionsRepo.findSourceConnectionById(id, workspaceId);
    if (!row) {
      return fail(c, 404, "Source connection not found");
    }
    // The same people who configure the connection decide who writes
    // through it: its managers, and the workspace owner.
    const caller = await callerOf(c, workspaceId);
    if (!(await mayChangeSourceConnection(caller, row))) {
      return fail(c, 403, changeRefusal(caller.role));
    }
    const json = c.req.valid("json");
    const writers = sourceWriters(json.writers);
    const { liveReads, liveReaders } = json;
    // Plain entries: a stored `where` is ignored on a source connection.
    const stored = sourceWriters(
      (row.writers ?? []).map(w => ({
        principal: w.principal,
        addedBy: w.addedBy,
        addedAt: w.addedAt,
      })),
    );
    const outside = await writersOutsideRefusal(workspaceId, writers, stored);
    if (outside) return fail(c, 400, outside);
    // As they were, for the record of this change.
    const before = {
      writers: stored.map(w => w.principal),
      liveReads: row.liveReads === true,
      liveReaders: row.liveReaders
        ? sourceWriters(row.liveReaders).map(w => w.principal)
        : null,
    };
    const nextWritersList = nextWriters(stored, writers, userId);
    const patch: UpdateSourceConnectionInput = {
      writers: nextWritersList,
    };
    let nextLiveReads = row.liveReads === true;
    if (liveReads !== undefined) {
      patch.liveReads = liveReads;
      nextLiveReads = liveReads;
    }
    let nextLiveReaders = row.liveReaders;
    if (liveReaders === null) {
      patch.liveReaders = null;
      nextLiveReaders = undefined;
    } else if (liveReaders !== undefined) {
      const readers = sourceWriters(liveReaders);
      const storedReaders = sourceWriters(
        (row.liveReaders ?? []).map(w => ({
          principal: w.principal,
          addedBy: w.addedBy,
          addedAt: w.addedAt,
        })),
      );
      const strangers = await writersOutsideRefusal(
        workspaceId,
        readers,
        storedReaders,
        { readers: true },
      );
      if (strangers) return fail(c, 400, strangers);
      nextLiveReaders = nextWriters(storedReaders, readers, userId);
      patch.liveReaders = nextLiveReaders;
    }
    await connectionsRepo.updateSourceConnection(id, workspaceId, patch);
    const readersNow = nextLiveReaders
      ? sourceWriters(nextLiveReaders).map(w => w.principal)
      : null;
    await recordAccessChange({
      workspaceId,
      connectionId: id,
      kind: "source",
      actor: userId,
      via: "app",
      changes: {
        writers: listChange(
          before.writers,
          nextWritersList.map(w => w.principal),
        ),
        ...(nextLiveReads !== before.liveReads
          ? { liveReads: nextLiveReads }
          : {}),
        liveReaders: {
          ...listChange(before.liveReaders ?? [], readersNow ?? []),
          // The list was dropped: everyone reads live again.
          ...(before.liveReaders !== null && readersNow === null
            ? { everyone: true }
            : {}),
          // A list where everyone read before, even an empty one.
          ...(before.liveReaders === null && readersNow !== null
            ? { limited: true }
            : {}),
        },
      },
    });
    logger.info("Source connection writers changed", {
      workspaceId,
      connectionId: id,
      userId,
      writers: nextWritersList.length,
      liveReads: nextLiveReads,
      liveReaders: nextLiveReaders ? nextLiveReaders.length : "everyone",
    });
    return c.json({ success: true });
  },
);
