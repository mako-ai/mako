/**
 * Postgres (Neon / Drizzle) implementation of `ConnectionsRepository`.
 *
 * Key invariants:
 *   - All ObjectId PKs/FKs use bijective RFC 9562 UUIDv8 (`entityIdToPgUuid` / `toWireId`).
 *   - All user FKs resolve legacy Lucia/UUIDv4 IDs -> PG `users.id` UUIDv7 against the
 *     active `db` instance (never calling global `getPgDb()` when an injected `db` is used).
 *   - `database_connections.connection_encrypted` holds explicitly encrypted leaf ciphertext.
 *   - `source_connections.live_readers` preserves SQL `NULL` (everyone reads live) vs `[]`
 *     (writers only); atomic `keyRequest` claim & CAS rollback run in single SQL `UPDATE`s.
 *   - `listRecentWriters` & `listWorkspaceIdsWithDueRetries` execute native SQL queries.
 */
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  newDualId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  connectionAccessEvents,
  connectionWriteEvents,
  connectorDefinitions,
  databaseConnections,
  sourceConnections,
  type NewConnectionAccessEventRow,
  type NewConnectionWriteEventRow,
  type NewConnectorDefinitionRow,
  type NewDatabaseConnectionRow,
  type NewSourceConnectionRow,
} from "../../database/pg/schema/connections";
import { encryptConnectionObject } from "./crypto";
import {
  accessEventToPgInsert,
  buildToPgJson,
  coerceDate,
  databaseConnectionToPgInsert,
  entityIdToPgUuid,
  managersToPgUuids,
  normalizeSourceSettings,
  normalizeWriters,
  pgAccessEventToRecord,
  pgConnectorDefinitionToRecord,
  pgDatabaseConnectionToRecord,
  pgDatabaseConnectionToSummary,
  pgSourceConnectionToRecord,
  pgWriteEventToRecord,
  registryToPgJson,
  rewritePrincipalForPg,
  sourceConnectionToPgInsert,
  stripUndefinedDeep,
  writersToPgJson,
  type UserUuidResolver,
} from "./mapper";
import {
  isDatabaseConnectionType,
  type ClaimSourceConnectionKeyRequestInput,
  type ConnectionAccessEventRecord,
  type ConnectionWriteEventRecord,
  type ConnectionsRepository,
  type ConnectorDefinitionBuildRecord,
  type ConnectorDefinitionRecord,
  type CreateDatabaseConnectionInput,
  type CreateSourceConnectionInput,
  type DatabaseConnectionRecord,
  type DatabaseConnectionSummary,
  type FindSourceConnectionByIdOrNameResult,
  type RecentWriterAggregate,
  type RecordConnectionAccessEventInput,
  type RecordConnectionWriteEventInput,
  type RollbackSourceConnectionKeyRequestInput,
  type SourceConnectionRecord,
  type UpdateConnectorDefinitionMetadataInput,
  type UpdateDatabaseConnectionInput,
  type UpdateSourceConnectionInput,
  type UpsertConnectorDefinitionInput,
} from "./types";

function tryEntityIdToPgUuid(id: string): string | null {
  try {
    return parseEntityId(id)?.uuid ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a legacy or UUID user ID against Postgres `users` on the given `db`.
 * Returns `null` when the user does not exist in PG (safe for `ON DELETE SET NULL` FKs).
 */
export async function resolvePgUserUuidOnDb(
  db: MakoPgDb,
  idOrLegacyId: string,
): Promise<string | null> {
  if (!idOrLegacyId) return null;
  const whereClause = isUuidString(idOrLegacyId)
    ? or(
        eq(users.id, idOrLegacyId.toLowerCase()),
        eq(users.legacyId, idOrLegacyId),
      )
    : eq(users.legacyId, idOrLegacyId);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(whereClause)
    .limit(1);
  return rows[0] ? rows[0].id.toLowerCase() : null;
}

function sqlTextArray(values: readonly string[]) {
  if (values.length === 0) {
    return sql`'{}'::text[]`;
  }
  return sql`ARRAY[${sql.join(
    values.map(v => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

function sqlUuidArray(values: readonly string[]) {
  if (values.length === 0) {
    return sql`'{}'::uuid[]`;
  }
  return sql`ARRAY[${sql.join(
    values.map(v => sql`${v}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

export class PgConnectionsRepository implements ConnectionsRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  private makeUserResolver(db: MakoPgDb): UserUuidResolver {
    const memo = new Map<string, string | null>();
    return async (idOrLegacyId: string): Promise<string | null> => {
      if (!idOrLegacyId) return null;
      if (memo.has(idOrLegacyId)) return memo.get(idOrLegacyId) ?? null;
      const resolved = await resolvePgUserUuidOnDb(db, idOrLegacyId);
      memo.set(idOrLegacyId, resolved);
      return resolved;
    };
  }

  // ── Database connections ────────────────────────────────────────────────

  async listDatabaseConnections(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.workspaceId, wsUuid))
      .orderBy(desc(databaseConnections.createdAt));
    return rows.map(pgDatabaseConnectionToRecord);
  }

  async listDatabaseConnectionMetadata(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionSummary[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const rows = await db
      .select({
        id: databaseConnections.id,
        workspaceId: databaseConnections.workspaceId,
        name: databaseConnections.name,
        type: databaseConnections.type,
        isDemo: databaseConnections.isDemo,
        allowAgentWrites: databaseConnections.allowAgentWrites,
        writers: databaseConnections.writers,
        createdBy: databaseConnections.createdBy,
        lastConnectedAt: databaseConnections.lastConnectedAt,
        createdAt: databaseConnections.createdAt,
        updatedAt: databaseConnections.updatedAt,
      })
      .from(databaseConnections)
      .where(eq(databaseConnections.workspaceId, wsUuid))
      .orderBy(desc(databaseConnections.createdAt));
    return rows.map(row =>
      pgDatabaseConnectionToSummary({
        ...row,
        connectionEncrypted: {},
      }),
    );
  }

  async listAllDatabaseConnectionMetadata(
    limit?: number,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionSummary[]> {
    const base = db
      .select({
        id: databaseConnections.id,
        workspaceId: databaseConnections.workspaceId,
        name: databaseConnections.name,
        type: databaseConnections.type,
        isDemo: databaseConnections.isDemo,
        allowAgentWrites: databaseConnections.allowAgentWrites,
        writers: databaseConnections.writers,
        createdBy: databaseConnections.createdBy,
        lastConnectedAt: databaseConnections.lastConnectedAt,
        createdAt: databaseConnections.createdAt,
        updatedAt: databaseConnections.updatedAt,
      })
      .from(databaseConnections)
      .orderBy(desc(databaseConnections.createdAt));
    const rows =
      limit !== undefined && limit > 0 ? await base.limit(limit) : await base;
    return rows.map(row =>
      pgDatabaseConnectionToSummary({
        ...row,
        connectionEncrypted: {},
      }),
    );
  }

  async findDatabaseConnectionById(
    id: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const predicates = [eq(databaseConnections.id, pgId)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return null;
      predicates.push(eq(databaseConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(and(...predicates))
      .limit(1);
    return rows[0] ? pgDatabaseConnectionToRecord(rows[0]) : null;
  }

  async findDatabaseConnectionRawById(
    id: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{
    record: DatabaseConnectionRecord;
    connectionEncrypted: Record<string, unknown>;
  } | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const predicates = [eq(databaseConnections.id, pgId)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return null;
      predicates.push(eq(databaseConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(and(...predicates))
      .limit(1);
    if (!rows[0]) return null;
    return {
      record: pgDatabaseConnectionToRecord(rows[0]),
      connectionEncrypted: rows[0].connectionEncrypted ?? {},
    };
  }

  async findDatabaseConnectionSummary(
    id: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionSummary | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const predicates = [eq(databaseConnections.id, pgId)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return null;
      predicates.push(eq(databaseConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select({
        id: databaseConnections.id,
        workspaceId: databaseConnections.workspaceId,
        name: databaseConnections.name,
        type: databaseConnections.type,
        isDemo: databaseConnections.isDemo,
        allowAgentWrites: databaseConnections.allowAgentWrites,
        writers: databaseConnections.writers,
        createdBy: databaseConnections.createdBy,
        lastConnectedAt: databaseConnections.lastConnectedAt,
        createdAt: databaseConnections.createdAt,
        updatedAt: databaseConnections.updatedAt,
      })
      .from(databaseConnections)
      .where(and(...predicates))
      .limit(1);
    return rows[0]
      ? pgDatabaseConnectionToSummary({
          ...rows[0],
          connectionEncrypted: {},
        })
      : null;
  }

  async findDatabaseConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord[]> {
    const uuids = [
      ...new Set(
        ids.map(tryEntityIdToPgUuid).filter((v): v is string => v !== null),
      ),
    ];
    if (uuids.length === 0) return [];
    const predicates = [inArray(databaseConnections.id, uuids)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return [];
      predicates.push(eq(databaseConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(and(...predicates));
    return rows.map(pgDatabaseConnectionToRecord);
  }

  async findDatabaseConnectionSummariesByIds(
    ids: readonly string[],
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionSummary[]> {
    const uuids = [
      ...new Set(
        ids.map(tryEntityIdToPgUuid).filter((v): v is string => v !== null),
      ),
    ];
    if (uuids.length === 0) return [];
    const predicates = [inArray(databaseConnections.id, uuids)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return [];
      predicates.push(eq(databaseConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select({
        id: databaseConnections.id,
        workspaceId: databaseConnections.workspaceId,
        name: databaseConnections.name,
        type: databaseConnections.type,
        isDemo: databaseConnections.isDemo,
        allowAgentWrites: databaseConnections.allowAgentWrites,
        writers: databaseConnections.writers,
        createdBy: databaseConnections.createdBy,
        lastConnectedAt: databaseConnections.lastConnectedAt,
        createdAt: databaseConnections.createdAt,
        updatedAt: databaseConnections.updatedAt,
      })
      .from(databaseConnections)
      .where(and(...predicates));
    return rows.map(row =>
      pgDatabaseConnectionToSummary({
        ...row,
        connectionEncrypted: {},
      }),
    );
  }

  async findDatabaseConnectionByName(
    workspaceId: string,
    name: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord | null> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(
        and(
          eq(databaseConnections.workspaceId, wsUuid),
          eq(databaseConnections.name, name.trim()),
        ),
      )
      .limit(1);
    return rows[0] ? pgDatabaseConnectionToRecord(rows[0]) : null;
  }

  async findDemoDatabaseConnection(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord | null> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(
        and(
          eq(databaseConnections.workspaceId, wsUuid),
          eq(databaseConnections.isDemo, true),
        ),
      )
      .limit(1);
    return rows[0] ? pgDatabaseConnectionToRecord(rows[0]) : null;
  }

  async countDatabaseConnections(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<number> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return 0;
    const res = await db.execute(sql`
      SELECT count(*)::int AS cnt
      FROM "database_connections"
      WHERE "workspace_id" = ${wsUuid}::uuid
    `);
    const rows = extractRows<{ cnt: number | string }>(res);
    return Number(rows[0]?.cnt ?? 0);
  }

  async createDatabaseConnection(
    input: CreateDatabaseConnectionInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord> {
    if (!isDatabaseConnectionType(input.type)) {
      throw new Error(
        `Invalid database connection type: ${String(input.type)}`,
      );
    }
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const wireId = input.id ?? newDualId(now.getTime()).oid;
    const encrypted =
      input.connectionEncrypted !== undefined
        ? stripUndefinedDeep(input.connectionEncrypted)
        : encryptConnectionObject(input.connection ?? {});

    const insertRow = await databaseConnectionToPgInsert(
      {
        id: wireId,
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        type: input.type,
        connectionEncrypted: encrypted,
        isDemo: input.isDemo ?? false,
        allowAgentWrites: input.allowAgentWrites ?? false,
        writers: normalizeWriters(input.writers),
        createdBy: input.createdBy,
        lastConnectedAt: input.lastConnectedAt,
        createdAt: now,
        updatedAt,
      },
      this.makeUserResolver(db),
    );

    const rows = await db
      .insert(databaseConnections)
      .values(insertRow)
      .returning();
    return pgDatabaseConnectionToRecord(rows[0]);
  }

  async updateDatabaseConnection(
    id: string,
    workspaceId: string,
    patch: UpdateDatabaseConnectionInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<DatabaseConnectionRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return null;

    const values: Partial<typeof databaseConnections.$inferInsert> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.connectionEncrypted !== undefined) {
      values.connectionEncrypted = stripUndefinedDeep(
        patch.connectionEncrypted,
      );
    } else if (patch.connection !== undefined) {
      values.connectionEncrypted = encryptConnectionObject(patch.connection);
    }
    if (patch.isDemo !== undefined) values.isDemo = patch.isDemo;
    if (patch.allowAgentWrites !== undefined) {
      values.allowAgentWrites = patch.allowAgentWrites;
    }
    if (patch.writers === null) {
      values.writers = null;
    } else if (patch.writers !== undefined) {
      values.writers = await writersToPgJson(
        normalizeWriters(patch.writers) ?? [],
        this.makeUserResolver(db),
      );
    }
    if (patch.lastConnectedAt === null) {
      values.lastConnectedAt = null;
    } else if (patch.lastConnectedAt !== undefined) {
      values.lastConnectedAt = patch.lastConnectedAt;
    }

    const rows = await db
      .update(databaseConnections)
      .set(values)
      .where(
        and(
          eq(databaseConnections.id, pgId),
          eq(databaseConnections.workspaceId, wsUuid),
        ),
      )
      .returning();
    return rows[0] ? pgDatabaseConnectionToRecord(rows[0]) : null;
  }

  async touchDatabaseConnectionLastConnected(
    id: string,
    workspaceId: string,
    at: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return;
    await db
      .update(databaseConnections)
      .set({ lastConnectedAt: at, updatedAt: at })
      .where(
        and(
          eq(databaseConnections.id, pgId),
          eq(databaseConnections.workspaceId, wsUuid),
        ),
      );
  }

  async deleteDatabaseConnection(
    id: string,
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return false;
    const rows = await db
      .delete(databaseConnections)
      .where(
        and(
          eq(databaseConnections.id, pgId),
          eq(databaseConnections.workspaceId, wsUuid),
        ),
      )
      .returning({ id: databaseConnections.id });
    return rows.length > 0;
  }

  async upsertDatabaseConnectionWithGuard(
    row: NewDatabaseConnectionRow,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const res = await db.execute(sql`
      INSERT INTO "database_connections" (
        "id",
        "workspace_id",
        "name",
        "type",
        "connection_encrypted",
        "is_demo",
        "allow_agent_writes",
        "writers",
        "created_by",
        "last_connected_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${row.id}::uuid,
        ${row.workspaceId}::uuid,
        ${row.name},
        ${row.type},
        ${JSON.stringify(row.connectionEncrypted ?? {})}::jsonb,
        ${row.isDemo ?? false},
        ${row.allowAgentWrites ?? false},
        ${row.writers === null || row.writers === undefined ? null : JSON.stringify(row.writers)}::jsonb,
        ${row.createdBy ?? null}::uuid,
        ${row.lastConnectedAt ? row.lastConnectedAt.toISOString() : null}::timestamptz,
        ${(row.createdAt ?? new Date()).toISOString()}::timestamptz,
        ${(row.updatedAt ?? new Date()).toISOString()}::timestamptz
      )
      ON CONFLICT ("id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "type" = EXCLUDED."type",
        "connection_encrypted" = EXCLUDED."connection_encrypted",
        "is_demo" = EXCLUDED."is_demo",
        "allow_agent_writes" = EXCLUDED."allow_agent_writes",
        "writers" = EXCLUDED."writers",
        "created_by" = EXCLUDED."created_by",
        "last_connected_at" = EXCLUDED."last_connected_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE "database_connections"."updated_at" IS NULL
         OR EXCLUDED."updated_at" >= "database_connections"."updated_at"
      RETURNING "id"
    `);
    return extractRows(res).length > 0;
  }

  // ── Source connections ──────────────────────────────────────────────────

  async listSourceConnections(
    workspaceId: string,
    filter: { type?: string; isActive?: boolean } = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const predicates = [eq(sourceConnections.workspaceId, wsUuid)];
    if (filter.type !== undefined) {
      predicates.push(eq(sourceConnections.type, filter.type));
    }
    if (filter.isActive !== undefined) {
      predicates.push(eq(sourceConnections.isActive, filter.isActive));
    }
    const rows = await db
      .select()
      .from(sourceConnections)
      .where(and(...predicates))
      .orderBy(desc(sourceConnections.createdAt));
    return rows.map(pgSourceConnectionToRecord);
  }

  async listActiveSourceConnections(
    filter: { workspaceId?: string; type?: string } = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord[]> {
    const predicates = [eq(sourceConnections.isActive, true)];
    if (filter.workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(filter.workspaceId);
      if (!wsUuid) return [];
      predicates.push(eq(sourceConnections.workspaceId, wsUuid));
    }
    if (filter.type !== undefined) {
      predicates.push(eq(sourceConnections.type, filter.type));
    }
    const rows = await db
      .select()
      .from(sourceConnections)
      .where(and(...predicates));
    return rows.map(pgSourceConnectionToRecord);
  }

  async listSourceConnectionIdNames(
    filter: { isActive?: boolean } = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ id: string; name: string }>> {
    const baseQuery = db
      .select({ id: sourceConnections.id, name: sourceConnections.name })
      .from(sourceConnections);
    const rows =
      filter.isActive !== undefined
        ? await baseQuery.where(eq(sourceConnections.isActive, filter.isActive))
        : await baseQuery;
    return rows.map(r => ({ id: toWireId(r.id), name: r.name }));
  }

  async listSourceConnectionIdNameWorkspaces(
    filter: { isActive?: boolean } = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ id: string; name: string; workspaceId: string }>> {
    const baseQuery = db
      .select({
        id: sourceConnections.id,
        name: sourceConnections.name,
        workspaceId: sourceConnections.workspaceId,
      })
      .from(sourceConnections);
    const rows =
      filter.isActive !== undefined
        ? await baseQuery.where(eq(sourceConnections.isActive, filter.isActive))
        : await baseQuery;
    return rows.map(r => ({
      id: toWireId(r.id),
      name: r.name,
      workspaceId: toWireId(r.workspaceId),
    }));
  }

  async findSourceConnectionById(
    id: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const predicates = [eq(sourceConnections.id, pgId)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return null;
      predicates.push(eq(sourceConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(sourceConnections)
      .where(and(...predicates))
      .limit(1);
    return rows[0] ? pgSourceConnectionToRecord(rows[0]) : null;
  }

  async findSourceConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord[]> {
    const uuids = [
      ...new Set(
        ids.map(tryEntityIdToPgUuid).filter((v): v is string => v !== null),
      ),
    ];
    if (uuids.length === 0) return [];
    const predicates = [inArray(sourceConnections.id, uuids)];
    if (workspaceId !== undefined) {
      const wsUuid = tryEntityIdToPgUuid(workspaceId);
      if (!wsUuid) return [];
      predicates.push(eq(sourceConnections.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(sourceConnections)
      .where(and(...predicates));
    return rows.map(pgSourceConnectionToRecord);
  }

  async findSourceConnectionByIdOrName(
    workspaceId: string,
    idOrName: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<FindSourceConnectionByIdOrNameResult> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return { connection: null };
    if (isObjectIdHex(idOrName) || isUuidString(idOrName)) {
      const pgId = tryEntityIdToPgUuid(idOrName);
      if (pgId) {
        const byId = await db
          .select()
          .from(sourceConnections)
          .where(
            and(
              eq(sourceConnections.id, pgId),
              eq(sourceConnections.workspaceId, wsUuid),
            ),
          )
          .limit(1);
        if (byId[0]) {
          return { connection: pgSourceConnectionToRecord(byId[0]) };
        }
      }
    }
    const byName = await db
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.workspaceId, wsUuid),
          eq(sourceConnections.name, idOrName),
        ),
      )
      .limit(2);
    if (byName.length > 1) {
      return { connection: null, ambiguous: true };
    }
    return {
      connection: byName[0] ? pgSourceConnectionToRecord(byName[0]) : null,
    };
  }

  async findSourceConnectionByKeyTokenHash(
    workspaceId: string,
    tokenHash: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord | null> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid || !tokenHash) return null;
    const rows = await db
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.workspaceId, wsUuid),
          eq(sourceConnections.keyRequestTokenHash, tokenHash),
        ),
      )
      .limit(1);
    return rows[0] ? pgSourceConnectionToRecord(rows[0]) : null;
  }

  async createSourceConnection(
    input: CreateSourceConnectionInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord> {
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const wireId = input.id ?? newDualId(now.getTime()).oid;
    const record: SourceConnectionRecord = {
      id: wireId,
      _id: wireId,
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      type: input.type,
      description: input.description?.trim(),
      config: stripUndefinedDeep(input.config ?? {}),
      settings: normalizeSourceSettings(input.settings),
      targetDatabases: [...(input.targetDatabases ?? [])],
      writers: normalizeWriters(input.writers),
      liveReads: input.liveReads === true,
      liveReaders: normalizeWriters(input.liveReaders),
      managers: input.managers ? [...input.managers] : undefined,
      createdBy: input.createdBy,
      lastSyncedAt: input.lastSyncedAt,
      isActive: input.isActive !== false,
      keyRequest: input.keyRequest ? { ...input.keyRequest } : undefined,
      createdAt: now,
      updatedAt,
    };

    const insertRow = await sourceConnectionToPgInsert(
      record,
      this.makeUserResolver(db),
    );
    const rows = await db
      .insert(sourceConnections)
      .values(insertRow)
      .returning();
    return pgSourceConnectionToRecord(rows[0]);
  }

  async updateSourceConnection(
    id: string,
    workspaceId: string,
    patch: UpdateSourceConnectionInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<SourceConnectionRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return null;

    const resolver = this.makeUserResolver(db);
    const values: PgUpdateSetSource<typeof sourceConnections> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };

    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.description === null) values.description = null;
    else if (patch.description !== undefined) {
      values.description = patch.description.trim();
    }
    if (patch.type !== undefined) values.type = patch.type;
    if (patch.config !== undefined && patch.configPatch !== undefined) {
      throw new Error(
        "updateSourceConnection cannot specify both config and configPatch",
      );
    }
    if (patch.config !== undefined) {
      values.configEncrypted = stripUndefinedDeep(patch.config);
    } else if (patch.configPatch !== undefined) {
      const cleanedPatch = stripUndefinedDeep(patch.configPatch);
      for (const key of Object.keys(cleanedPatch)) {
        if (!key || key.includes(".") || key.startsWith("$")) {
          throw new Error(`Invalid source connection config key: ${key}`);
        }
      }
      if (Object.keys(cleanedPatch).length > 0) {
        values.configEncrypted = sql`COALESCE(${sourceConnections.configEncrypted}, '{}'::jsonb) || ${JSON.stringify(cleanedPatch)}::jsonb`;
      }
    }
    if (patch.settings !== undefined) {
      values.settings = normalizeSourceSettings(patch.settings);
    }
    if (patch.targetDatabases !== undefined) {
      values.targetDatabaseIds = patch.targetDatabases
        .map(tryEntityIdToPgUuid)
        .filter((v): v is string => v !== null);
    }
    if (patch.writers === null) {
      values.writers = null;
    } else if (patch.writers !== undefined) {
      values.writers = await writersToPgJson(
        normalizeWriters(patch.writers) ?? [],
        resolver,
      );
    }
    if (patch.liveReads !== undefined) values.liveReads = patch.liveReads;
    // CRITICAL: null = everyone reads live; [] = writers only
    if (patch.liveReaders === null) {
      values.liveReaders = null;
    } else if (patch.liveReaders !== undefined) {
      values.liveReaders = await writersToPgJson(
        normalizeWriters(patch.liveReaders) ?? [],
        resolver,
      );
    }
    if (patch.managers === null) {
      values.managers = null;
    } else if (patch.managers !== undefined) {
      values.managers = await managersToPgUuids(patch.managers, resolver);
    }
    if (patch.lastSyncedAt === null) {
      values.lastSyncedAt = null;
    } else if (patch.lastSyncedAt !== undefined) {
      values.lastSyncedAt = patch.lastSyncedAt;
    }
    if (patch.isActive !== undefined) values.isActive = patch.isActive;
    if (patch.keyRequest === null) {
      values.keyRequestTokenHash = null;
      values.keyRequestExpiresAt = null;
      values.keyRequestFields = null;
      values.keyRequestRequestedBy = null;
      values.keyRequestCreatedAt = null;
    } else if (patch.keyRequest !== undefined) {
      values.keyRequestTokenHash = patch.keyRequest.tokenHash;
      values.keyRequestExpiresAt = patch.keyRequest.expiresAt;
      values.keyRequestFields = [...patch.keyRequest.fields];
      values.keyRequestRequestedBy = patch.keyRequest.requestedBy
        ? await resolver(patch.keyRequest.requestedBy)
        : null;
      values.keyRequestCreatedAt = patch.keyRequest.createdAt;
    }

    const rows = await db
      .update(sourceConnections)
      .set(values)
      .where(
        and(
          eq(sourceConnections.id, pgId),
          eq(sourceConnections.workspaceId, wsUuid),
        ),
      )
      .returning();
    return rows[0] ? pgSourceConnectionToRecord(rows[0]) : null;
  }

  async claimSourceConnectionKeyRequest(
    input: ClaimSourceConnectionKeyRequestInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const pgId = tryEntityIdToPgUuid(input.id);
    const wsUuid = tryEntityIdToPgUuid(input.workspaceId);
    if (!pgId || !wsUuid) return false;
    const now = input.now ?? new Date();
    const res = await db.execute(sql`
      UPDATE "source_connections"
      SET
        "config_encrypted" = "config_encrypted" || ${JSON.stringify(input.encryptedFields)}::jsonb,
        "is_active" = true,
        "key_request_token_hash" = NULL,
        "key_request_expires_at" = NULL,
        "key_request_fields" = NULL,
        "key_request_requested_by" = NULL,
        "key_request_created_at" = NULL,
        "updated_at" = ${now.toISOString()}::timestamptz
      WHERE "id" = ${pgId}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "key_request_token_hash" = ${input.tokenHash}
        AND "key_request_expires_at" > ${now.toISOString()}::timestamptz
      RETURNING "id"
    `);
    return extractRows(res).length === 1;
  }

  async rollbackSourceConnectionKeyRequest(
    input: RollbackSourceConnectionKeyRequestInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const pgId = tryEntityIdToPgUuid(input.id);
    const wsUuid = tryEntityIdToPgUuid(input.workspaceId);
    if (!pgId || !wsUuid) return false;
    const now = input.now ?? new Date();
    const keys = Object.keys(input.encryptedFields);
    const requestedByUuid = input.keyRequest.requestedBy
      ? await resolvePgUserUuidOnDb(db, input.keyRequest.requestedBy)
      : null;

    const res = await db.execute(sql`
      UPDATE "source_connections"
      SET
        "config_encrypted" = "config_encrypted" - ${sqlTextArray(keys)},
        "is_active" = false,
        "key_request_token_hash" = ${input.keyRequest.tokenHash},
        "key_request_expires_at" = ${input.keyRequest.expiresAt.toISOString()}::timestamptz,
        "key_request_fields" = ${sqlTextArray(input.keyRequest.fields)},
        "key_request_requested_by" = ${requestedByUuid}::uuid,
        "key_request_created_at" = ${input.keyRequest.createdAt.toISOString()}::timestamptz,
        "updated_at" = ${now.toISOString()}::timestamptz
      WHERE "id" = ${pgId}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "key_request_token_hash" IS NULL
        AND "config_encrypted" @> ${JSON.stringify(input.encryptedFields)}::jsonb
      RETURNING "id"
    `);
    return extractRows(res).length === 1;
  }

  async deleteSourceConnection(
    id: string,
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return false;
    const rows = await db
      .delete(sourceConnections)
      .where(
        and(
          eq(sourceConnections.id, pgId),
          eq(sourceConnections.workspaceId, wsUuid),
        ),
      )
      .returning({ id: sourceConnections.id });
    return rows.length > 0;
  }

  async upsertSourceConnectionWithGuard(
    row: NewSourceConnectionRow,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const targetIdsSql = sqlUuidArray(row.targetDatabaseIds ?? []);
    const managersSql =
      row.managers === null || row.managers === undefined
        ? sql`NULL::uuid[]`
        : sqlUuidArray(row.managers);
    const keyFieldsSql =
      row.keyRequestFields === null || row.keyRequestFields === undefined
        ? sql`NULL::text[]`
        : sqlTextArray(row.keyRequestFields);

    const res = await db.execute(sql`
      INSERT INTO "source_connections" (
        "id",
        "workspace_id",
        "name",
        "type",
        "description",
        "config_encrypted",
        "settings",
        "target_database_ids",
        "writers",
        "live_reads",
        "live_readers",
        "managers",
        "created_by",
        "last_synced_at",
        "is_active",
        "key_request_token_hash",
        "key_request_expires_at",
        "key_request_fields",
        "key_request_requested_by",
        "key_request_created_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${row.id}::uuid,
        ${row.workspaceId}::uuid,
        ${row.name},
        ${row.type},
        ${row.description ?? null},
        ${JSON.stringify(row.configEncrypted ?? {})}::jsonb,
        ${JSON.stringify(row.settings)}::jsonb,
        ${targetIdsSql},
        ${row.writers === null || row.writers === undefined ? null : JSON.stringify(row.writers)}::jsonb,
        ${row.liveReads ?? false},
        ${row.liveReaders === null || row.liveReaders === undefined ? null : JSON.stringify(row.liveReaders)}::jsonb,
        ${managersSql},
        ${row.createdBy ?? null}::uuid,
        ${row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null}::timestamptz,
        ${row.isActive ?? true},
        ${row.keyRequestTokenHash ?? null},
        ${row.keyRequestExpiresAt ? row.keyRequestExpiresAt.toISOString() : null}::timestamptz,
        ${keyFieldsSql},
        ${row.keyRequestRequestedBy ?? null}::uuid,
        ${row.keyRequestCreatedAt ? row.keyRequestCreatedAt.toISOString() : null}::timestamptz,
        ${(row.createdAt ?? new Date()).toISOString()}::timestamptz,
        ${(row.updatedAt ?? new Date()).toISOString()}::timestamptz
      )
      ON CONFLICT ("id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "type" = EXCLUDED."type",
        "description" = EXCLUDED."description",
        "config_encrypted" = EXCLUDED."config_encrypted",
        "settings" = EXCLUDED."settings",
        "target_database_ids" = EXCLUDED."target_database_ids",
        "writers" = EXCLUDED."writers",
        "live_reads" = EXCLUDED."live_reads",
        "live_readers" = EXCLUDED."live_readers",
        "managers" = EXCLUDED."managers",
        "created_by" = EXCLUDED."created_by",
        "last_synced_at" = EXCLUDED."last_synced_at",
        "is_active" = EXCLUDED."is_active",
        "key_request_token_hash" = EXCLUDED."key_request_token_hash",
        "key_request_expires_at" = EXCLUDED."key_request_expires_at",
        "key_request_fields" = EXCLUDED."key_request_fields",
        "key_request_requested_by" = EXCLUDED."key_request_requested_by",
        "key_request_created_at" = EXCLUDED."key_request_created_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE "source_connections"."updated_at" IS NULL
         OR EXCLUDED."updated_at" >= "source_connections"."updated_at"
      RETURNING "id"
    `);
    return extractRows(res).length > 0;
  }

  // ── Connection access events ────────────────────────────────────────────

  async recordConnectionAccessEvent(
    input: RecordConnectionAccessEventInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectionAccessEventRecord> {
    const at = input.at ?? new Date();
    const wireId = input.id ?? newDualId(at.getTime()).oid;
    const record: ConnectionAccessEventRecord = {
      id: wireId,
      _id: wireId,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      kind: input.kind,
      actor: input.actor,
      via: input.via,
      changes: stripUndefinedDeep(input.changes),
      at,
    };
    const insertRow = await accessEventToPgInsert(
      record,
      this.makeUserResolver(db),
    );
    const rows = await db
      .insert(connectionAccessEvents)
      .values(insertRow)
      .returning();
    return pgAccessEventToRecord(rows[0]);
  }

  async listConnectionAccessEvents(
    workspaceId: string,
    connectionId: string,
    limit: number = 100,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectionAccessEventRecord[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    const connUuid = tryEntityIdToPgUuid(connectionId);
    if (!wsUuid || !connUuid) return [];
    const rows = await db
      .select()
      .from(connectionAccessEvents)
      .where(
        and(
          eq(connectionAccessEvents.workspaceId, wsUuid),
          eq(connectionAccessEvents.connectionId, connUuid),
        ),
      )
      .orderBy(desc(connectionAccessEvents.at))
      .limit(limit);
    return rows.map(pgAccessEventToRecord);
  }

  async findConnectionAccessEventById(
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectionAccessEventRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const rows = await db
      .select()
      .from(connectionAccessEvents)
      .where(eq(connectionAccessEvents.id, pgId))
      .limit(1);
    return rows[0] ? pgAccessEventToRecord(rows[0]) : null;
  }

  async upsertAccessEventIgnoreConflict(
    row: NewConnectionAccessEventRow,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const rows = await db
      .insert(connectionAccessEvents)
      .values(row)
      .onConflictDoNothing({ target: connectionAccessEvents.id })
      .returning({ id: connectionAccessEvents.id });
    return rows.length > 0;
  }

  // ── Connection write events ─────────────────────────────────────────────

  async recordConnectionWriteEvent(
    input: RecordConnectionWriteEventInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectionWriteEventRecord> {
    const at = input.at ?? new Date();
    const wireId = input.id ?? newDualId(at.getTime()).oid;
    const { principal, actorUserId } = await rewritePrincipalForPg(
      input.principal,
      this.makeUserResolver(db),
    );
    const rows = await db
      .insert(connectionWriteEvents)
      .values({
        id: entityIdToPgUuid(wireId),
        workspaceId: entityIdToPgUuid(input.workspaceId),
        connectionId: entityIdToPgUuid(input.connectionId),
        principal,
        actorUserId,
        target: input.target ?? null,
        allowed: input.allowed,
        status: input.status ?? null,
        error: input.error ?? null,
        at,
      })
      .returning();
    return pgWriteEventToRecord(rows[0]);
  }

  async recordConnectionWriteOutcome(
    id: string,
    _workspaceId: string,
    outcome: { status: number } | { error: string },
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return;
    await db
      .update(connectionWriteEvents)
      .set(
        "status" in outcome
          ? { status: outcome.status }
          : { error: outcome.error },
      )
      .where(eq(connectionWriteEvents.id, pgId));
  }

  async findConnectionWriteEventById(
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectionWriteEventRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const rows = await db
      .select()
      .from(connectionWriteEvents)
      .where(eq(connectionWriteEvents.id, pgId))
      .limit(1);
    return rows[0] ? pgWriteEventToRecord(rows[0]) : null;
  }

  async listRecentWriters(
    connectionId: string,
    since: Date,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<RecentWriterAggregate[]> {
    const connUuid = tryEntityIdToPgUuid(connectionId);
    if (!connUuid) return [];
    const res = await db.execute(sql`
      SELECT
        "principal",
        count(*)::int AS "count",
        max("at") AS "last_at",
        array_remove(array_agg(DISTINCT "target"), NULL) AS "targets"
      FROM "connection_write_events"
      WHERE "connection_id" = ${connUuid}::uuid
        AND "at" >= ${since.toISOString()}::timestamptz
      GROUP BY "principal"
      ORDER BY count(*) DESC, "principal" ASC
      LIMIT 50
    `);
    const rows = extractRows<{
      principal: string;
      count: number | string;
      last_at: Date | string;
      targets: string[] | null;
    }>(res);
    return rows.map(r => ({
      principal: r.principal,
      count: Number(r.count),
      lastAt: coerceDate(r.last_at),
      targets: Array.isArray(r.targets) ? [...r.targets].sort() : [],
    }));
  }

  async upsertWriteEventCoalesceOutcome(
    row: NewConnectionWriteEventRow,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const res = await db.execute(sql`
      INSERT INTO "connection_write_events" (
        "id",
        "workspace_id",
        "connection_id",
        "principal",
        "actor_user_id",
        "target",
        "allowed",
        "status",
        "error",
        "at"
      )
      VALUES (
        ${row.id}::uuid,
        ${row.workspaceId}::uuid,
        ${row.connectionId}::uuid,
        ${row.principal},
        ${row.actorUserId ?? null}::uuid,
        ${row.target ?? null},
        ${row.allowed},
        ${row.status ?? null},
        ${row.error ?? null},
        ${(row.at ?? new Date()).toISOString()}::timestamptz
      )
      ON CONFLICT ("id") DO UPDATE SET
        "status" = COALESCE("connection_write_events"."status", EXCLUDED."status"),
        "error" = COALESCE("connection_write_events"."error", EXCLUDED."error")
      RETURNING "id"
    `);
    return extractRows(res).length > 0;
  }

  // ── Connector definitions ───────────────────────────────────────────────

  async findConnectorDefinition(
    workspaceId: string,
    slug: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectorDefinitionRecord | null> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await db
      .select()
      .from(connectorDefinitions)
      .where(
        and(
          eq(connectorDefinitions.workspaceId, wsUuid),
          eq(connectorDefinitions.slug, slug.trim()),
        ),
      )
      .limit(1);
    return rows[0] ? pgConnectorDefinitionToRecord(rows[0]) : null;
  }

  async listConnectorDefinitions(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectorDefinitionRecord[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const rows = await db
      .select()
      .from(connectorDefinitions)
      .where(eq(connectorDefinitions.workspaceId, wsUuid))
      .orderBy(connectorDefinitions.slug);
    return rows.map(pgConnectorDefinitionToRecord);
  }

  async upsertConnectorDefinition(
    input: UpsertConnectorDefinitionInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectorDefinitionRecord> {
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const now = input.now ?? new Date();
    const slug = input.slug.trim();
    const pgId = input.id
      ? entityIdToPgUuid(input.id)
      : newDualId(now.getTime()).uuid;

    // Build conflict updateSet from ONLY fields explicitly supplied in `input`
    // (undefined preserves existing columns; explicit null clears them), matching
    // Mongo's `findOneAndUpdate(..., { $set, $unset, $setOnInsert }, { upsert: true })`
    // in a single atomic statement.
    const updateSet: Partial<typeof connectorDefinitions.$inferInsert> = {
      sha: input.sha,
      sourceSha: input.sourceSha,
      status: input.status,
      updatedAt: now,
    };
    if (input.runtime !== undefined) {
      updateSet.runtime = input.runtime;
    }
    if (input.entry !== undefined) {
      updateSet.entry = input.entry;
    }
    if (input.entities !== undefined) {
      updateSet.entities = [...input.entities];
    }
    if (input.hasIcon !== undefined) {
      updateSet.hasIcon = input.hasIcon;
    }
    if (input.spec === null) {
      updateSet.spec = null;
    } else if (input.spec !== undefined) {
      updateSet.spec = stripUndefinedDeep(input.spec);
    }
    if (input.blockedReason === null) {
      updateSet.blockedReason = null;
    } else if (input.blockedReason !== undefined) {
      updateSet.blockedReason = input.blockedReason;
    }
    if (input.indexRetryAttempts === null) {
      updateSet.indexRetryAttempts = null;
    } else if (input.indexRetryAttempts !== undefined) {
      updateSet.indexRetryAttempts = input.indexRetryAttempts;
    }
    if (input.nextIndexRetryAt === null) {
      updateSet.nextIndexRetryAt = null;
    } else if (input.nextIndexRetryAt !== undefined) {
      updateSet.nextIndexRetryAt = input.nextIndexRetryAt;
    }
    if (input.lastCheckedAt === null) {
      updateSet.lastCheckedAt = null;
    } else if (input.lastCheckedAt !== undefined) {
      updateSet.lastCheckedAt = input.lastCheckedAt;
    }
    if (input.lastCheckError === null) {
      updateSet.lastCheckError = null;
    } else if (input.lastCheckError !== undefined) {
      updateSet.lastCheckError = input.lastCheckError;
    }
    if (input.build === null) {
      updateSet.build = null;
    } else if (input.build !== undefined) {
      updateSet.build = buildToPgJson(input.build);
    }
    if (input.registry === null) {
      updateSet.registry = null;
    } else if (input.registry !== undefined) {
      updateSet.registry = registryToPgJson(input.registry);
    }

    const insertRow: NewConnectorDefinitionRow = {
      id: pgId,
      workspaceId: wsUuid,
      slug,
      runtime: input.runtime ?? "node",
      entry: input.entry ?? "connector.ts",
      sha: input.sha,
      sourceSha: input.sourceSha,
      spec: input.spec ? stripUndefinedDeep(input.spec) : null,
      status: input.status,
      blockedReason: input.blockedReason ?? null,
      indexRetryAttempts: input.indexRetryAttempts ?? null,
      nextIndexRetryAt: input.nextIndexRetryAt ?? null,
      entities: input.entities ? [...input.entities] : [],
      hasIcon: input.hasIcon ?? false,
      lastCheckedAt: input.lastCheckedAt ?? null,
      lastCheckError: input.lastCheckError ?? null,
      build: buildToPgJson(input.build),
      registry: registryToPgJson(input.registry),
      createdAt: now,
      updatedAt: now,
    };

    const rows = await db
      .insert(connectorDefinitions)
      .values(insertRow)
      .onConflictDoUpdate({
        target: [connectorDefinitions.workspaceId, connectorDefinitions.slug],
        set: updateSet,
      })
      .returning();
    return pgConnectorDefinitionToRecord(rows[0]);
  }

  async updateConnectorDefinitionMetadata(
    workspaceId: string,
    slug: string,
    patch: UpdateConnectorDefinitionMetadataInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return false;
    const now = patch.now ?? new Date();
    const predicates = [
      eq(connectorDefinitions.workspaceId, wsUuid),
      eq(connectorDefinitions.slug, slug.trim()),
    ];
    if (patch.expectedSourceSha !== undefined) {
      predicates.push(
        eq(connectorDefinitions.sourceSha, patch.expectedSourceSha),
      );
    }
    const values: Partial<typeof connectorDefinitions.$inferInsert> = {
      updatedAt: now,
    };
    if (patch.sha !== undefined) values.sha = patch.sha;
    if (patch.entry !== undefined) values.entry = patch.entry;
    if (patch.registry === null) {
      values.registry = null;
    } else if (patch.registry !== undefined) {
      values.registry = registryToPgJson(patch.registry);
    }
    const rows = await db
      .update(connectorDefinitions)
      .set(values)
      .where(and(...predicates))
      .returning({ id: connectorDefinitions.id });
    return rows.length > 0;
  }

  async findConnectorDefinitionById(
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ConnectorDefinitionRecord | null> {
    const pgId = tryEntityIdToPgUuid(id);
    if (!pgId) return null;
    const rows = await db
      .select()
      .from(connectorDefinitions)
      .where(eq(connectorDefinitions.id, pgId))
      .limit(1);
    return rows[0] ? pgConnectorDefinitionToRecord(rows[0]) : null;
  }

  async findExistingConnectorDefinitionIds(
    ids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const uuids = [
      ...new Set(
        ids.map(tryEntityIdToPgUuid).filter((v): v is string => v !== null),
      ),
    ];
    if (uuids.length === 0) return [];
    const rows = await db
      .select({ id: connectorDefinitions.id })
      .from(connectorDefinitions)
      .where(inArray(connectorDefinitions.id, uuids));
    return rows.map(r => toWireId(r.id));
  }

  async recordConnectorDefinitionBuild(
    workspaceId: string,
    slug: string,
    build: ConnectorDefinitionBuildRecord,
    options: { expectedSourceSha?: string; now?: Date } = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return false;
    const now = options.now ?? new Date();
    const predicates = [
      eq(connectorDefinitions.workspaceId, wsUuid),
      eq(connectorDefinitions.slug, slug.trim()),
    ];
    if (options.expectedSourceSha !== undefined) {
      predicates.push(
        eq(connectorDefinitions.sourceSha, options.expectedSourceSha),
      );
    }
    const rows = await db
      .update(connectorDefinitions)
      .set({ build: buildToPgJson(build), updatedAt: now })
      .where(and(...predicates))
      .returning({ id: connectorDefinitions.id });
    return rows.length > 0;
  }

  async recordConnectorDefinitionCheckResult(
    workspaceId: string,
    slug: string,
    result: {
      ok: boolean;
      checkedAt: Date;
      expectedSourceSha?: string;
      error?: string;
    },
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return false;
    const predicates = [
      eq(connectorDefinitions.workspaceId, wsUuid),
      eq(connectorDefinitions.slug, slug.trim()),
      notInArray(connectorDefinitions.status, ["blocked", "retrying"]),
    ];
    if (result.expectedSourceSha !== undefined) {
      predicates.push(
        eq(connectorDefinitions.sourceSha, result.expectedSourceSha),
      );
    }
    const rows = await db
      .update(connectorDefinitions)
      .set(
        result.ok
          ? {
              status: "verified",
              lastCheckedAt: result.checkedAt,
              lastCheckError: null,
              updatedAt: result.checkedAt,
            }
          : {
              status: "indexed",
              lastCheckedAt: result.checkedAt,
              lastCheckError: (result.error ?? "Connection test failed").slice(
                0,
                4000,
              ),
              updatedAt: result.checkedAt,
            },
      )
      .where(and(...predicates))
      .returning({ id: connectorDefinitions.id });
    return rows.length === 1;
  }

  async deleteConnectorDefinitionReturningId(
    workspaceId: string,
    slug: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await db
      .delete(connectorDefinitions)
      .where(
        and(
          eq(connectorDefinitions.workspaceId, wsUuid),
          eq(connectorDefinitions.slug, slug.trim()),
        ),
      )
      .returning({ id: connectorDefinitions.id });
    return rows[0] ? toWireId(rows[0].id) : null;
  }

  async deleteConnectorDefinition(
    workspaceId: string,
    slug: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    return (
      (await this.deleteConnectorDefinitionReturningId(
        workspaceId,
        slug,
        db,
      )) !== null
    );
  }

  async deleteConnectorDefinitionById(
    id: string,
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const pgId = tryEntityIdToPgUuid(id);
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!pgId || !wsUuid) return false;
    const rows = await db
      .delete(connectorDefinitions)
      .where(
        and(
          eq(connectorDefinitions.id, pgId),
          eq(connectorDefinitions.workspaceId, wsUuid),
        ),
      )
      .returning({ id: connectorDefinitions.id });
    return rows.length > 0;
  }

  async deleteConnectorDefinitionsByIds(
    ids: readonly string[],
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const uuids = [
      ...new Set(
        ids.map(tryEntityIdToPgUuid).filter((v): v is string => v !== null),
      ),
    ];
    if (uuids.length === 0) return [];
    const rows = await db
      .delete(connectorDefinitions)
      .where(
        and(
          eq(connectorDefinitions.workspaceId, wsUuid),
          inArray(connectorDefinitions.id, uuids),
        ),
      )
      .returning({ id: connectorDefinitions.id });
    return rows.map(r => toWireId(r.id));
  }

  async deleteConnectorDefinitionsNotInSlugs(
    workspaceId: string,
    keepSlugs: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const wsUuid = tryEntityIdToPgUuid(workspaceId);
    if (!wsUuid) return [];
    const predicates = [eq(connectorDefinitions.workspaceId, wsUuid)];
    if (keepSlugs.length > 0) {
      predicates.push(notInArray(connectorDefinitions.slug, [...keepSlugs]));
    }
    const rows = await db
      .delete(connectorDefinitions)
      .where(and(...predicates))
      .returning({ id: connectorDefinitions.id });
    return rows.map(r => toWireId(r.id));
  }

  async listWorkspaceIdsWithDueRetries(
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const res = await db.execute(sql`
      SELECT DISTINCT "workspace_id"
      FROM "connector_definitions"
      WHERE "status" = 'retrying'
        AND "next_index_retry_at" <= ${now.toISOString()}::timestamptz
    `);
    const rows = extractRows<{ workspace_id: string }>(res);
    return rows.map(r => toWireId(r.workspace_id));
  }

  async upsertConnectorDefinitionWithGuard(
    row: NewConnectorDefinitionRow,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const entitiesSql = sqlTextArray(row.entities ?? []);
    // Handle (workspace_id, slug) uniqueness cleanly if a row already exists with another id
    const existingBySlug = await db
      .select({
        id: connectorDefinitions.id,
        updatedAt: connectorDefinitions.updatedAt,
      })
      .from(connectorDefinitions)
      .where(
        and(
          eq(connectorDefinitions.workspaceId, row.workspaceId),
          eq(connectorDefinitions.slug, row.slug),
        ),
      )
      .limit(1);
    if (existingBySlug[0] && existingBySlug[0].id !== row.id) {
      const existingUpdated = existingBySlug[0].updatedAt?.getTime() ?? 0;
      const incomingUpdated = (row.updatedAt ?? new Date()).getTime();
      if (incomingUpdated < existingUpdated) return false;
      // Reconcile PK to `row.id` (no table FKs connector_definitions.id) so
      // delete+recreate in Mongo does not cause permanent ID drift or 23505.
      const updated = await db
        .update(connectorDefinitions)
        .set({
          id: row.id,
          runtime: row.runtime,
          entry: row.entry,
          sha: row.sha,
          sourceSha: row.sourceSha,
          spec: row.spec ?? null,
          status: row.status,
          blockedReason: row.blockedReason ?? null,
          indexRetryAttempts: row.indexRetryAttempts ?? null,
          nextIndexRetryAt: row.nextIndexRetryAt ?? null,
          entities: row.entities ?? [],
          hasIcon: row.hasIcon ?? false,
          lastCheckedAt: row.lastCheckedAt ?? null,
          lastCheckError: row.lastCheckError ?? null,
          build: row.build ?? null,
          registry: row.registry ?? null,
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? new Date(),
        })
        .where(eq(connectorDefinitions.id, existingBySlug[0].id))
        .returning({ id: connectorDefinitions.id });
      return updated.length > 0;
    }

    const res = await db.execute(sql`
      INSERT INTO "connector_definitions" (
        "id",
        "workspace_id",
        "slug",
        "runtime",
        "entry",
        "sha",
        "source_sha",
        "spec",
        "status",
        "blocked_reason",
        "index_retry_attempts",
        "next_index_retry_at",
        "entities",
        "has_icon",
        "last_checked_at",
        "last_check_error",
        "build",
        "registry",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${row.id}::uuid,
        ${row.workspaceId}::uuid,
        ${row.slug},
        ${row.runtime ?? "node"},
        ${row.entry ?? "connector.ts"},
        ${row.sha},
        ${row.sourceSha},
        ${row.spec === null || row.spec === undefined ? null : JSON.stringify(row.spec)}::jsonb,
        ${row.status ?? "indexed"},
        ${row.blockedReason ?? null},
        ${row.indexRetryAttempts ?? null},
        ${row.nextIndexRetryAt ? row.nextIndexRetryAt.toISOString() : null}::timestamptz,
        ${entitiesSql},
        ${row.hasIcon ?? false},
        ${row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null}::timestamptz,
        ${row.lastCheckError ?? null},
        ${row.build === null || row.build === undefined ? null : JSON.stringify(row.build)}::jsonb,
        ${row.registry === null || row.registry === undefined ? null : JSON.stringify(row.registry)}::jsonb,
        ${(row.createdAt ?? new Date()).toISOString()}::timestamptz,
        ${(row.updatedAt ?? new Date()).toISOString()}::timestamptz
      )
      ON CONFLICT ("id") DO UPDATE SET
        "slug" = EXCLUDED."slug",
        "runtime" = EXCLUDED."runtime",
        "entry" = EXCLUDED."entry",
        "sha" = EXCLUDED."sha",
        "source_sha" = EXCLUDED."source_sha",
        "spec" = EXCLUDED."spec",
        "status" = EXCLUDED."status",
        "blocked_reason" = EXCLUDED."blocked_reason",
        "index_retry_attempts" = EXCLUDED."index_retry_attempts",
        "next_index_retry_at" = EXCLUDED."next_index_retry_at",
        "entities" = EXCLUDED."entities",
        "has_icon" = EXCLUDED."has_icon",
        "last_checked_at" = EXCLUDED."last_checked_at",
        "last_check_error" = EXCLUDED."last_check_error",
        "build" = EXCLUDED."build",
        "registry" = EXCLUDED."registry",
        "updated_at" = EXCLUDED."updated_at"
      WHERE "connector_definitions"."updated_at" IS NULL
         OR EXCLUDED."updated_at" >= "connector_definitions"."updated_at"
      RETURNING "id"
    `);
    return extractRows(res).length > 0;
  }
}
