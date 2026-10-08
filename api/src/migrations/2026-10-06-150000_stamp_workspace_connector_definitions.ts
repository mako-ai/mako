import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Bind every workspace-connector source connection (type ws:<slug>) to its ConnectorDefinition by id";

/**
 * A `ws:` connection used to be bound to its connector by NAME (`type`).
 * Renames and aliases move names, so a credential could end up resolving to
 * another connector's code (api/src/rename). From now on the binding is
 * `connectorDefinitionId`, set on create/update; this stamps what already
 * exists.
 *
 * Only a definition whose CURRENT slug the type names is a safe answer —
 * an alias claimant is a guess, and a guess here is someone else's code
 * decrypting the key. Connections that resolve to nothing today are left
 * unstamped: they resolve by current slug only, and fail closed until a
 * person re-points or re-saves them.
 */
export async function up(db: Db): Promise<void> {
  const connections = db.collection("connectors");
  const definitions = db.collection("connectordefinitions");
  const cursor = connections.find({
    type: { $regex: /^ws:/ },
    $or: [
      { connectorDefinitionId: { $exists: false } },
      { connectorDefinitionId: null },
    ],
  });
  let stamped = 0;
  let unresolved = 0;
  for await (const row of cursor) {
    const slug = String(row.type).slice("ws:".length);
    // An old writer may have stored the workspace id as a string; the
    // definitions carry an ObjectId. Matched in both forms — an unstamped
    // row is exactly what a newcomer at its slug must not inherit.
    const workspaceIds: unknown[] = row.workspaceId ? [row.workspaceId] : [];
    if (
      typeof row.workspaceId === "string" &&
      ObjectId.isValid(row.workspaceId)
    ) {
      workspaceIds.push(new ObjectId(row.workspaceId));
    }
    const definition =
      workspaceIds.length > 0
        ? await definitions.findOne({
            workspaceId: { $in: workspaceIds },
            slug,
          })
        : null;
    if (!definition) {
      unresolved++;
      log.warn(
        "Workspace connector connection resolves to no definition by current slug; left unstamped (fails closed)",
        {
          connectionId: String(row._id),
          workspaceId: row.workspaceId ? String(row.workspaceId) : undefined,
          type: row.type,
        },
      );
      continue;
    }
    await connections.updateOne(
      { _id: row._id },
      { $set: { connectorDefinitionId: definition._id } },
    );
    stamped++;
  }
  log.info(
    `Stamped ${stamped} workspace connector connections (${unresolved} left unresolved)`,
  );
}
