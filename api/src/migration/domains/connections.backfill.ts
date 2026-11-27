/**
 * Phase 2A-1 (`connections` domain) migration handlers:
 *   - FK-ordered resumable MongoDB -> Postgres backfill (`connections` + 5 per-table sub-domains)
 *   - Chunked parity verifier + `--repair` healer (`connections` + 5 per-table sub-domains)
 *   - Bidirectional Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`)
 *   - 90-day Postgres batched TTL reaper rule for `connection_write_events(at)`
 *     (`connection_access_events` is permanent audit history — NO TTL)
 *
 * FK backfill order:
 *   1. `database_connections`     (FK -> workspaces, users)
 *   2. `source_connections`       (FK -> workspaces, users)
 *   3. `connector_definitions`    (FK -> workspaces)
 *   4. `connection_access_events` (FK -> workspaces, users; soft ref connection_id)
 *   5. `connection_write_events`  (FK -> workspaces, users; soft ref connection_id)
 */
import { eq, inArray } from "drizzle-orm";
import { Types } from "mongoose";
import { ConnectionAccessEvent } from "../../access/connection-access-event";
import { ConnectionWriteEvent } from "../../access/connection-write-event";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import {
  CONNECTION_ACCESS_KINDS,
  CONNECTION_ACCESS_VIAS,
  CONNECTOR_DEFINITION_STATUSES,
  DATABASE_CONNECTION_TYPES,
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
import { workspaces } from "../../database/pg/schema/workspaces";
import {
  ConnectorDefinition,
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import { loggers } from "../../logging";
import {
  CONNECTIONS_SHADOW_OPTIONS,
  MongoConnectionsRepository,
  PgConnectionsRepository,
  accessEventToPgInsert,
  connectorDefinitionToPgInsert,
  databaseConnectionToPgInsert,
  mongoAccessEventToRecord,
  mongoConnectorDefinitionToRecord,
  mongoDatabaseConnectionToSummary,
  mongoSourceConnectionToRecord,
  mongoWriteEventToRecord,
  pgAccessEventToRecord,
  pgConnectorDefinitionToRecord,
  pgDatabaseConnectionToSummary,
  pgSourceConnectionToRecord,
  pgWriteEventToRecord,
  resolvePgUserUuidOnDb,
  sourceConnectionToPgInsert,
  stripUndefinedDeep,
  writeEventToPgInsert,
  type ConnectionAccessEventRecord,
  type ConnectionWriteEventRecord,
  type ConnectorDefinitionRecord,
  type DatabaseConnectionSummary,
  type MongoConnectionAccessEventLike,
  type MongoConnectionWriteEventLike,
  type MongoConnectorDefinitionLike,
  type MongoDatabaseConnectionLike,
  type MongoSourceConnectionLike,
  type SourceConnectionRecord,
  type UserUuidResolver,
} from "../../repositories/connections";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import { recordMigrationTombstone } from "../router";
import { registerTtlRule } from "../ttl-reaper";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

const logger = loggers.migration();

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export type ConnectionsTableName =
  | "database_connections"
  | "source_connections"
  | "connector_definitions"
  | "connection_access_events"
  | "connection_write_events";

interface ConnectionsStageMeta {
  stage: number;
  table: ConnectionsTableName;
  collection: string;
}

const CONNECTIONS_STAGES: readonly ConnectionsStageMeta[] = [
  {
    stage: 1,
    table: "database_connections",
    collection: "databaseconnections",
  },
  { stage: 2, table: "source_connections", collection: "connectors" },
  {
    stage: 3,
    table: "connector_definitions",
    collection: "connectordefinitions",
  },
  {
    stage: 4,
    table: "connection_access_events",
    collection: "connection_access_events",
  },
  {
    stage: 5,
    table: "connection_write_events",
    collection: "connection_write_events",
  },
] as const;

const VALID_DB_TYPES = new Set<string>(DATABASE_CONNECTION_TYPES);
const VALID_ACCESS_KINDS = new Set<string>(CONNECTION_ACCESS_KINDS);
const VALID_ACCESS_VIAS = new Set<string>(CONNECTION_ACCESS_VIAS);
const VALID_CONNECTOR_STATUSES = new Set<string>(CONNECTOR_DEFINITION_STATUSES);

type ConnectionsBackfillDoc =
  | {
      table: "database_connections";
      rawId: string;
      rawWorkspaceId: string;
      summary: DatabaseConnectionSummary;
      connectionEncrypted: Record<string, unknown>;
      pgRow?: NewDatabaseConnectionRow;
    }
  | {
      table: "source_connections";
      rawId: string;
      rawWorkspaceId: string;
      record: SourceConnectionRecord;
      pgRow?: NewSourceConnectionRow;
    }
  | {
      table: "connector_definitions";
      rawId: string;
      rawWorkspaceId: string;
      record: ConnectorDefinitionRecord;
      pgRow?: NewConnectorDefinitionRow;
    }
  | {
      table: "connection_access_events";
      rawId: string;
      rawWorkspaceId: string;
      rawConnectionId: string;
      record: ConnectionAccessEventRecord;
      pgRow?: NewConnectionAccessEventRow;
    }
  | {
      table: "connection_write_events";
      rawId: string;
      rawWorkspaceId: string;
      rawConnectionId: string;
      record: ConnectionWriteEventRecord;
      pgRow?: NewConnectionWriteEventRow;
    };

function encodeCompositeCursor(
  stage: number,
  table: ConnectionsTableName,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCompositeCursor(
  cursor: string | null,
): { stage: number; table: ConnectionsTableName; mongoId: string } | null {
  if (!cursor) return null;
  const match = /^([1-5]):([a-z_]+):(.*)$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as ConnectionsTableName,
    mongoId: match[3],
  };
}

function encodeVerifierKey(
  table: ConnectionsTableName,
  pgEntityId: string,
): string {
  return `${table}:${pgEntityId}`;
}

function decodeVerifierKey(
  key: string,
): { table: ConnectionsTableName; pgEntityId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as ConnectionsTableName,
    pgEntityId: key.slice(idx + 1),
  };
}

function tryEntityIdToMongoHex(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const oid = parseEntityId(str)?.oid;
  return oid && isObjectIdHex(oid) ? oid : null;
}

function buildMongoPaginationFilter(
  afterId: string | null,
  workspaceId: string | null,
): Record<string, unknown> {
  const clauses: Array<Record<string, unknown>> = [];
  if (workspaceId) {
    const hex = tryEntityIdToMongoHex(workspaceId);
    if (!hex) {
      return { _id: { $in: [] } };
    }
    clauses.push({ workspaceId: new Types.ObjectId(hex) });
  }
  if (afterId) {
    if (isObjectIdHex(afterId)) {
      clauses.push({ _id: { $gt: new Types.ObjectId(afterId) } });
    } else {
      clauses.push({
        $or: [{ _id: { $gt: afterId } }, { _id: { $type: "objectId" } }],
      });
    }
  }
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

function rawIdString(raw: unknown): string {
  if (raw instanceof Types.ObjectId) return raw.toHexString();
  return String(raw ?? "");
}

function makeMemoizedUserResolver(db: MakoPgDb): UserUuidResolver {
  const cache = new Map<string, string | null>();
  return async (idOrLegacyId: string): Promise<string | null> => {
    if (!idOrLegacyId) return null;
    if (cache.has(idOrLegacyId)) return cache.get(idOrLegacyId) ?? null;
    const resolved = await resolvePgUserUuidOnDb(db, idOrLegacyId);
    cache.set(idOrLegacyId, resolved);
    return resolved;
  };
}

async function workspaceExistsInPg(
  db: MakoPgDb,
  workspaceUuid: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const key = workspaceUuid.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, key))
    .limit(1);
  const exists = rows.length > 0;
  cache.set(key, exists);
  return exists;
}

function extractRawEncryptedConnection(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return stripUndefinedDeep({ ...(raw as Record<string, unknown>) });
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return stripUndefinedDeep({ ...(parsed as Record<string, unknown>) });
      }
    } catch {
      // Fall through to empty object
    }
  }
  return {};
}

async function fetchStageBackfillItems(
  meta: ConnectionsStageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  composite: boolean,
): Promise<Array<BackfillItem<ConnectionsBackfillDoc>>> {
  if (limit <= 0) return [];
  const makeCursor = (mongoId: string) =>
    composite
      ? encodeCompositeCursor(meta.stage, meta.table, mongoId)
      : mongoId;
  const filter = buildMongoPaginationFilter(afterId, workspaceId);

  switch (meta.table) {
    case "database_connections": {
      // Raw collection read copies existing `connection` ciphertext verbatim into PG!
      const docs = (await DatabaseConnection.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoDatabaseConnectionLike[];
      return docs.map(doc => {
        const rawId = rawIdString(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const summary = mongoDatabaseConnectionToSummary(doc);
        const connectionEncrypted = extractRawEncryptedConnection(
          doc.connection,
        );
        const entityId = isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId;
        return {
          cursor: makeCursor(rawId),
          entityId,
          targetTable: "database_connections",
          collectionName: meta.collection,
          doc: {
            table: "database_connections",
            rawId,
            rawWorkspaceId: rawWsId,
            summary,
            connectionEncrypted,
          },
        };
      });
    }

    case "source_connections": {
      const docs = (await SourceConnection.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoSourceConnectionLike[];
      return docs.map(doc => {
        const rawId = rawIdString(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const record = mongoSourceConnectionToRecord(doc);
        const entityId = isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId;
        return {
          cursor: makeCursor(rawId),
          entityId,
          targetTable: "source_connections",
          collectionName: meta.collection,
          doc: {
            table: "source_connections",
            rawId,
            rawWorkspaceId: rawWsId,
            record,
          },
        };
      });
    }

    case "connector_definitions": {
      const docs = (await ConnectorDefinition.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectorDefinitionLike[];
      return docs.map(doc => {
        const rawId = rawIdString(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const record = mongoConnectorDefinitionToRecord(doc);
        const entityId = isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId;
        return {
          cursor: makeCursor(rawId),
          entityId,
          targetTable: "connector_definitions",
          collectionName: meta.collection,
          doc: {
            table: "connector_definitions",
            rawId,
            rawWorkspaceId: rawWsId,
            record,
          },
        };
      });
    }

    case "connection_access_events": {
      const docs = (await ConnectionAccessEvent.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectionAccessEventLike[];
      return docs.map(doc => {
        const rawId = rawIdString(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const rawConnId = rawIdString(doc.connectionId);
        const record = mongoAccessEventToRecord(doc);
        const entityId = isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId;
        return {
          cursor: makeCursor(rawId),
          entityId,
          targetTable: "connection_access_events",
          collectionName: meta.collection,
          doc: {
            table: "connection_access_events",
            rawId,
            rawWorkspaceId: rawWsId,
            rawConnectionId: rawConnId,
            record,
          },
        };
      });
    }

    case "connection_write_events": {
      const docs = (await ConnectionWriteEvent.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectionWriteEventLike[];
      return docs.map(doc => {
        const rawId = rawIdString(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const rawConnId = rawIdString(doc.connectionId);
        const record = mongoWriteEventToRecord(doc);
        const entityId = isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId;
        return {
          cursor: makeCursor(rawId),
          entityId,
          targetTable: "connection_write_events",
          collectionName: meta.collection,
          doc: {
            table: "connection_write_events",
            rawId,
            rawWorkspaceId: rawWsId,
            rawConnectionId: rawConnId,
            record,
          },
        };
      });
    }
  }
}

async function validateConnectionsBackfillItem(
  item: BackfillItem<ConnectionsBackfillDoc>,
  db: MakoPgDb,
  wsExistsCache: Map<string, boolean>,
  resolveUserUuid: UserUuidResolver,
): Promise<BackfillValidationResult> {
  const { doc } = item;

  if (!isObjectIdHex(doc.rawId)) {
    return {
      ok: false,
      reason: "invalid_object_id",
      sanitizedPayload: { table: doc.table, id: doc.rawId },
    };
  }
  if (!isObjectIdHex(doc.rawWorkspaceId)) {
    return {
      ok: false,
      reason: "invalid_workspace_object_id",
      sanitizedPayload: {
        table: doc.table,
        id: doc.rawId,
        workspaceId: doc.rawWorkspaceId,
      },
    };
  }
  const wsUuid = objectIdToUuid(doc.rawWorkspaceId);
  if (!(await workspaceExistsInPg(db, wsUuid, wsExistsCache))) {
    return {
      ok: false,
      reason: "orphaned_workspace_missing",
      sanitizedPayload: {
        table: doc.table,
        id: doc.rawId,
        workspaceId: doc.rawWorkspaceId,
      },
    };
  }

  switch (doc.table) {
    case "database_connections": {
      if (!VALID_DB_TYPES.has(doc.summary.type)) {
        return {
          ok: false,
          reason: "invalid_database_connection_type",
          sanitizedPayload: { id: doc.rawId, type: doc.summary.type },
        };
      }
      doc.pgRow = await databaseConnectionToPgInsert(
        {
          id: doc.summary.id,
          workspaceId: doc.summary.workspaceId,
          name: doc.summary.name,
          type: doc.summary.type,
          connectionEncrypted: doc.connectionEncrypted,
          isDemo: doc.summary.isDemo,
          allowAgentWrites: doc.summary.allowAgentWrites,
          writers: doc.summary.writers,
          createdBy: doc.summary.createdBy,
          lastConnectedAt: doc.summary.lastConnectedAt,
          createdAt: doc.summary.createdAt,
          updatedAt: doc.summary.updatedAt,
        },
        resolveUserUuid,
      );
      return { ok: true };
    }

    case "source_connections": {
      if (!doc.record.name || !doc.record.type) {
        return {
          ok: false,
          reason: "invalid_source_connection_missing_fields",
          sanitizedPayload: { id: doc.rawId, type: doc.record.type },
        };
      }
      doc.pgRow = await sourceConnectionToPgInsert(doc.record, resolveUserUuid);
      return { ok: true };
    }

    case "connector_definitions": {
      if (
        !doc.record.slug ||
        !VALID_CONNECTOR_STATUSES.has(doc.record.status)
      ) {
        return {
          ok: false,
          reason: "invalid_connector_definition",
          sanitizedPayload: {
            id: doc.rawId,
            slug: doc.record.slug,
            status: doc.record.status,
          },
        };
      }
      doc.pgRow = connectorDefinitionToPgInsert(doc.record);
      return { ok: true };
    }

    case "connection_access_events": {
      if (!isObjectIdHex(doc.rawConnectionId)) {
        return {
          ok: false,
          reason: "invalid_connection_object_id",
          sanitizedPayload: {
            table: doc.table,
            id: doc.rawId,
            connectionId: doc.rawConnectionId,
          },
        };
      }
      if (
        !VALID_ACCESS_KINDS.has(doc.record.kind) ||
        !VALID_ACCESS_VIAS.has(doc.record.via)
      ) {
        return {
          ok: false,
          reason: "invalid_access_event_enum",
          sanitizedPayload: {
            id: doc.rawId,
            kind: doc.record.kind,
            via: doc.record.via,
          },
        };
      }
      doc.pgRow = await accessEventToPgInsert(doc.record, resolveUserUuid);
      return { ok: true };
    }

    case "connection_write_events": {
      if (!isObjectIdHex(doc.rawConnectionId)) {
        return {
          ok: false,
          reason: "invalid_connection_object_id",
          sanitizedPayload: {
            table: doc.table,
            id: doc.rawId,
            connectionId: doc.rawConnectionId,
          },
        };
      }
      doc.pgRow = await writeEventToPgInsert(doc.record, resolveUserUuid);
      return { ok: true };
    }
  }
}

async function upsertConnectionsBackfillItems(
  items: Array<BackfillItem<ConnectionsBackfillDoc>>,
  db: MakoPgDb,
  pgRepo: PgConnectionsRepository,
): Promise<number> {
  let upserted = 0;
  for (const item of items) {
    const { doc } = item;
    let wrote = false;
    switch (doc.table) {
      case "database_connections":
        if (doc.pgRow) {
          wrote = await pgRepo.upsertDatabaseConnectionWithGuard(doc.pgRow, db);
        }
        break;
      case "source_connections":
        if (doc.pgRow) {
          wrote = await pgRepo.upsertSourceConnectionWithGuard(doc.pgRow, db);
        }
        break;
      case "connector_definitions":
        if (doc.pgRow) {
          wrote = await pgRepo.upsertConnectorDefinitionWithGuard(
            doc.pgRow,
            db,
          );
        }
        break;
      case "connection_access_events":
        if (doc.pgRow) {
          wrote = await pgRepo.upsertAccessEventIgnoreConflict(doc.pgRow, db);
        }
        break;
      case "connection_write_events":
        if (doc.pgRow) {
          wrote = await pgRepo.upsertWriteEventCoalesceOutcome(doc.pgRow, db);
        }
        break;
    }
    if (wrote) upserted += 1;
  }
  return upserted;
}

export function createConnectionsBackfillHandler(): BackfillDomainHandler<ConnectionsBackfillDoc> {
  const pgRepo = new PgConnectionsRepository();
  const wsExistsCache = new Map<string, boolean>();
  let batchResolver: UserUuidResolver | null = null;

  return {
    domain: "connections",
    collectionName: "databaseconnections",
    targetTable: "database_connections",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      wsExistsCache.clear();
      batchResolver = null;
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<ConnectionsBackfillDoc>> = [];

      for (const meta of CONNECTIONS_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;

        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          workspaceId,
          true,
        );
        items.push(...batch);
      }

      return items;
    },
    validate(item, db) {
      batchResolver ??= makeMemoizedUserResolver(db);
      return validateConnectionsBackfillItem(
        item,
        db,
        wsExistsCache,
        batchResolver,
      );
    },
    upsertBatch(items, db) {
      return upsertConnectionsBackfillItems(items, db, pgRepo);
    },
  };
}

export function createConnectionsTableBackfillHandler(
  meta: ConnectionsStageMeta,
): BackfillDomainHandler<ConnectionsBackfillDoc> {
  const pgRepo = new PgConnectionsRepository();
  const wsExistsCache = new Map<string, boolean>();
  let batchResolver: UserUuidResolver | null = null;

  return {
    domain: `connections:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      wsExistsCache.clear();
      batchResolver = null;
      return fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
      );
    },
    validate(item, db) {
      batchResolver ??= makeMemoizedUserResolver(db);
      return validateConnectionsBackfillItem(
        item,
        db,
        wsExistsCache,
        batchResolver,
      );
    },
    upsertBatch(items, db) {
      return upsertConnectionsBackfillItems(items, db, pgRepo);
    },
  };
}

// ── Parity verifier (+ --repair) ────────────────────────────────────────────

function canonicalizePgDbConnForVerify(
  row: typeof databaseConnections.$inferSelect,
): Record<string, unknown> {
  return {
    ...pgDatabaseConnectionToSummary(row),
    connectionEncrypted: stripUndefinedDeep(row.connectionEncrypted ?? {}),
  };
}

async function fetchPgRecordsForTable(
  table: ConnectionsTableName,
  ids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const uuidIds = ids.filter(isUuidString).map(id => id.toLowerCase());
  if (uuidIds.length === 0) return out;

  switch (table) {
    case "database_connections": {
      const rows = await db
        .select()
        .from(databaseConnections)
        .where(inArray(databaseConnections.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), canonicalizePgDbConnForVerify(row));
      }
      return out;
    }

    case "source_connections": {
      const rows = await db
        .select()
        .from(sourceConnections)
        .where(inArray(sourceConnections.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgSourceConnectionToRecord(row));
      }
      return out;
    }

    case "connector_definitions": {
      const rows = await db
        .select()
        .from(connectorDefinitions)
        .where(inArray(connectorDefinitions.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgConnectorDefinitionToRecord(row));
      }
      return out;
    }

    case "connection_access_events": {
      const rows = await db
        .select()
        .from(connectionAccessEvents)
        .where(inArray(connectionAccessEvents.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAccessEventToRecord(row));
      }
      return out;
    }

    case "connection_write_events": {
      const rows = await db
        .select()
        .from(connectionWriteEvents)
        .where(inArray(connectionWriteEvents.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgWriteEventToRecord(row));
      }
      return out;
    }
  }
}

async function listAllPgIdsForTable(
  table: ConnectionsTableName,
  workspaceId: string | null,
  db: MakoPgDb,
): Promise<string[]> {
  let wsUuid: string | null = null;
  if (workspaceId !== null) {
    wsUuid = parseEntityId(workspaceId)?.uuid ?? null;
    if (!wsUuid) return [];
  }

  switch (table) {
    case "database_connections": {
      const base = db
        .select({ id: databaseConnections.id })
        .from(databaseConnections);
      const rows = wsUuid
        ? await base.where(eq(databaseConnections.workspaceId, wsUuid))
        : await base;
      return rows.map(r => r.id.toLowerCase());
    }

    case "source_connections": {
      const base = db
        .select({ id: sourceConnections.id })
        .from(sourceConnections);
      const rows = wsUuid
        ? await base.where(eq(sourceConnections.workspaceId, wsUuid))
        : await base;
      return rows.map(r => r.id.toLowerCase());
    }

    case "connector_definitions": {
      const base = db
        .select({ id: connectorDefinitions.id })
        .from(connectorDefinitions);
      const rows = wsUuid
        ? await base.where(eq(connectorDefinitions.workspaceId, wsUuid))
        : await base;
      return rows.map(r => r.id.toLowerCase());
    }

    case "connection_access_events": {
      const base = db
        .select({ id: connectionAccessEvents.id })
        .from(connectionAccessEvents);
      const rows = wsUuid
        ? await base.where(eq(connectionAccessEvents.workspaceId, wsUuid))
        : await base;
      return rows.map(r => r.id.toLowerCase());
    }

    case "connection_write_events": {
      const base = db
        .select({ id: connectionWriteEvents.id })
        .from(connectionWriteEvents);
      const rows = wsUuid
        ? await base.where(eq(connectionWriteEvents.workspaceId, wsUuid))
        : await base;
      return rows.map(r => r.id.toLowerCase());
    }
  }
}

async function buildVerifierRecord(
  item: BackfillItem<ConnectionsBackfillDoc>,
  resolveUserUuid: UserUuidResolver,
  composite: boolean,
): Promise<VerifierMongoRecord> {
  const { doc } = item;
  const pgEntityId = item.entityId.toLowerCase();
  let expectedRecord: unknown;

  switch (doc.table) {
    case "database_connections": {
      const pgRow = await databaseConnectionToPgInsert(
        {
          id: doc.summary.id,
          workspaceId: doc.summary.workspaceId,
          name: doc.summary.name,
          type: doc.summary.type,
          connectionEncrypted: doc.connectionEncrypted,
          isDemo: doc.summary.isDemo,
          allowAgentWrites: doc.summary.allowAgentWrites,
          writers: doc.summary.writers,
          createdBy: doc.summary.createdBy,
          lastConnectedAt: doc.summary.lastConnectedAt,
          createdAt: doc.summary.createdAt,
          updatedAt: doc.summary.updatedAt,
        },
        resolveUserUuid,
      );
      expectedRecord = canonicalizePgDbConnForVerify({
        id: pgRow.id,
        workspaceId: pgRow.workspaceId,
        name: pgRow.name,
        type: pgRow.type,
        connectionEncrypted: pgRow.connectionEncrypted ?? {},
        isDemo: pgRow.isDemo ?? false,
        allowAgentWrites: pgRow.allowAgentWrites ?? false,
        writers: pgRow.writers ?? null,
        createdBy: pgRow.createdBy ?? null,
        lastConnectedAt: pgRow.lastConnectedAt ?? null,
        createdAt: pgRow.createdAt ?? new Date(0),
        updatedAt: pgRow.updatedAt ?? new Date(0),
      });
      break;
    }

    case "source_connections": {
      const pgRow = await sourceConnectionToPgInsert(
        doc.record,
        resolveUserUuid,
      );
      expectedRecord = pgSourceConnectionToRecord({
        id: pgRow.id,
        workspaceId: pgRow.workspaceId,
        name: pgRow.name,
        type: pgRow.type,
        description: pgRow.description ?? null,
        configEncrypted: pgRow.configEncrypted ?? {},
        settings: pgRow.settings ?? {
          sync_batch_size: 100,
          rate_limit_delay_ms: 200,
        },
        targetDatabaseIds: pgRow.targetDatabaseIds ?? [],
        writers: pgRow.writers ?? null,
        liveReads: pgRow.liveReads ?? false,
        liveReaders: pgRow.liveReaders ?? null,
        managers: pgRow.managers ?? null,
        createdBy: pgRow.createdBy ?? null,
        lastSyncedAt: pgRow.lastSyncedAt ?? null,
        isActive: pgRow.isActive ?? true,
        keyRequestTokenHash: pgRow.keyRequestTokenHash ?? null,
        keyRequestExpiresAt: pgRow.keyRequestExpiresAt ?? null,
        keyRequestFields: pgRow.keyRequestFields ?? null,
        keyRequestRequestedBy: pgRow.keyRequestRequestedBy ?? null,
        keyRequestCreatedAt: pgRow.keyRequestCreatedAt ?? null,
        createdAt: pgRow.createdAt ?? new Date(0),
        updatedAt: pgRow.updatedAt ?? new Date(0),
      });
      break;
    }

    case "connector_definitions": {
      const pgRow = connectorDefinitionToPgInsert(doc.record);
      expectedRecord = pgConnectorDefinitionToRecord({
        id: pgRow.id,
        workspaceId: pgRow.workspaceId,
        slug: pgRow.slug,
        runtime: pgRow.runtime ?? "node",
        entry: pgRow.entry ?? "connector.ts",
        sha: pgRow.sha,
        sourceSha: pgRow.sourceSha,
        spec: pgRow.spec ?? null,
        status: pgRow.status ?? "indexed",
        blockedReason: pgRow.blockedReason ?? null,
        indexRetryAttempts: pgRow.indexRetryAttempts ?? null,
        nextIndexRetryAt: pgRow.nextIndexRetryAt ?? null,
        entities: pgRow.entities ?? [],
        hasIcon: pgRow.hasIcon ?? false,
        lastCheckedAt: pgRow.lastCheckedAt ?? null,
        lastCheckError: pgRow.lastCheckError ?? null,
        build: pgRow.build ?? null,
        registry: pgRow.registry ?? null,
        createdAt: pgRow.createdAt ?? new Date(0),
        updatedAt: pgRow.updatedAt ?? new Date(0),
      });
      break;
    }

    case "connection_access_events": {
      const pgRow = await accessEventToPgInsert(doc.record, resolveUserUuid);
      expectedRecord = pgAccessEventToRecord({
        id: pgRow.id,
        workspaceId: pgRow.workspaceId,
        connectionId: pgRow.connectionId,
        kind: pgRow.kind,
        actorUserId: pgRow.actorUserId ?? null,
        actorRaw: pgRow.actorRaw ?? null,
        via: pgRow.via,
        changes: pgRow.changes,
        at: pgRow.at ?? new Date(0),
      });
      break;
    }

    case "connection_write_events": {
      const pgRow = await writeEventToPgInsert(doc.record, resolveUserUuid);
      expectedRecord = pgWriteEventToRecord({
        id: pgRow.id,
        workspaceId: pgRow.workspaceId,
        connectionId: pgRow.connectionId,
        principal: pgRow.principal,
        actorUserId: pgRow.actorUserId ?? null,
        target: pgRow.target ?? null,
        allowed: pgRow.allowed,
        status: pgRow.status ?? null,
        error: pgRow.error ?? null,
        at: pgRow.at ?? new Date(0),
      });
      break;
    }
  }

  return {
    cursor: item.cursor,
    entityId: composite ? encodeVerifierKey(doc.table, pgEntityId) : pgEntityId,
    targetTable: doc.table,
    tombstoneId: pgEntityId,
    record: expectedRecord,
  };
}

async function repairSingleConnectionsRecord(
  table: ConnectionsTableName,
  pgEntityId: string,
  db: MakoPgDb,
  pgRepo: PgConnectionsRepository,
  wsExistsCache: Map<string, boolean> = new Map(),
): Promise<boolean> {
  const oidHex = uuidToObjectId(pgEntityId);
  if (!oidHex || !isObjectIdHex(oidHex)) return false;
  const oid = new Types.ObjectId(oidHex);
  const resolver = makeMemoizedUserResolver(db);
  const ensureWorkspace = async (rawWsId: string): Promise<boolean> => {
    if (!isObjectIdHex(rawWsId)) return false;
    return workspaceExistsInPg(db, objectIdToUuid(rawWsId), wsExistsCache);
  };

  switch (table) {
    case "database_connections": {
      const doc = (await DatabaseConnection.collection.findOne({
        _id: oid,
      })) as unknown as MongoDatabaseConnectionLike | null;
      if (!doc || !(await ensureWorkspace(rawIdString(doc.workspaceId)))) {
        return false;
      }
      const summary = mongoDatabaseConnectionToSummary(doc);
      if (!VALID_DB_TYPES.has(summary.type)) return false;
      const connectionEncrypted = extractRawEncryptedConnection(doc.connection);
      const row = await databaseConnectionToPgInsert(
        {
          id: summary.id,
          workspaceId: summary.workspaceId,
          name: summary.name,
          type: summary.type,
          connectionEncrypted,
          isDemo: summary.isDemo,
          allowAgentWrites: summary.allowAgentWrites,
          writers: summary.writers,
          createdBy: summary.createdBy,
          lastConnectedAt: summary.lastConnectedAt,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        resolver,
      );
      return pgRepo.upsertDatabaseConnectionWithGuard(row, db);
    }

    case "source_connections": {
      const doc = (await SourceConnection.collection.findOne({
        _id: oid,
      })) as unknown as MongoSourceConnectionLike | null;
      if (!doc || !(await ensureWorkspace(rawIdString(doc.workspaceId)))) {
        return false;
      }
      const row = await sourceConnectionToPgInsert(
        mongoSourceConnectionToRecord(doc),
        resolver,
      );
      return pgRepo.upsertSourceConnectionWithGuard(row, db);
    }

    case "connector_definitions": {
      const doc = (await ConnectorDefinition.collection.findOne({
        _id: oid,
      })) as unknown as MongoConnectorDefinitionLike | null;
      if (!doc || !(await ensureWorkspace(rawIdString(doc.workspaceId)))) {
        return false;
      }
      const record = mongoConnectorDefinitionToRecord(doc);
      if (!record.slug || !VALID_CONNECTOR_STATUSES.has(record.status)) {
        return false;
      }
      const row = connectorDefinitionToPgInsert(record);
      return pgRepo.upsertConnectorDefinitionWithGuard(row, db);
    }

    case "connection_access_events": {
      const doc = (await ConnectionAccessEvent.collection.findOne({
        _id: oid,
      })) as unknown as MongoConnectionAccessEventLike | null;
      if (
        !doc ||
        !(await ensureWorkspace(rawIdString(doc.workspaceId))) ||
        !isObjectIdHex(rawIdString(doc.connectionId))
      ) {
        return false;
      }
      const record = mongoAccessEventToRecord(doc);
      if (
        !VALID_ACCESS_KINDS.has(record.kind) ||
        !VALID_ACCESS_VIAS.has(record.via)
      ) {
        return false;
      }
      const row = await accessEventToPgInsert(record, resolver);
      return pgRepo.upsertAccessEventIgnoreConflict(row, db);
    }

    case "connection_write_events": {
      const doc = (await ConnectionWriteEvent.collection.findOne({
        _id: oid,
      })) as unknown as MongoConnectionWriteEventLike | null;
      if (
        !doc ||
        !(await ensureWorkspace(rawIdString(doc.workspaceId))) ||
        !isObjectIdHex(rawIdString(doc.connectionId))
      ) {
        return false;
      }
      const row = await writeEventToPgInsert(
        mongoWriteEventToRecord(doc),
        resolver,
      );
      return pgRepo.upsertWriteEventCoalesceOutcome(row, db);
    }
  }
}

export function createConnectionsVerifierHandler(): VerifierDomainHandler {
  const pgRepo = new PgConnectionsRepository();

  return {
    domain: "connections",
    targetTable: "database_connections",
    compareOptions: CONNECTIONS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<ConnectionsBackfillDoc>> = [];

      for (const meta of CONNECTIONS_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;

        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          workspaceId,
          true,
        );
        items.push(...batch);
      }

      const resolver = makeMemoizedUserResolver(db);
      return Promise.all(
        items.map(item => buildVerifierRecord(item, resolver, true)),
      );
    },
    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<ConnectionsTableName, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        const list = byTable.get(decoded.table);
        if (list) list.push(decoded.pgEntityId);
        else byTable.set(decoded.table, [decoded.pgEntityId]);
      }

      const out = new Map<string, unknown>();
      await Promise.all(
        [...byTable.entries()].map(async ([table, ids]) => {
          const tableMap = await fetchPgRecordsForTable(table, ids, db);
          for (const [id, rec] of tableMap) {
            out.set(encodeVerifierKey(table, id), rec);
          }
        }),
      );
      return out;
    },
    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of CONNECTIONS_STAGES) {
        const ids = await listAllPgIdsForTable(meta.table, workspaceId, db);
        for (const id of ids) {
          const key = encodeVerifierKey(meta.table, id);
          if (!seenEntityIds.has(key)) extras.push(key);
        }
      }
      return extras;
    },
    async repair({ entityIds, db }) {
      const parsed = entityIds
        .map(decodeVerifierKey)
        .filter((v): v is NonNullable<typeof v> => v !== null);
      let repaired = 0;
      for (const entry of parsed) {
        if (
          await repairSingleConnectionsRecord(
            entry.table,
            entry.pgEntityId,
            db,
            pgRepo,
          )
        ) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

export function createConnectionsTableVerifierHandler(
  meta: ConnectionsStageMeta,
): VerifierDomainHandler {
  const pgRepo = new PgConnectionsRepository();

  return {
    domain: `connections:${meta.table}`,
    targetTable: meta.table,
    compareOptions: CONNECTIONS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const items = await fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
      );
      const resolver = makeMemoizedUserResolver(db);
      return Promise.all(
        items.map(item => buildVerifierRecord(item, resolver, false)),
      );
    },
    fetchPgByIds(entityIds, db) {
      return fetchPgRecordsForTable(meta.table, entityIds, db);
    },
    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const ids = await listAllPgIdsForTable(meta.table, workspaceId, db);
      return ids.filter(id => !seenEntityIds.has(id));
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const id of entityIds) {
        if (await repairSingleConnectionsRecord(meta.table, id, db, pgRepo)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

// ── Bidirectional Inngest sync-retry replay handlers ────────────────────────

export async function replayConnectionsWriteToPg(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const pgRepo = new PgConnectionsRepository({ getDb: () => db });
  const payload = data.payload ?? {};
  const resolver = makeMemoizedUserResolver(db);

  switch (data.operation) {
    case "createDatabaseConnection":
    case "updateDatabaseConnection":
    case "touchDatabaseConnectionLastConnected": {
      const id = tryEntityIdToMongoHex(payload.connectionId ?? data.entityId);
      if (!id) return;
      const doc = (await DatabaseConnection.collection.findOne({
        _id: new Types.ObjectId(id),
      })) as unknown as MongoDatabaseConnectionLike | null;
      if (!doc) return;
      const summary = mongoDatabaseConnectionToSummary(doc);
      const connectionEncrypted = extractRawEncryptedConnection(doc.connection);
      const row = await databaseConnectionToPgInsert(
        {
          id: summary.id,
          workspaceId: summary.workspaceId,
          name: summary.name,
          type: summary.type,
          connectionEncrypted,
          isDemo: summary.isDemo,
          allowAgentWrites: summary.allowAgentWrites,
          writers: summary.writers,
          createdBy: summary.createdBy,
          lastConnectedAt: summary.lastConnectedAt,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        resolver,
      );
      await pgRepo.upsertDatabaseConnectionWithGuard(row, db);
      return;
    }

    case "deleteDatabaseConnection": {
      const id = tryEntityIdToMongoHex(payload.connectionId ?? data.entityId);
      const workspaceId = String(payload.workspaceId ?? "");
      if (!id || !workspaceId) return;
      const deletedInPg = await pgRepo.deleteDatabaseConnection(
        id,
        workspaceId,
        db,
      );
      if (deletedInPg) {
        await recordMigrationTombstone(
          "database_connections",
          objectIdToUuid(id),
          db,
        );
        return;
      }
      // Only tombstone when confirmed absent from Mongo so a wrong-workspace
      // delete retry never tombstones another workspace's live connection.
      const stillInMongo = await DatabaseConnection.collection.findOne(
        { _id: new Types.ObjectId(id) },
        { projection: { _id: 1 } },
      );
      if (!stillInMongo) {
        await recordMigrationTombstone(
          "database_connections",
          objectIdToUuid(id),
          db,
        );
      }
      return;
    }

    case "createSourceConnection":
    case "updateSourceConnection":
    case "claimSourceConnectionKeyRequest":
    case "rollbackSourceConnectionKeyRequest": {
      const id = tryEntityIdToMongoHex(payload.connectionId ?? data.entityId);
      if (!id) return;
      const doc = (await SourceConnection.collection.findOne({
        _id: new Types.ObjectId(id),
      })) as unknown as MongoSourceConnectionLike | null;
      if (!doc) return;
      const row = await sourceConnectionToPgInsert(
        mongoSourceConnectionToRecord(doc),
        resolver,
      );
      await pgRepo.upsertSourceConnectionWithGuard(row, db);
      return;
    }

    case "deleteSourceConnection": {
      const id = tryEntityIdToMongoHex(payload.connectionId ?? data.entityId);
      const workspaceId = String(payload.workspaceId ?? "");
      if (!id || !workspaceId) return;
      const deletedInPg = await pgRepo.deleteSourceConnection(
        id,
        workspaceId,
        db,
      );
      if (deletedInPg) {
        await recordMigrationTombstone(
          "source_connections",
          objectIdToUuid(id),
          db,
        );
        return;
      }
      // Only tombstone when confirmed absent from Mongo so a wrong-workspace
      // delete retry never tombstones another workspace's live connection.
      const stillInMongo = await SourceConnection.collection.findOne(
        { _id: new Types.ObjectId(id) },
        { projection: { _id: 1 } },
      );
      if (!stillInMongo) {
        await recordMigrationTombstone(
          "source_connections",
          objectIdToUuid(id),
          db,
        );
      }
      return;
    }

    case "recordConnectionAccessEvent": {
      const id = tryEntityIdToMongoHex(payload.eventId ?? data.entityId);
      if (!id) return;
      const doc = (await ConnectionAccessEvent.collection.findOne({
        _id: new Types.ObjectId(id),
      })) as unknown as MongoConnectionAccessEventLike | null;
      if (!doc) return;
      const row = await accessEventToPgInsert(
        mongoAccessEventToRecord(doc),
        resolver,
      );
      await pgRepo.upsertAccessEventIgnoreConflict(row, db);
      return;
    }

    case "recordConnectionWriteEvent":
    case "recordConnectionWriteOutcome": {
      const id = tryEntityIdToMongoHex(payload.eventId ?? data.entityId);
      if (!id) return;
      const doc = (await ConnectionWriteEvent.collection.findOne({
        _id: new Types.ObjectId(id),
      })) as unknown as MongoConnectionWriteEventLike | null;
      if (!doc) return;
      const row = await writeEventToPgInsert(
        mongoWriteEventToRecord(doc),
        resolver,
      );
      await pgRepo.upsertWriteEventCoalesceOutcome(row, db);
      return;
    }

    case "upsertConnectorDefinition":
    case "recordConnectorDefinitionBuild":
    case "recordConnectorDefinitionCheckResult": {
      const workspaceId = tryEntityIdToMongoHex(payload.workspaceId);
      const slug = String(payload.slug ?? "");
      if (!workspaceId || !slug) return;
      const doc = (await ConnectorDefinition.collection.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        slug,
      })) as unknown as MongoConnectorDefinitionLike | null;
      if (!doc) return;
      const row = connectorDefinitionToPgInsert(
        mongoConnectorDefinitionToRecord(doc),
      );
      await pgRepo.upsertConnectorDefinitionWithGuard(row, db);
      return;
    }

    case "deleteConnectorDefinition": {
      const workspaceId = String(payload.workspaceId ?? "");
      const slug = String(payload.slug ?? "");
      if (!workspaceId || !slug) return;
      const pgDeletedId = await pgRepo.deleteConnectorDefinitionReturningId(
        workspaceId,
        slug,
        db,
      );
      if (pgDeletedId) {
        await recordMigrationTombstone(
          "connector_definitions",
          objectIdToUuid(pgDeletedId),
          db,
        );
      }
      const payloadDefId = tryEntityIdToMongoHex(payload.definitionId);
      if (payloadDefId && payloadDefId !== pgDeletedId) {
        const stillInMongo = await ConnectorDefinition.collection.findOne(
          { _id: new Types.ObjectId(payloadDefId) },
          { projection: { _id: 1 } },
        );
        if (!stillInMongo) {
          await recordMigrationTombstone(
            "connector_definitions",
            objectIdToUuid(payloadDefId),
            db,
          );
        }
      }
      return;
    }

    case "deleteConnectorDefinitionsNotInSlugs": {
      const workspaceId = String(payload.workspaceId ?? "");
      const keepSlugs = Array.isArray(payload.keepSlugs)
        ? payload.keepSlugs.map(String)
        : [];
      if (!workspaceId) return;
      const deleted = await pgRepo.deleteConnectorDefinitionsNotInSlugs(
        workspaceId,
        keepSlugs,
        db,
      );
      const tombstoned = new Set<string>();
      for (const wireId of deleted) {
        tombstoned.add(wireId);
        await recordMigrationTombstone(
          "connector_definitions",
          objectIdToUuid(wireId),
          db,
        );
      }
      if (Array.isArray(payload.deletedIds)) {
        for (const rawId of payload.deletedIds) {
          const hex = tryEntityIdToMongoHex(rawId);
          if (!hex || tombstoned.has(hex)) continue;
          const stillInMongo = await ConnectorDefinition.collection.findOne(
            { _id: new Types.ObjectId(hex) },
            { projection: { _id: 1 } },
          );
          if (!stillInMongo) {
            await recordMigrationTombstone(
              "connector_definitions",
              objectIdToUuid(hex),
              db,
            );
          }
        }
      }
      return;
    }

    default:
      logger.warn("Unknown connections sync-retry PG operation; skipping", {
        operation: data.operation,
        entityId: data.entityId,
      });
  }
}

export async function replayConnectionsWriteToMongo(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const mongoRepo = new MongoConnectionsRepository();
  const pgRepo = new PgConnectionsRepository({ getDb: () => db });
  const payload = data.payload ?? {};

  switch (data.operation) {
    case "createDatabaseConnection":
    case "updateDatabaseConnection":
    case "touchDatabaseConnectionLastConnected": {
      const id = String(payload.connectionId ?? data.entityId);
      const raw = await pgRepo.findDatabaseConnectionRawById(id, undefined, db);
      if (!raw) return;
      await mongoRepo.upsertDatabaseConnectionRaw({
        id: raw.record.id,
        workspaceId: raw.record.workspaceId,
        name: raw.record.name,
        type: raw.record.type,
        connectionEncrypted: raw.connectionEncrypted,
        isDemo: raw.record.isDemo,
        allowAgentWrites: raw.record.allowAgentWrites,
        writers: raw.record.writers,
        createdBy: raw.record.createdBy,
        lastConnectedAt: raw.record.lastConnectedAt,
        createdAt: raw.record.createdAt,
        updatedAt: raw.record.updatedAt,
      });
      return;
    }

    case "deleteDatabaseConnection": {
      const id = String(payload.connectionId ?? data.entityId);
      const workspaceId = String(payload.workspaceId ?? "");
      if (id && workspaceId) {
        await mongoRepo.deleteDatabaseConnection(id, workspaceId);
      }
      return;
    }

    case "createSourceConnection":
    case "updateSourceConnection":
    case "claimSourceConnectionKeyRequest":
    case "rollbackSourceConnectionKeyRequest": {
      const id = String(payload.connectionId ?? data.entityId);
      const record = await pgRepo.findSourceConnectionById(id, undefined, db);
      if (record) {
        await mongoRepo.upsertSourceConnectionFromRecord(record);
      }
      return;
    }

    case "deleteSourceConnection": {
      const id = String(payload.connectionId ?? data.entityId);
      const workspaceId = String(payload.workspaceId ?? "");
      if (id && workspaceId) {
        await mongoRepo.deleteSourceConnection(id, workspaceId);
      }
      return;
    }

    case "recordConnectionAccessEvent": {
      const id = String(payload.eventId ?? data.entityId);
      const record = await pgRepo.findConnectionAccessEventById(id, db);
      if (record) {
        await mongoRepo.upsertAccessEventFromRecord(record);
      }
      return;
    }

    case "recordConnectionWriteEvent":
    case "recordConnectionWriteOutcome": {
      const id = String(payload.eventId ?? data.entityId);
      const record = await pgRepo.findConnectionWriteEventById(id, db);
      if (record) {
        await mongoRepo.upsertWriteEventFromRecord(record);
      }
      return;
    }

    case "upsertConnectorDefinition":
    case "recordConnectorDefinitionBuild":
    case "recordConnectorDefinitionCheckResult": {
      const workspaceId = String(payload.workspaceId ?? "");
      const slug = String(payload.slug ?? "");
      if (!workspaceId || !slug) return;
      const record = await pgRepo.findConnectorDefinition(
        workspaceId,
        slug,
        db,
      );
      if (record) {
        await mongoRepo.upsertConnectorDefinitionFromRecord(record);
      }
      return;
    }

    case "deleteConnectorDefinition": {
      const workspaceId = String(payload.workspaceId ?? "");
      const slug = String(payload.slug ?? "");
      if (workspaceId && slug) {
        await mongoRepo.deleteConnectorDefinition(workspaceId, slug);
      }
      return;
    }

    case "deleteConnectorDefinitionsNotInSlugs": {
      const workspaceId = String(payload.workspaceId ?? "");
      const keepSlugs = Array.isArray(payload.keepSlugs)
        ? payload.keepSlugs.map(String)
        : [];
      if (workspaceId) {
        await mongoRepo.deleteConnectorDefinitionsNotInSlugs(
          workspaceId,
          keepSlugs,
        );
      }
      return;
    }

    default:
      logger.warn("Unknown connections sync-retry Mongo operation; skipping", {
        operation: data.operation,
        entityId: data.entityId,
      });
  }
}

/**
 * Register all Phase 2A-1 (`connections`) backfill handlers, parity verifiers,
 * Inngest sync-retry handlers, and 90-day TTL reaper rule. Idempotent.
 */
export function registerConnectionsMigrationDomain(): void {
  registerBackfillDomain(createConnectionsBackfillHandler());
  registerVerifierDomain(createConnectionsVerifierHandler());

  for (const meta of CONNECTIONS_STAGES) {
    registerBackfillDomain(createConnectionsTableBackfillHandler(meta));
    registerVerifierDomain(createConnectionsTableVerifierHandler(meta));
  }

  registerSyncRetryHandler("pg", "connections", data =>
    replayConnectionsWriteToPg(data),
  );
  registerSyncRetryHandler("mongo", "connections", data =>
    replayConnectionsWriteToMongo(data),
  );

  // 90-day TTL reaper for connection_write_events (`connection_access_events` has NO TTL!)
  registerTtlRule({
    tableName: "connection_write_events",
    timestampColumn: "at",
    olderThanMs: NINETY_DAYS_MS,
  });
}
