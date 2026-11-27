/**
 * 5-stage workspace-scoped dual-run `ConnectionsRepository` powered by
 * `MigrationRouter` (`domain = "connections"`, default `mongo_only`).
 *
 * Key invariants:
 *   - Byte-identical ciphertext dual-writes: `database_connections.connection` is
 *     encrypted ONCE via `encryptConnectionObject()` before `executeWrite()` and
 *     written verbatim to both Postgres and MongoDB (bypassing Mongoose setter).
 *   - All credential/secret fields are redacted in `CONNECTIONS_SHADOW_OPTIONS`.
 *   - Zero extra PG queries on hot read paths (Stages 1–5).
 *   - Delete tombstones recorded in `migration_tombstones` during Stages 2 & 3 so
 *     in-flight backfills never resurrect deleted rows.
 */
import { eq } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import { newDualId, parseEntityId, toWireId } from "../../database/pg/id-codec";
import {
  GLOBAL_SCOPE_KEY,
  migrationDomainState,
} from "../../database/pg/schema/control-plane";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import { encryptConnectionObject } from "./crypto";
import { MongoConnectionsRepository } from "./mongo.repo";
import { PgConnectionsRepository } from "./pg.repo";
import type {
  ClaimSourceConnectionKeyRequestInput,
  ConnectionAccessEventRecord,
  ConnectionWriteEventRecord,
  ConnectionsRepository,
  ConnectorDefinitionBuildRecord,
  ConnectorDefinitionRecord,
  CreateDatabaseConnectionInput,
  CreateSourceConnectionInput,
  DatabaseConnectionRecord,
  DatabaseConnectionSummary,
  FindSourceConnectionByIdOrNameResult,
  RecentWriterAggregate,
  RecordConnectionAccessEventInput,
  RecordConnectionWriteEventInput,
  RollbackSourceConnectionKeyRequestInput,
  SourceConnectionRecord,
  UpdateDatabaseConnectionInput,
  UpdateSourceConnectionInput,
  UpsertConnectorDefinitionInput,
} from "./types";

const CONNECTIONS_DOMAIN = "connections" as const;

export const CONNECTIONS_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: [
    "connection",
    "connectionEncrypted",
    "config",
    "configEncrypted",
    "password",
    "connectionString",
    "privateKey",
    "passphrase",
    "service_account_json",
    "keyRequest",
    "tokenHash",
    "api_key",
    "secret",
    "token",
    "headers",
  ],
};

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalizeDbConnForShadow(
  rec: DatabaseConnectionRecord | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    name: rec.name,
    type: rec.type,
    connection: rec.connection,
    isDemo: rec.isDemo,
    allowAgentWrites: rec.allowAgentWrites,
    writersCount: rec.writers === undefined ? null : rec.writers.length,
    lastConnectedAt: rec.lastConnectedAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function canonicalizeDbSummaryForShadow(
  rec: DatabaseConnectionSummary | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    name: rec.name,
    type: rec.type,
    isDemo: rec.isDemo,
    allowAgentWrites: rec.allowAgentWrites,
    writersCount: rec.writers === undefined ? null : rec.writers.length,
    lastConnectedAt: rec.lastConnectedAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function canonicalizeSourceConnForShadow(
  rec: SourceConnectionRecord | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    name: rec.name,
    type: rec.type,
    description: rec.description,
    config: rec.config,
    settings: rec.settings,
    targetDatabases: [...rec.targetDatabases].sort(),
    writersCount: rec.writers === undefined ? null : rec.writers.length,
    liveReads: rec.liveReads,
    liveReadersCount:
      rec.liveReaders === undefined ? null : rec.liveReaders.length,
    managersCount: rec.managers === undefined ? null : rec.managers.length,
    lastSyncedAt: rec.lastSyncedAt,
    isActive: rec.isActive,
    keyRequest: rec.keyRequest
      ? {
          tokenHash: rec.keyRequest.tokenHash,
          expiresAt: rec.keyRequest.expiresAt,
          fields: [...rec.keyRequest.fields].sort(),
          createdAt: rec.keyRequest.createdAt,
        }
      : undefined,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export interface DualConnectionsRepositoryDeps {
  mongo?: MongoConnectionsRepository;
  pg?: PgConnectionsRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
  hasPg?: () => boolean;
  isForceMongoOnly?: () => boolean;
}

export class DualConnectionsRepository implements ConnectionsRepository {
  readonly mongo: MongoConnectionsRepository;
  readonly pg: PgConnectionsRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;

  constructor(deps: DualConnectionsRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoConnectionsRepository();
    this.pg = deps.pg ?? new PgConnectionsRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasPg = deps.hasPg ?? hasPostgresConfig;
    this.isForceMongoOnly = deps.isForceMongoOnly ?? isMigrationForceMongoOnly;
  }

  private async isMongoPrimaryDualWrite(
    workspaceId?: string | null,
  ): Promise<boolean> {
    const mode = (await this.router.getState(CONNECTIONS_DOMAIN, workspaceId))
      .mode;
    return (
      mode === "dual_write_mongo_read" || mode === "dual_write_shadow_compare"
    );
  }

  private async recordTombstones(
    tableName: string,
    entityIds: Iterable<string>,
  ): Promise<void> {
    const db = this.getDb();
    for (const id of entityIds) {
      if (!id) continue;
      const pgUuid = parseEntityId(id)?.uuid;
      if (!pgUuid) continue;
      await recordMigrationTombstone(tableName, pgUuid, db);
    }
  }

  // ── Database connections ────────────────────────────────────────────────

  listDatabaseConnections(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listDatabaseConnections",
      },
      {
        mongo: () => this.mongo.listDatabaseConnections(workspaceId),
        pg: () => this.pg.listDatabaseConnections(workspaceId),
        canonicalize: items => sortById(items).map(canonicalizeDbConnForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  listDatabaseConnectionMetadata(
    workspaceId: string,
  ): Promise<DatabaseConnectionSummary[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listDatabaseConnectionMetadata",
      },
      {
        mongo: () => this.mongo.listDatabaseConnectionMetadata(workspaceId),
        pg: () => this.pg.listDatabaseConnectionMetadata(workspaceId),
        canonicalize: items =>
          sortById(items).map(canonicalizeDbSummaryForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDatabaseConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDatabaseConnectionById",
        entityId: id,
      },
      {
        mongo: () => this.mongo.findDatabaseConnectionById(id, workspaceId),
        pg: () => this.pg.findDatabaseConnectionById(id, workspaceId),
        canonicalize: canonicalizeDbConnForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDatabaseConnectionSummary(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDatabaseConnectionSummary",
        entityId: id,
      },
      {
        mongo: () => this.mongo.findDatabaseConnectionSummary(id, workspaceId),
        pg: () => this.pg.findDatabaseConnectionSummary(id, workspaceId),
        canonicalize: canonicalizeDbSummaryForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDatabaseConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDatabaseConnectionsByIds",
      },
      {
        mongo: () => this.mongo.findDatabaseConnectionsByIds(ids, workspaceId),
        pg: () => this.pg.findDatabaseConnectionsByIds(ids, workspaceId),
        canonicalize: items => sortById(items).map(canonicalizeDbConnForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDatabaseConnectionSummariesByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDatabaseConnectionSummariesByIds",
      },
      {
        mongo: () =>
          this.mongo.findDatabaseConnectionSummariesByIds(ids, workspaceId),
        pg: () =>
          this.pg.findDatabaseConnectionSummariesByIds(ids, workspaceId),
        canonicalize: items =>
          sortById(items).map(canonicalizeDbSummaryForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDatabaseConnectionByName(
    workspaceId: string,
    name: string,
  ): Promise<DatabaseConnectionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDatabaseConnectionByName",
      },
      {
        mongo: () => this.mongo.findDatabaseConnectionByName(workspaceId, name),
        pg: () => this.pg.findDatabaseConnectionByName(workspaceId, name),
        canonicalize: canonicalizeDbConnForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findDemoDatabaseConnection(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findDemoDatabaseConnection",
      },
      {
        mongo: () => this.mongo.findDemoDatabaseConnection(workspaceId),
        pg: () => this.pg.findDemoDatabaseConnection(workspaceId),
        canonicalize: canonicalizeDbConnForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  countDatabaseConnections(workspaceId: string): Promise<number> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "countDatabaseConnections",
      },
      {
        mongo: () => this.mongo.countDatabaseConnections(workspaceId),
        pg: () => this.pg.countDatabaseConnections(workspaceId),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  createDatabaseConnection(
    input: CreateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord> {
    const now = input.createdAt ?? new Date();
    const id = input.id ?? newDualId(now.getTime()).oid;
    // Encrypt ONCE before primary write so Mongo and Postgres store byte-identical ciphertext.
    const connectionEncrypted =
      input.connectionEncrypted ??
      encryptConnectionObject(input.connection ?? {});

    const prepared: CreateDatabaseConnectionInput = {
      ...input,
      id,
      connectionEncrypted,
      connection: undefined,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createDatabaseConnection",
        entityId: id,
        retryPayload: {
          table: "database_connections",
          connectionId: id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createDatabaseConnection(prepared),
        pg: () => this.pg.createDatabaseConnection(prepared),
      },
    );
  }

  updateDatabaseConnection(
    id: string,
    workspaceId: string,
    patch: UpdateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord | null> {
    const updatedAt = patch.updatedAt ?? new Date();
    // Encrypt ONCE before dual-write so Mongo and PG receive identical IV + ciphertext.
    const connectionEncrypted =
      patch.connectionEncrypted !== undefined
        ? patch.connectionEncrypted
        : patch.connection !== undefined
          ? encryptConnectionObject(patch.connection)
          : undefined;

    const prepared: UpdateDatabaseConnectionInput = {
      ...patch,
      connectionEncrypted,
      connection: undefined,
      updatedAt,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "updateDatabaseConnection",
        entityId: id,
        retryPayload: {
          table: "database_connections",
          connectionId: id,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.updateDatabaseConnection(id, workspaceId, prepared),
        pg: () => this.pg.updateDatabaseConnection(id, workspaceId, prepared),
      },
    );
  }

  touchDatabaseConnectionLastConnected(
    id: string,
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "touchDatabaseConnectionLastConnected",
        entityId: id,
        retryPayload: {
          table: "database_connections",
          connectionId: id,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.touchDatabaseConnectionLastConnected(id, workspaceId, at),
        pg: () =>
          this.pg.touchDatabaseConnectionLastConnected(id, workspaceId, at),
      },
    );
  }

  async deleteDatabaseConnection(
    id: string,
    workspaceId: string,
  ): Promise<boolean> {
    const tombstone = await this.isMongoPrimaryDualWrite(workspaceId);
    let primaryDeleted = false;
    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "deleteDatabaseConnection",
        entityId: id,
        retryPayload: {
          table: "database_connections",
          connectionId: id,
          workspaceId,
        },
      },
      {
        mongo: async () => {
          const ok = await this.mongo.deleteDatabaseConnection(id, workspaceId);
          if (ok) primaryDeleted = true;
          return ok;
        },
        pg: async () => {
          const ok = await this.pg.deleteDatabaseConnection(id, workspaceId);
          if (tombstone && (primaryDeleted || ok)) {
            await this.recordTombstones("database_connections", [id]);
          }
          return ok;
        },
      },
    );
  }

  // ── Source connections ──────────────────────────────────────────────────

  listSourceConnections(
    workspaceId: string,
    filter?: { type?: string; isActive?: boolean },
  ): Promise<SourceConnectionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listSourceConnections",
      },
      {
        mongo: () => this.mongo.listSourceConnections(workspaceId, filter),
        pg: () => this.pg.listSourceConnections(workspaceId, filter),
        canonicalize: items =>
          sortById(items).map(canonicalizeSourceConnForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  listActiveSourceConnections(filter?: {
    workspaceId?: string;
    type?: string;
  }): Promise<SourceConnectionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: filter?.workspaceId,
        operation: "listActiveSourceConnections",
      },
      {
        mongo: () => this.mongo.listActiveSourceConnections(filter),
        pg: () => this.pg.listActiveSourceConnections(filter),
        canonicalize: items =>
          sortById(items).map(canonicalizeSourceConnForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  listSourceConnectionIdNames(filter?: {
    isActive?: boolean;
  }): Promise<Array<{ id: string; name: string }>> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        operation: "listSourceConnectionIdNames",
      },
      {
        mongo: () => this.mongo.listSourceConnectionIdNames(filter),
        pg: () => this.pg.listSourceConnectionIdNames(filter),
        canonicalize: sortById,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findSourceConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<SourceConnectionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findSourceConnectionById",
        entityId: id,
      },
      {
        mongo: () => this.mongo.findSourceConnectionById(id, workspaceId),
        pg: () => this.pg.findSourceConnectionById(id, workspaceId),
        canonicalize: canonicalizeSourceConnForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findSourceConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<SourceConnectionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findSourceConnectionsByIds",
      },
      {
        mongo: () => this.mongo.findSourceConnectionsByIds(ids, workspaceId),
        pg: () => this.pg.findSourceConnectionsByIds(ids, workspaceId),
        canonicalize: items =>
          sortById(items).map(canonicalizeSourceConnForShadow),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findSourceConnectionByIdOrName(
    workspaceId: string,
    idOrName: string,
  ): Promise<FindSourceConnectionByIdOrNameResult> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findSourceConnectionByIdOrName",
      },
      {
        mongo: () =>
          this.mongo.findSourceConnectionByIdOrName(workspaceId, idOrName),
        pg: () => this.pg.findSourceConnectionByIdOrName(workspaceId, idOrName),
        canonicalize: res => ({
          ambiguous: Boolean(res.ambiguous),
          connection: canonicalizeSourceConnForShadow(res.connection),
        }),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  findSourceConnectionByKeyTokenHash(
    workspaceId: string,
    tokenHash: string,
  ): Promise<SourceConnectionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findSourceConnectionByKeyTokenHash",
      },
      {
        mongo: () =>
          this.mongo.findSourceConnectionByKeyTokenHash(workspaceId, tokenHash),
        pg: () =>
          this.pg.findSourceConnectionByKeyTokenHash(workspaceId, tokenHash),
        canonicalize: canonicalizeSourceConnForShadow,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  createSourceConnection(
    input: CreateSourceConnectionInput,
  ): Promise<SourceConnectionRecord> {
    const now = input.createdAt ?? new Date();
    const id = input.id ?? newDualId(now.getTime()).oid;
    const prepared: CreateSourceConnectionInput = {
      ...input,
      id,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createSourceConnection",
        entityId: id,
        retryPayload: {
          table: "source_connections",
          connectionId: id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createSourceConnection(prepared),
        pg: () => this.pg.createSourceConnection(prepared),
      },
    );
  }

  updateSourceConnection(
    id: string,
    workspaceId: string,
    patch: UpdateSourceConnectionInput,
  ): Promise<SourceConnectionRecord | null> {
    const prepared: UpdateSourceConnectionInput = {
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "updateSourceConnection",
        entityId: id,
        retryPayload: {
          table: "source_connections",
          connectionId: id,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.updateSourceConnection(id, workspaceId, prepared),
        pg: () => this.pg.updateSourceConnection(id, workspaceId, prepared),
      },
    );
  }

  claimSourceConnectionKeyRequest(
    input: ClaimSourceConnectionKeyRequestInput,
  ): Promise<boolean> {
    const prepared: ClaimSourceConnectionKeyRequestInput = {
      ...input,
      now: input.now ?? new Date(),
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "claimSourceConnectionKeyRequest",
        entityId: input.id,
        retryPayload: {
          table: "source_connections",
          connectionId: input.id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.claimSourceConnectionKeyRequest(prepared),
        pg: () => this.pg.claimSourceConnectionKeyRequest(prepared),
      },
    );
  }

  rollbackSourceConnectionKeyRequest(
    input: RollbackSourceConnectionKeyRequestInput,
  ): Promise<boolean> {
    const prepared: RollbackSourceConnectionKeyRequestInput = {
      ...input,
      now: input.now ?? new Date(),
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "rollbackSourceConnectionKeyRequest",
        entityId: input.id,
        retryPayload: {
          table: "source_connections",
          connectionId: input.id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.rollbackSourceConnectionKeyRequest(prepared),
        pg: () => this.pg.rollbackSourceConnectionKeyRequest(prepared),
      },
    );
  }

  async deleteSourceConnection(
    id: string,
    workspaceId: string,
  ): Promise<boolean> {
    const tombstone = await this.isMongoPrimaryDualWrite(workspaceId);
    let primaryDeleted = false;

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "deleteSourceConnection",
        entityId: id,
        retryPayload: {
          table: "source_connections",
          connectionId: id,
          workspaceId,
        },
      },
      {
        mongo: async () => {
          const ok = await this.mongo.deleteSourceConnection(id, workspaceId);
          if (ok) primaryDeleted = true;
          return ok;
        },
        pg: async () => {
          const ok = await this.pg.deleteSourceConnection(id, workspaceId);
          if (tombstone && (primaryDeleted || ok)) {
            await this.recordTombstones("source_connections", [id]);
          }
          return ok;
        },
      },
    );
  }

  // ── Connection access events ────────────────────────────────────────────

  recordConnectionAccessEvent(
    input: RecordConnectionAccessEventInput,
  ): Promise<ConnectionAccessEventRecord> {
    const at = input.at ?? new Date();
    const id = input.id ?? newDualId(at.getTime()).oid;
    const prepared: RecordConnectionAccessEventInput = {
      ...input,
      id,
      at,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "recordConnectionAccessEvent",
        entityId: id,
        retryPayload: {
          table: "connection_access_events",
          eventId: id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.recordConnectionAccessEvent(prepared),
        pg: () => this.pg.recordConnectionAccessEvent(prepared),
      },
    );
  }

  listConnectionAccessEvents(
    workspaceId: string,
    connectionId: string,
    limit?: number,
  ): Promise<ConnectionAccessEventRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listConnectionAccessEvents",
        entityId: connectionId,
      },
      {
        mongo: () =>
          this.mongo.listConnectionAccessEvents(
            workspaceId,
            connectionId,
            limit,
          ),
        pg: () =>
          this.pg.listConnectionAccessEvents(workspaceId, connectionId, limit),
        canonicalize: items =>
          sortById(items).map(e => ({
            id: e.id,
            workspaceId: e.workspaceId,
            connectionId: e.connectionId,
            kind: e.kind,
            via: e.via,
            at: e.at,
          })),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  // ── Connection write events ─────────────────────────────────────────────

  recordConnectionWriteEvent(
    input: RecordConnectionWriteEventInput,
  ): Promise<ConnectionWriteEventRecord> {
    const at = input.at ?? new Date();
    const id = input.id ?? newDualId(at.getTime()).oid;
    const prepared: RecordConnectionWriteEventInput = {
      ...input,
      id,
      at,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "recordConnectionWriteEvent",
        entityId: id,
        retryPayload: {
          table: "connection_write_events",
          eventId: id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.recordConnectionWriteEvent(prepared),
        pg: () => this.pg.recordConnectionWriteEvent(prepared),
      },
    );
  }

  recordConnectionWriteOutcome(
    id: string,
    workspaceId: string,
    outcome: { status: number } | { error: string },
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "recordConnectionWriteOutcome",
        entityId: id,
        retryPayload: {
          table: "connection_write_events",
          eventId: id,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.recordConnectionWriteOutcome(id, workspaceId, outcome),
        pg: () =>
          this.pg.recordConnectionWriteOutcome(id, workspaceId, outcome),
      },
    );
  }

  listRecentWriters(
    connectionId: string,
    since: Date,
    workspaceId?: string,
  ): Promise<RecentWriterAggregate[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listRecentWriters",
        entityId: connectionId,
      },
      {
        mongo: () => this.mongo.listRecentWriters(connectionId, since),
        pg: () => this.pg.listRecentWriters(connectionId, since, workspaceId),
        canonicalize: rows =>
          rows
            .map(r => ({
              count: r.count,
              lastAt: r.lastAt,
              targets: [...r.targets].sort(),
            }))
            .sort(
              (a, b) =>
                b.count - a.count ||
                b.lastAt.getTime() - a.lastAt.getTime() ||
                a.targets.join(",").localeCompare(b.targets.join(",")),
            ),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  // ── Connector definitions ───────────────────────────────────────────────

  findConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<ConnectorDefinitionRecord | null> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "findConnectorDefinition",
        entityId: `${workspaceId}:${slug}`,
      },
      {
        mongo: () => this.mongo.findConnectorDefinition(workspaceId, slug),
        pg: () => this.pg.findConnectorDefinition(workspaceId, slug),
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  listConnectorDefinitions(
    workspaceId: string,
  ): Promise<ConnectorDefinitionRecord[]> {
    return this.router.executeRead(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "listConnectorDefinitions",
      },
      {
        mongo: () => this.mongo.listConnectorDefinitions(workspaceId),
        pg: () => this.pg.listConnectorDefinitions(workspaceId),
        canonicalize: sortById,
        shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
      },
    );
  }

  upsertConnectorDefinition(
    input: UpsertConnectorDefinitionInput,
  ): Promise<ConnectorDefinitionRecord> {
    const now = input.now ?? new Date();
    const id = input.id ?? newDualId(now.getTime()).oid;
    const prepared: UpsertConnectorDefinitionInput = {
      ...input,
      id,
      now,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "upsertConnectorDefinition",
        entityId: `${input.workspaceId}:${input.slug}`,
        retryPayload: {
          table: "connector_definitions",
          workspaceId: input.workspaceId,
          slug: input.slug,
        },
      },
      {
        mongo: () => this.mongo.upsertConnectorDefinition(prepared),
        pg: () => this.pg.upsertConnectorDefinition(prepared),
      },
    );
  }

  recordConnectorDefinitionBuild(
    workspaceId: string,
    slug: string,
    build: ConnectorDefinitionBuildRecord,
    options: { expectedSourceSha?: string; now?: Date } = {},
  ): Promise<boolean> {
    const prepared = { ...options, now: options.now ?? new Date() };
    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "recordConnectorDefinitionBuild",
        entityId: `${workspaceId}:${slug}`,
        retryPayload: {
          table: "connector_definitions",
          workspaceId,
          slug,
        },
      },
      {
        mongo: () =>
          this.mongo.recordConnectorDefinitionBuild(
            workspaceId,
            slug,
            build,
            prepared,
          ),
        pg: () =>
          this.pg.recordConnectorDefinitionBuild(
            workspaceId,
            slug,
            build,
            prepared,
          ),
      },
    );
  }

  recordConnectorDefinitionCheckResult(
    workspaceId: string,
    slug: string,
    result: {
      ok: boolean;
      checkedAt: Date;
      expectedSourceSha?: string;
      error?: string;
    },
  ): Promise<boolean> {
    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "recordConnectorDefinitionCheckResult",
        entityId: `${workspaceId}:${slug}`,
        retryPayload: {
          table: "connector_definitions",
          workspaceId,
          slug,
        },
      },
      {
        mongo: () =>
          this.mongo.recordConnectorDefinitionCheckResult(
            workspaceId,
            slug,
            result,
          ),
        pg: () =>
          this.pg.recordConnectorDefinitionCheckResult(
            workspaceId,
            slug,
            result,
          ),
      },
    );
  }

  async deleteConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<boolean> {
    const tombstone = await this.isMongoPrimaryDualWrite(workspaceId);
    let mongoDeletedId: string | null = null;
    const retryPayload: Record<string, unknown> = {
      table: "connector_definitions",
      workspaceId,
      slug,
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "deleteConnectorDefinition",
        entityId: `${workspaceId}:${slug}`,
        retryPayload,
      },
      {
        mongo: async () => {
          const deletedId =
            await this.mongo.deleteConnectorDefinitionReturningId(
              workspaceId,
              slug,
            );
          if (deletedId) {
            mongoDeletedId = deletedId;
            retryPayload.definitionId = deletedId;
            return true;
          }
          return false;
        },
        pg: async () => {
          const pgDeletedId =
            await this.pg.deleteConnectorDefinitionReturningId(
              workspaceId,
              slug,
            );
          if (tombstone) {
            const toTombstone = new Set<string>();
            if (mongoDeletedId) toTombstone.add(mongoDeletedId);
            if (pgDeletedId) toTombstone.add(pgDeletedId);
            if (toTombstone.size > 0) {
              await this.recordTombstones("connector_definitions", toTombstone);
            }
          }
          return pgDeletedId !== null;
        },
      },
    );
  }

  async deleteConnectorDefinitionsNotInSlugs(
    workspaceId: string,
    keepSlugs: readonly string[],
  ): Promise<string[]> {
    const tombstone = await this.isMongoPrimaryDualWrite(workspaceId);
    let mongoDeletedIds: string[] = [];
    const retryPayload: Record<string, unknown> = {
      table: "connector_definitions",
      workspaceId,
      keepSlugs: [...keepSlugs],
    };

    return this.router.executeWrite(
      {
        domain: CONNECTIONS_DOMAIN,
        workspaceId,
        operation: "deleteConnectorDefinitionsNotInSlugs",
        retryPayload,
      },
      {
        mongo: async () => {
          mongoDeletedIds =
            await this.mongo.deleteConnectorDefinitionsNotInSlugs(
              workspaceId,
              keepSlugs,
            );
          if (mongoDeletedIds.length > 0) {
            retryPayload.deletedIds = [...mongoDeletedIds];
          }
          return mongoDeletedIds;
        },
        pg: async () => {
          const pgDeleted = await this.pg.deleteConnectorDefinitionsNotInSlugs(
            workspaceId,
            keepSlugs,
          );
          if (tombstone) {
            const toTombstone = new Set([...mongoDeletedIds, ...pgDeleted]);
            if (toTombstone.size > 0) {
              await this.recordTombstones("connector_definitions", toTombstone);
            }
          }
          return pgDeleted;
        },
      },
    );
  }

  async listWorkspaceIdsWithDueRetries(
    now: Date = new Date(),
  ): Promise<string[]> {
    if (this.isForceMongoOnly() || !this.hasPg()) {
      return this.mongo.listWorkspaceIdsWithDueRetries(now);
    }

    const executeGlobalRead = () =>
      this.router.executeRead(
        {
          domain: CONNECTIONS_DOMAIN,
          operation: "listWorkspaceIdsWithDueRetries",
        },
        {
          mongo: () => this.mongo.listWorkspaceIdsWithDueRetries(now),
          pg: () => this.pg.listWorkspaceIdsWithDueRetries(now),
          canonicalize: ids => [...ids].sort(),
          shadowOptions: CONNECTIONS_SHADOW_OPTIONS,
        },
      );

    let wsOverrides: Map<string, string>;
    try {
      const db = this.getDb();
      const overrideRows = await db
        .select({
          scopeKey: migrationDomainState.scopeKey,
          workspaceId: migrationDomainState.workspaceId,
          mode: migrationDomainState.mode,
        })
        .from(migrationDomainState)
        .where(eq(migrationDomainState.domain, CONNECTIONS_DOMAIN));
      wsOverrides = new Map<string, string>();
      for (const row of overrideRows) {
        if (row.scopeKey !== GLOBAL_SCOPE_KEY && row.workspaceId) {
          wsOverrides.set(toWireId(row.workspaceId), row.mode);
        }
      }
    } catch {
      return executeGlobalRead();
    }

    if (wsOverrides.size === 0) {
      return executeGlobalRead();
    }

    const globalState = await this.router.getState(CONNECTIONS_DOMAIN);
    const readsPg = (mode: string) =>
      mode === "dual_write_pg_read" || mode === "pg_only";
    const globalReadsPg = readsPg(globalState.mode);
    const effectiveReadsPg = (wsWireId: string) => {
      const override = wsOverrides.get(wsWireId);
      return override !== undefined ? readsPg(override) : globalReadsPg;
    };

    const anyReadsMongo =
      !globalReadsPg || [...wsOverrides.values()].some(m => !readsPg(m));
    const anyReadsPg =
      globalReadsPg || [...wsOverrides.values()].some(m => readsPg(m));

    const merged = new Set<string>();
    if (anyReadsMongo) {
      const mongoIds = await this.mongo.listWorkspaceIdsWithDueRetries(now);
      for (const id of mongoIds) {
        if (!effectiveReadsPg(id)) {
          merged.add(id);
        }
      }
    }
    if (anyReadsPg) {
      const pgIds = await this.pg.listWorkspaceIdsWithDueRetries(now);
      for (const id of pgIds) {
        if (effectiveReadsPg(id)) {
          merged.add(id);
        }
      }
    }
    return [...merged];
  }
}
