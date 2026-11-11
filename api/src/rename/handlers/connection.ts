/**
 * Connection rename handler (see ../types.ts for the contract).
 *
 * Covers both connection kinds: a SOURCE connection (Stripe, Close, a
 * workspace connector; opened at `/cx/<id>`) and a DATABASE connection (a
 * warehouse; opened through its tables at `/t/<id>/...`, so it has no page
 * of its own and `url` is omitted). Both live only in Mongo, under an id
 * that never changes, and only the display `name` is renamed.
 *
 * Flows, consoles, bindings and dbt environments reference a connection by
 * id, so they are not affected. Workflow code and `call_connection` may
 * name a SOURCE connection (`connection("ch_close")`), and a connection
 * keeps no aliases: the result warns, in the words `update_connection`
 * uses, that references by the old name stop finding it.
 *
 * Who may rename is what the kinds' own update routes take, checked here
 * against the caller's live role:
 *
 *   - source: one of the connection's managers, or the workspace owner,
 *     never a viewer (access/source-connection-access.ts, as
 *     `PUT /connections/sources/:id` and `update_connection`);
 *   - database: owners, admins and members (`PUT /databases/:id`).
 *
 * A credential with no person behind it is refused for both. The name is
 * the only field written, with one `$set`: nothing stored beside it (a key
 * included) is read or written.
 */
import { Types } from "mongoose";
import {
  changeRefusal,
  mayChangeSourceConnection,
  peopleOf,
  type WorkspaceRole,
} from "../../access/source-connection-access";
import {
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { cleanRenameTitle, looksLikeObjectId } from "../title-rules";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

/** The cap `create_connection` / `update_connection` put on a name. */
export const CONNECTION_NAME_MAX_LENGTH = 100;

interface Found {
  kind: "source" | "database";
  id: Types.ObjectId;
  name: string;
  /** Source connections only: who configures it. */
  createdBy?: unknown;
  managers?: unknown;
}

const SOURCE_FIELDS = "_id name createdBy managers";
const DATABASE_EDIT_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "member",
]);

function locationOf(found: Found, name = found.name): RenameLocation {
  return found.kind === "source"
    ? { title: name, url: `/cx/${found.id.toString()}` }
    : { title: name };
}

/**
 * The connections `ref` could mean: the one with that id (either
 * collection), else every connection with that name (at most two are
 * fetched per collection: enough to know the name is ambiguous).
 */
async function findConnections(
  ctx: RenameContext,
  ref: string,
): Promise<Found[]> {
  if (!Types.ObjectId.isValid(ctx.workspaceId)) return [];
  const workspaceId = new Types.ObjectId(ctx.workspaceId);
  // Only a 24-hex string is an id (`Types.ObjectId.isValid` accepts any 12
  // characters, so a name such as `stripe_prod1` would be read as one).
  if (looksLikeObjectId(ref)) {
    const _id = new Types.ObjectId(ref);
    const [source, database] = await Promise.all([
      SourceConnection.findOne({ _id, workspaceId })
        .select(SOURCE_FIELDS)
        .lean(),
      DatabaseConnection.findOne({ _id, workspaceId })
        .select("_id name")
        .lean(),
    ]);
    if (source) return [{ kind: "source", id: source._id, ...source }];
    if (database) {
      return [{ kind: "database", id: database._id, name: database.name }];
    }
  }
  const [sources, databases] = await Promise.all([
    SourceConnection.find({ workspaceId, name: ref })
      .select(SOURCE_FIELDS)
      .limit(2)
      .lean(),
    DatabaseConnection.find({ workspaceId, name: ref })
      .select("_id name")
      .limit(2)
      .lean(),
  ]);
  return [
    ...sources.map(row => ({ kind: "source" as const, id: row._id, ...row })),
    ...databases.map(row => ({
      kind: "database" as const,
      id: row._id,
      name: row.name,
    })),
  ];
}

async function assertMayRename(ctx: RenameContext, found: Found) {
  const { userId } = ctx;
  if (!userId) {
    throw new RenameError(
      "This credential has no acting user, so no workspace role can be resolved. Renaming a connection takes a signed-in member, or a key created by one.",
      403,
    );
  }
  const people = peopleOf(ctx.workspaceId);
  const role =
    (ctx.role as WorkspaceRole | undefined) ?? (await people.roleOf(userId));
  if (found.kind === "database") {
    if (!DATABASE_EDIT_ROLES.has(role ?? "")) {
      throw new RenameError("Insufficient permissions in workspace", 403);
    }
    return;
  }
  if (!(await mayChangeSourceConnection({ ...people, role, userId }, found))) {
    throw new RenameError(changeRefusal(role), 403);
  }
}

export const connectionRenameHandler: RenameHandler = {
  kind: "connection",
  describe:
    "`title` = new display name of a source connection or a database connection; no `slug`. The id does not change, and flows, consoles and bindings reference the id. A SOURCE connection keeps no old names: workflow code and call_connection that use the old name stop finding it (the result says so). Same permissions as update_connection.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const matches = await findConnections(ctx, ref);
    if (matches.length !== 1) return null;
    return {
      kind: "connection",
      id: matches[0].id.toString(),
      via: "current",
      current: locationOf(matches[0]),
    };
  },

  async rename(ctx, request) {
    if (request.slug !== undefined) {
      throw new RenameError("Connections have no slug; give `title`.");
    }
    const title = cleanRenameTitle(
      request.title ?? "",
      CONNECTION_NAME_MAX_LENGTH,
    );
    const matches = await findConnections(ctx, request.ref);
    if (matches.length === 0) {
      throw new RenameError("Connection not found", 404);
    }
    if (matches.length > 1) {
      throw new RenameError(
        `Several connections are named "${request.ref}". Pass the id instead; nothing was changed.`,
        409,
      );
    }
    const found = matches[0];
    await assertMayRename(ctx, found);
    const id = found.id.toString();
    const before = locationOf(found);
    const after = locationOf(found, title);
    if (title === found.name) {
      return {
        kind: "connection",
        id,
        before,
        after: before,
        aliasesAdded: [],
        warnings: ["Nothing to change: it already has that name."],
      };
    }
    const workspaceId = new Types.ObjectId(ctx.workspaceId);
    if (found.kind === "source") {
      // Names are how workflow code and call_connection find a source
      // connection, so two with one name would make both unreachable by it.
      const taken = await SourceConnection.exists({
        workspaceId,
        name: title,
        _id: { $ne: found.id },
      });
      if (taken) {
        throw new RenameError(
          `A source connection named "${title}" already exists in this workspace. Pick another name.`,
          409,
        );
      }
      await SourceConnection.updateOne(
        { _id: found.id, workspaceId },
        { $set: { name: title } },
      );
    } else {
      await DatabaseConnection.updateOne(
        { _id: found.id, workspaceId },
        { $set: { name: title } },
      );
    }
    return {
      kind: "connection",
      id,
      before,
      after,
      aliasesAdded: [],
      warnings:
        found.kind === "source"
          ? [
              `Anything that refers to this connection by the name "${found.name}" no longer finds it: workflow code calling connection("${found.name}"), call_connection, scripts. Switch those references to the id "${id}" or the new name. Flows reference the id and are not affected.`,
            ]
          : [],
    };
  },
};
