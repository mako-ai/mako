/**
 * Connection rename handler (see ../types.ts for the contract).
 *
 * Covers both connection kinds — a SOURCE connection (Stripe, Close, a
 * workspace connector; opened at `/cx/<id>`) and a DATABASE connection (a
 * warehouse; opened through its tables at `/t/<id>/…`, so it has no page of
 * its own and `url` is omitted). Both live only in Mongo and are referenced
 * everywhere by id (flow files, console front matter, bindings, dbt
 * environments), so the display `name` renames cleanly with no alias.
 *
 * Permissions mirror the kinds' update routes: a source connection is
 * editable by any workspace member (`PUT /source-connections/:id`); a
 * database connection by owners, admins and members, never viewers
 * (`PUT /databases/:id` → requireWorkspaceRole). A workspace API key (no
 * user) passes both, as it does on those routes.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SourceConnection,
  type IDatabaseConnection,
  type ISourceConnection,
} from "../../database/workspace-schema";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";
import { publishRealtimeEvent } from "../../services/realtime.service";

type Found =
  | { kind: "source"; doc: ISourceConnection }
  | { kind: "database"; doc: IDatabaseConnection };

const DATABASE_EDIT_ROLES = new Set(["owner", "admin", "member"]);

function locationOf(found: Found): RenameLocation {
  return found.kind === "source"
    ? { title: found.doc.name, url: `/cx/${found.doc._id.toString()}` }
    : { title: found.doc.name };
}

/** By id (either collection), or by a name exactly ONE connection has. */
async function findConnection(
  ctx: RenameContext,
  ref: string,
): Promise<Found | null> {
  if (!Types.ObjectId.isValid(ctx.workspaceId)) return null;
  const ws = new Types.ObjectId(ctx.workspaceId);
  if (Types.ObjectId.isValid(ref)) {
    const id = new Types.ObjectId(ref);
    const source = await SourceConnection.findOne({ _id: id, workspaceId: ws });
    if (source) return { kind: "source", doc: source };
    const database = await DatabaseConnection.findOne({
      _id: id,
      workspaceId: ws,
    });
    return database ? { kind: "database", doc: database } : null;
  }
  const name = ref.trim();
  const [sources, databases] = await Promise.all([
    SourceConnection.find({ workspaceId: ws, name }),
    DatabaseConnection.find({ workspaceId: ws, name }),
  ]);
  const all: Found[] = [
    ...sources.map(doc => ({ kind: "source" as const, doc })),
    ...databases.map(doc => ({ kind: "database" as const, doc })),
  ];
  return all.length === 1 ? all[0] : null;
}

function assertCanRename(found: Found, ctx: RenameContext): void {
  if (!ctx.userId) return; // workspace API key: the update routes allow it
  if (found.kind === "database" && !DATABASE_EDIT_ROLES.has(ctx.role ?? "")) {
    throw new RenameError("Insufficient permissions in workspace", 403);
  }
}

export const connectionRenameHandler: RenameHandler = {
  kind: "connection",
  describe:
    "connection: `title` = new display name of a source connection (`/cx/<id>`) or a database connection; no `slug`. Everything references connections by id, so nothing breaks.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const found = await findConnection(ctx, ref);
    if (!found) return null;
    return {
      kind: "connection",
      id: found.doc._id.toString(),
      via: "current",
      current: locationOf(found),
    };
  },

  async rename(ctx, request) {
    if (request.slug !== undefined) {
      throw new RenameError("Connections have no slug; give `title`.");
    }
    const title = request.title?.trim();
    if (!title) throw new RenameError("Give a new name.");
    const found = await findConnection(ctx, request.ref);
    if (!found) throw new RenameError("Connection not found", 404);
    assertCanRename(found, ctx);
    const before = locationOf(found);
    found.doc.name = title;
    if (found.kind === "database") found.doc.updatedAt = new Date();
    await found.doc.save();
    // Browsers keep the connection list across reloads: tell them.
    publishRealtimeEvent(ctx.workspaceId, {
      type: "connection.updated",
      connectionId: found.doc._id.toString(),
      connectionKind: found.kind,
    });
    return {
      kind: "connection",
      id: found.doc._id.toString(),
      before,
      after: locationOf(found),
      aliasesAdded: [],
      warnings: [],
    };
  },
};
