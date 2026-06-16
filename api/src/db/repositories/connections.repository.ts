import { eq } from "drizzle-orm";

import { getDb } from "../client";
import { decryptObject, encryptObject } from "../crypto";
import {
  DatabaseConnectionRow,
  NewDatabaseConnectionRow,
  databaseConnections,
} from "../schema";

/**
 * Typed CRUD for `database_connections` (the user-configured DB credentials).
 *
 * Credentials in `connection` are encrypted at rest (AES-256-CBC) — the same
 * scheme the legacy Mongoose getters/setters used. Callers always pass and
 * receive *plaintext* connection objects; encryption is transparent here.
 */
function decryptRow(row: DatabaseConnectionRow): DatabaseConnectionRow {
  return {
    ...row,
    connection: decryptObject(row.connection) as Record<string, unknown>,
  };
}

export const connectionsRepository = {
  async findById(id: string): Promise<DatabaseConnectionRow | null> {
    const rows = await getDb()
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, id));
    return rows[0] ? decryptRow(rows[0]) : null;
  },

  async listForWorkspace(
    workspaceId: string,
  ): Promise<DatabaseConnectionRow[]> {
    const rows = await getDb()
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.workspaceId, workspaceId));
    return rows.map(decryptRow);
  },

  async create(
    input: NewDatabaseConnectionRow,
  ): Promise<DatabaseConnectionRow> {
    const [row] = await getDb()
      .insert(databaseConnections)
      .values({
        ...input,
        connection: encryptObject(input.connection) as Record<string, unknown>,
      })
      .returning();
    return decryptRow(row);
  },

  /** Insert/update preserving id and re-encrypting credentials (backfill). */
  async upsert(
    input: NewDatabaseConnectionRow,
  ): Promise<DatabaseConnectionRow> {
    const encrypted = encryptObject(input.connection) as Record<
      string,
      unknown
    >;
    const [row] = await getDb()
      .insert(databaseConnections)
      .values({ ...input, connection: encrypted })
      .onConflictDoUpdate({
        target: databaseConnections.id,
        set: {
          name: input.name,
          type: input.type,
          connection: encrypted,
          isDemo: input.isDemo ?? false,
          lastConnectedAt: input.lastConnectedAt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return decryptRow(row);
  },

  async update(
    id: string,
    patch: Partial<NewDatabaseConnectionRow>,
  ): Promise<DatabaseConnectionRow | null> {
    const set: Partial<NewDatabaseConnectionRow> = {
      ...patch,
      updatedAt: new Date(),
    };
    if (patch.connection) {
      set.connection = encryptObject(patch.connection) as Record<
        string,
        unknown
      >;
    }
    const [row] = await getDb()
      .update(databaseConnections)
      .set(set)
      .where(eq(databaseConnections.id, id))
      .returning();
    return row ? decryptRow(row) : null;
  },

  async delete(id: string): Promise<void> {
    await getDb()
      .delete(databaseConnections)
      .where(eq(databaseConnections.id, id));
  },
};
