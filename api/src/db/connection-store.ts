import {
  DatabaseConnection,
  IDatabaseConnection,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { isObjectIdDerivedUuid, toPgId, uuidToObjectId } from "./ids";
import { connectionsRepository } from "./repositories";
import type { DatabaseConnectionRow } from "./schema";

const log = loggers.db();

/**
 * Read seam for the connections domain (`DatabaseConnection`).
 *
 * Lets app read paths resolve a connection's metadata from either Mongo
 * (default) or Postgres (`CONNECTIONS_PERSISTENCE=postgres`) without changing
 * their consumers. The Postgres path returns a plain object shaped like the
 * Mongoose document — crucially with `_id`/`workspaceId` as Mongo **hex**
 * strings (reversed from the uuid) so existing code (`database._id.toString()`,
 * pool keys, `executeQuery`) and the query drivers behave identically.
 *
 * Credentials come back decrypted (the repository handles AES-256-CBC),
 * matching the Mongoose getter behaviour.
 *
 * CDC/sync read paths are intentionally NOT routed here yet (migrated last).
 */
function uuidToHex(value: string): string {
  return isObjectIdDerivedUuid(value) ? uuidToObjectId(value) : value;
}

function rowToDoc(row: DatabaseConnectionRow): IDatabaseConnection {
  // Shaped to satisfy the consumed surface of IDatabaseConnection. `_id` is a
  // hex string whose `.toString()` returns itself (drivers/pool keys rely on it).
  return {
    _id: uuidToHex(row.id),
    workspaceId: uuidToHex(row.workspaceId),
    name: row.name,
    type: row.type,
    connection: row.connection,
    isDemo: row.isDemo,
    createdBy: row.createdBy ? uuidToHex(row.createdBy) : row.createdBy,
    lastConnectedAt: row.lastConnectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as unknown as IDatabaseConnection;
}

export interface ConnectionStore {
  readonly backend: "mongo" | "postgres";
  /** Resolve a connection by id, scoped to a workspace (access control). */
  findInWorkspace(
    id: string,
    workspaceId: string,
  ): Promise<IDatabaseConnection | null>;
  listForWorkspace(workspaceId: string): Promise<IDatabaseConnection[]>;
}

class MongoConnectionStore implements ConnectionStore {
  readonly backend = "mongo" as const;

  async findInWorkspace(
    id: string,
    workspaceId: string,
  ): Promise<IDatabaseConnection | null> {
    // Mongoose casts the hex strings; getters decrypt `connection` on access.
    return DatabaseConnection.findOne({ _id: id, workspaceId });
  }

  async listForWorkspace(workspaceId: string): Promise<IDatabaseConnection[]> {
    return DatabaseConnection.find({ workspaceId });
  }
}

class PostgresConnectionStore implements ConnectionStore {
  readonly backend = "postgres" as const;

  async findInWorkspace(
    id: string,
    workspaceId: string,
  ): Promise<IDatabaseConnection | null> {
    const row = await connectionsRepository.findById(toPgId(id));
    if (!row || row.workspaceId !== toPgId(workspaceId)) {
      return null;
    }
    return rowToDoc(row);
  }

  async listForWorkspace(workspaceId: string): Promise<IDatabaseConnection[]> {
    const rows = await connectionsRepository.listForWorkspace(
      toPgId(workspaceId),
    );
    return rows.map(rowToDoc);
  }
}

let store: ConnectionStore | null = null;

export function getConnectionStore(): ConnectionStore {
  if (!store) {
    if (process.env.CONNECTIONS_PERSISTENCE === "postgres") {
      store = new PostgresConnectionStore();
      log.info("Connections read backend: postgres");
    } else {
      store = new MongoConnectionStore();
    }
  }
  return store;
}

export function setConnectionStore(next: ConnectionStore | null): void {
  store = next;
}
