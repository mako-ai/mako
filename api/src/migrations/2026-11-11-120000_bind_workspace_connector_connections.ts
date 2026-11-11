import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Bind every workspace-connector source connection (type ws:<slug>) to its ConnectorDefinition by id";

/**
 * A `ws:` connection used to be tied to its connector by NAME (`type`).
 * Names move (renames, aliases, a folder deleted and another pushed at its
 * slug), so from now on a connection resolves through
 * `connectorDefinitionId`, set when it is created or re-pointed
 * (connectors/workspace/resolver.ts). This stamps what already exists.
 *
 * Only the definition whose CURRENT slug the type names is an answer: a
 * definition that merely lists the slug as an old name is a guess. A
 * connection that resolves to nothing today is left unstamped: it keeps
 * resolving by its current slug only, and stays closed until a connector
 * exists at that slug or a person re-saves it.
 *
 * Idempotent (only unstamped rows are read), and safe before or after the
 * new code is live: an unstamped connection behaves as it did, by slug.
 */
export async function up(db: Db): Promise<void> {
  const connections = db.collection("connectors");
  const definitions = db.collection("connectordefinitions");
  let stamped = 0;
  let unresolved = 0;
  const cursor = connections.find(
    { type: { $regex: /^ws:/ }, connectorDefinitionId: null },
    { projection: { _id: 1, type: 1, workspaceId: 1 } },
  );
  for await (const row of cursor) {
    // An old writer may have stored the workspace id as a string; the
    // definitions carry an ObjectId. Matched in both forms.
    const workspaceIds: unknown[] = row.workspaceId ? [row.workspaceId] : [];
    if (
      typeof row.workspaceId === "string" &&
      ObjectId.isValid(row.workspaceId)
    ) {
      workspaceIds.push(new ObjectId(row.workspaceId));
    }
    const definition =
      workspaceIds.length > 0
        ? await definitions.findOne(
            {
              workspaceId: { $in: workspaceIds },
              slug: String(row.type).slice("ws:".length),
              removedAt: null,
            },
            { projection: { _id: 1 } },
          )
        : null;
    if (!definition) {
      unresolved++;
      log.warn(
        "A workspace connector connection names no connector; left unbound (stays closed)",
        {
          connectionId: String(row._id),
          workspaceId: row.workspaceId ? String(row.workspaceId) : undefined,
          type: row.type,
        },
      );
      continue;
    }
    await connections.updateOne(
      { _id: row._id, connectorDefinitionId: null },
      { $set: { connectorDefinitionId: definition._id } },
    );
    stamped++;
  }
  log.info("Bound workspace connector connections to their definitions", {
    stamped,
    unresolved,
  });
}
