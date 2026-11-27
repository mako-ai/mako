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
import { and, eq, inArray, sql } from "drizzle-orm";
import { Types } from "mongoose";
import { ConnectionAccessEvent } from "../../access/connection-access-event";
import { ConnectionWriteEvent } from "../../access/connection-write-event";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
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
  extractPrincipalUserId,
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
import {
  buildExcludedSet,
  chunkRows,
  chunkValues,
  dedupByKey,
  groupContiguous,
  pickNewerByUpdatedAt,
  prefetchExistingKeySet,
  prefetchPgUserUuidMap,
} from "../bulk-helpers";
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
      summary?: DatabaseConnectionSummary;
      connectionEncrypted?: Record<string, unknown>;
      parseError?: string;
      pgRow?: NewDatabaseConnectionRow;
    }
  | {
      table: "source_connections";
      rawId: string;
      rawWorkspaceId: string;
      record?: SourceConnectionRecord;
      parseError?: string;
      pgRow?: NewSourceConnectionRow;
    }
  | {
      table: "connector_definitions";
      rawId: string;
      rawWorkspaceId: string;
      record?: ConnectorDefinitionRecord;
      parseError?: string;
      pgRow?: NewConnectorDefinitionRow;
    }
  | {
      table: "connection_access_events";
      rawId: string;
      rawWorkspaceId: string;
      rawConnectionId: string;
      record?: ConnectionAccessEventRecord;
      parseError?: string;
      pgRow?: NewConnectionAccessEventRow;
    }
  | {
      table: "connection_write_events";
      rawId: string;
      rawWorkspaceId: string;
      rawConnectionId: string;
      record?: ConnectionWriteEventRecord;
      parseError?: string;
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

function safeEntityIdFromRaw(raw: unknown): {
  rawId: string;
  entityId: string;
} {
  const rawId = rawIdString(raw);
  return {
    rawId,
    entityId: isObjectIdHex(rawId) ? objectIdToUuid(rawId) : rawId,
  };
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

function makePrefetchedUserResolver(
  userMap: ReadonlyMap<string, string>,
): UserUuidResolver {
  return (idOrLegacyId: string): string | null => {
    if (!idOrLegacyId) return null;
    return (
      userMap.get(idOrLegacyId) ??
      userMap.get(idOrLegacyId.toLowerCase()) ??
      null
    );
  };
}

function pushWriterUserIds(
  writers: ReadonlyArray<{ principal: string; addedBy?: string }> | undefined,
  out: string[],
): void {
  if (!writers) return;
  for (const w of writers) {
    const extracted = extractPrincipalUserId(w.principal);
    if (extracted) out.push(extracted.userId);
    if (w.addedBy) out.push(w.addedBy);
  }
}

function pushWriterLabelUserIds(
  labels: readonly string[] | undefined,
  out: string[],
): void {
  if (!labels) return;
  for (const label of labels) {
    const spaceIdx = label.indexOf(" ");
    const principalPart = spaceIdx === -1 ? label : label.slice(0, spaceIdx);
    const extracted = extractPrincipalUserId(principalPart);
    if (extracted) out.push(extracted.userId);
  }
}

function collectConnectionsRawUserIds(
  items: ReadonlyArray<BackfillItem<ConnectionsBackfillDoc>>,
): string[] {
  const out: string[] = [];
  for (const { doc } of items) {
    switch (doc.table) {
      case "database_connections":
        if (doc.summary) {
          if (doc.summary.createdBy) out.push(doc.summary.createdBy);
          pushWriterUserIds(doc.summary.writers, out);
        }
        break;
      case "source_connections":
        if (doc.record) {
          if (doc.record.createdBy) out.push(doc.record.createdBy);
          pushWriterUserIds(doc.record.writers, out);
          pushWriterUserIds(doc.record.liveReaders, out);
          if (doc.record.managers) {
            for (const m of doc.record.managers) {
              if (m) out.push(m);
            }
          }
          if (doc.record.keyRequest?.requestedBy) {
            out.push(doc.record.keyRequest.requestedBy);
          }
        }
        break;
      case "connector_definitions":
        break;
      case "connection_access_events":
        if (doc.record) {
          if (doc.record.actor) out.push(doc.record.actor);
          const changes = doc.record.changes;
          if (changes.writers) {
            pushWriterLabelUserIds(changes.writers.added, out);
            pushWriterLabelUserIds(changes.writers.removed, out);
          }
          if (changes.liveReaders) {
            pushWriterLabelUserIds(changes.liveReaders.added, out);
            pushWriterLabelUserIds(changes.liveReaders.removed, out);
          }
          if (changes.managers) {
            for (const id of changes.managers.added) if (id) out.push(id);
            for (const id of changes.managers.removed) if (id) out.push(id);
          }
        }
        break;
      case "connection_write_events":
        if (doc.record) {
          const extracted = extractPrincipalUserId(doc.record.principal);
          if (extracted) out.push(extracted.userId);
        }
        break;
    }
  }
  return out;
}

async function prepareConnectionsBatch(
  items: ReadonlyArray<BackfillItem<ConnectionsBackfillDoc>>,
  db: MakoPgDb,
  wsExistsCache: Map<string, boolean>,
): Promise<UserUuidResolver> {
  const wsUuids = new Set<string>();
  for (const { doc } of items) {
    if (isObjectIdHex(doc.rawWorkspaceId)) {
      const wsUuid = objectIdToUuid(doc.rawWorkspaceId).toLowerCase();
      if (!wsExistsCache.has(wsUuid)) {
        wsUuids.add(wsUuid);
      }
    }
  }
  const wsUuidList = [...wsUuids];
  const rawUserIds = collectConnectionsRawUserIds(items);

  const [foundWs, userMap] = await Promise.all([
    prefetchExistingKeySet(db, workspaces, workspaces.id, wsUuidList),
    prefetchPgUserUuidMap(db, rawUserIds),
  ]);

  for (const wsUuid of wsUuidList) {
    wsExistsCache.set(wsUuid, foundWs.has(wsUuid));
  }
  return makePrefetchedUserResolver(userMap);
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
        const { rawId, entityId } = safeEntityIdFromRaw(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        try {
          const summary = mongoDatabaseConnectionToSummary(doc);
          const connectionEncrypted = extractRawEncryptedConnection(
            doc.connection,
          );
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
        } catch (err) {
          return {
            cursor: makeCursor(rawId),
            entityId,
            targetTable: "database_connections",
            collectionName: meta.collection,
            doc: {
              table: "database_connections",
              rawId,
              rawWorkspaceId: rawWsId,
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "source_connections": {
      const docs = (await SourceConnection.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoSourceConnectionLike[];
      return docs.map(doc => {
        const { rawId, entityId } = safeEntityIdFromRaw(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        try {
          const record = mongoSourceConnectionToRecord(doc);
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
        } catch (err) {
          return {
            cursor: makeCursor(rawId),
            entityId,
            targetTable: "source_connections",
            collectionName: meta.collection,
            doc: {
              table: "source_connections",
              rawId,
              rawWorkspaceId: rawWsId,
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "connector_definitions": {
      const docs = (await ConnectorDefinition.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectorDefinitionLike[];
      return docs.map(doc => {
        const { rawId, entityId } = safeEntityIdFromRaw(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        try {
          const record = mongoConnectorDefinitionToRecord(doc);
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
        } catch (err) {
          return {
            cursor: makeCursor(rawId),
            entityId,
            targetTable: "connector_definitions",
            collectionName: meta.collection,
            doc: {
              table: "connector_definitions",
              rawId,
              rawWorkspaceId: rawWsId,
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "connection_access_events": {
      const docs = (await ConnectionAccessEvent.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectionAccessEventLike[];
      return docs.map(doc => {
        const { rawId, entityId } = safeEntityIdFromRaw(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const rawConnId = rawIdString(doc.connectionId);
        try {
          const record = mongoAccessEventToRecord(doc);
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
        } catch (err) {
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
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "connection_write_events": {
      const docs = (await ConnectionWriteEvent.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoConnectionWriteEventLike[];
      return docs.map(doc => {
        const { rawId, entityId } = safeEntityIdFromRaw(doc._id);
        const rawWsId = rawIdString(doc.workspaceId);
        const rawConnId = rawIdString(doc.connectionId);
        try {
          const record = mongoWriteEventToRecord(doc);
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
        } catch (err) {
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
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
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
  if (
    (doc.table === "connection_access_events" ||
      doc.table === "connection_write_events") &&
    !isObjectIdHex(doc.rawConnectionId)
  ) {
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
  if (doc.parseError) {
    return {
      ok: false,
      reason: `invalid_${doc.table}_document`,
      sanitizedPayload: {
        table: doc.table,
        id: doc.rawId,
        error: doc.parseError,
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
      if (!doc.summary) {
        return {
          ok: false,
          reason: "invalid_database_connections_document",
          sanitizedPayload: { table: doc.table, id: doc.rawId },
        };
      }
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
          connectionEncrypted: doc.connectionEncrypted ?? {},
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
      if (!doc.record) {
        return {
          ok: false,
          reason: "invalid_source_connections_document",
          sanitizedPayload: { table: doc.table, id: doc.rawId },
        };
      }
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
      if (!doc.record) {
        return {
          ok: false,
          reason: "invalid_connector_definitions_document",
          sanitizedPayload: { table: doc.table, id: doc.rawId },
        };
      }
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
      if (!doc.record) {
        return {
          ok: false,
          reason: "invalid_connection_access_events_document",
          sanitizedPayload: { table: doc.table, id: doc.rawId },
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
      if (!doc.record) {
        return {
          ok: false,
          reason: "invalid_connection_write_events_document",
          sanitizedPayload: { table: doc.table, id: doc.rawId },
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

  for (const group of groupContiguous(items, item => item.doc.table)) {
    switch (group.key) {
      case "database_connections": {
        const rows = dedupByKey(
          group.items
            .map(
              item =>
                (
                  item.doc as Extract<
                    ConnectionsBackfillDoc,
                    { table: "database_connections" }
                  >
                ).pgRow,
            )
            .filter((r): r is NewDatabaseConnectionRow => r !== undefined),
          r => r.id.toLowerCase(),
          pickNewerByUpdatedAt,
        );
        const setCols = buildExcludedSet(databaseConnections, [
          "id",
          "workspaceId",
          "createdAt",
        ]);
        for (const chunk of chunkRows(rows, 12, 300)) {
          const written = await db
            .insert(databaseConnections)
            .values(chunk)
            .onConflictDoUpdate({
              target: databaseConnections.id,
              set: setCols,
              setWhere: sql`${databaseConnections.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${databaseConnections.updatedAt}`,
            })
            .returning({ id: databaseConnections.id });
          upserted += written.length;
        }
        break;
      }

      case "source_connections": {
        const rows = dedupByKey(
          group.items
            .map(
              item =>
                (
                  item.doc as Extract<
                    ConnectionsBackfillDoc,
                    { table: "source_connections" }
                  >
                ).pgRow,
            )
            .filter((r): r is NewSourceConnectionRow => r !== undefined),
          r => r.id.toLowerCase(),
          pickNewerByUpdatedAt,
        );
        const setCols = buildExcludedSet(sourceConnections, [
          "id",
          "workspaceId",
          "createdAt",
        ]);
        for (const chunk of chunkRows(rows, 22, 250)) {
          const written = await db
            .insert(sourceConnections)
            .values(chunk)
            .onConflictDoUpdate({
              target: sourceConnections.id,
              set: setCols,
              setWhere: sql`${sourceConnections.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${sourceConnections.updatedAt}`,
            })
            .returning({ id: sourceConnections.id });
          upserted += written.length;
        }
        break;
      }

      case "connector_definitions": {
        const rawRows = group.items
          .map(
            item =>
              (
                item.doc as Extract<
                  ConnectionsBackfillDoc,
                  { table: "connector_definitions" }
                >
              ).pgRow,
          )
          .filter((r): r is NewConnectorDefinitionRow => r !== undefined);
        const rows = dedupByKey(
          dedupByKey(rawRows, r => r.id.toLowerCase(), pickNewerByUpdatedAt),
          r => `${r.workspaceId.toLowerCase()}\0${r.slug}`,
          pickNewerByUpdatedAt,
        );
        if (rows.length === 0) break;

        // Prefetch existing (workspace_id, slug) rows so delete+recreate PK
        // reconciliation matches `upsertConnectorDefinitionWithGuard` exactly.
        const wsUuids = [
          ...new Set(rows.map(r => r.workspaceId.toLowerCase())),
        ];
        const slugs = [...new Set(rows.map(r => r.slug))];
        const existingBySlug = new Map<string, string>();
        for (const wsChunk of chunkValues(wsUuids)) {
          for (const slugChunk of chunkValues(slugs)) {
            const existing = await db
              .select({
                id: connectorDefinitions.id,
                workspaceId: connectorDefinitions.workspaceId,
                slug: connectorDefinitions.slug,
              })
              .from(connectorDefinitions)
              .where(
                and(
                  inArray(connectorDefinitions.workspaceId, wsChunk),
                  inArray(connectorDefinitions.slug, slugChunk),
                ),
              );
            for (const row of existing) {
              existingBySlug.set(
                `${row.workspaceId.toLowerCase()}\0${row.slug}`,
                row.id.toLowerCase(),
              );
            }
          }
        }

        const bulkRows: NewConnectorDefinitionRow[] = [];
        const collidingRows: NewConnectorDefinitionRow[] = [];
        for (const row of rows) {
          const existingId = existingBySlug.get(
            `${row.workspaceId.toLowerCase()}\0${row.slug}`,
          );
          if (existingId && existingId !== row.id.toLowerCase()) {
            collidingRows.push(row);
          } else {
            bulkRows.push(row);
          }
        }

        const setCols = buildExcludedSet(connectorDefinitions, [
          "id",
          "workspaceId",
          "createdAt",
        ]);
        for (const chunk of chunkRows(bulkRows, 20, 250)) {
          const written = await db
            .insert(connectorDefinitions)
            .values(chunk)
            .onConflictDoUpdate({
              target: connectorDefinitions.id,
              set: setCols,
              setWhere: sql`${connectorDefinitions.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${connectorDefinitions.updatedAt}`,
            })
            .returning({ id: connectorDefinitions.id });
          upserted += written.length;
        }
        for (const row of collidingRows) {
          if (await pgRepo.upsertConnectorDefinitionWithGuard(row, db)) {
            upserted += 1;
          }
        }
        break;
      }

      case "connection_access_events": {
        const rows = dedupByKey(
          group.items
            .map(
              item =>
                (
                  item.doc as Extract<
                    ConnectionsBackfillDoc,
                    { table: "connection_access_events" }
                  >
                ).pgRow,
            )
            .filter((r): r is NewConnectionAccessEventRow => r !== undefined),
          r => r.id.toLowerCase(),
          existing => existing,
        );
        for (const chunk of chunkRows(rows, 9, 400)) {
          const written = await db
            .insert(connectionAccessEvents)
            .values(chunk)
            .onConflictDoNothing({ target: connectionAccessEvents.id })
            .returning({ id: connectionAccessEvents.id });
          upserted += written.length;
        }
        break;
      }

      case "connection_write_events": {
        const rows = dedupByKey(
          group.items
            .map(
              item =>
                (
                  item.doc as Extract<
                    ConnectionsBackfillDoc,
                    { table: "connection_write_events" }
                  >
                ).pgRow,
            )
            .filter((r): r is NewConnectionWriteEventRow => r !== undefined),
          r => r.id.toLowerCase(),
          (existing, incoming) => ({
            ...existing,
            status: existing.status ?? incoming.status ?? null,
            error: existing.error ?? incoming.error ?? null,
          }),
        );
        for (const chunk of chunkRows(rows, 10, 400)) {
          const written = await db
            .insert(connectionWriteEvents)
            .values(chunk)
            .onConflictDoUpdate({
              target: connectionWriteEvents.id,
              set: {
                status: sql`COALESCE(${connectionWriteEvents.status}, EXCLUDED."status")`,
                error: sql`COALESCE(${connectionWriteEvents.error}, EXCLUDED."error")`,
              },
            })
            .returning({ id: connectionWriteEvents.id });
          upserted += written.length;
        }
        break;
      }
    }
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
    async prepareBatch(items, db) {
      batchResolver = await prepareConnectionsBatch(items, db, wsExistsCache);
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
    async prepareBatch(items, db) {
      batchResolver = await prepareConnectionsBatch(items, db, wsExistsCache);
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
  let expectedRecord: unknown = null;

  const canConvert =
    !doc.parseError &&
    isObjectIdHex(doc.rawId) &&
    isObjectIdHex(doc.rawWorkspaceId) &&
    (doc.table === "connection_access_events" ||
    doc.table === "connection_write_events"
      ? isObjectIdHex(doc.rawConnectionId)
      : true);

  if (canConvert) {
    try {
      switch (doc.table) {
        case "database_connections": {
          if (!doc.summary) break;
          const pgRow = await databaseConnectionToPgInsert(
            {
              id: doc.summary.id,
              workspaceId: doc.summary.workspaceId,
              name: doc.summary.name,
              type: doc.summary.type,
              connectionEncrypted: doc.connectionEncrypted ?? {},
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
          if (!doc.record) break;
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
          if (!doc.record) break;
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
          if (!doc.record) break;
          const pgRow = await accessEventToPgInsert(
            doc.record,
            resolveUserUuid,
          );
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
          if (!doc.record) break;
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
    } catch {
      expectedRecord = null;
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
  try {
    const oidHex = parseEntityId(pgEntityId)?.oid;
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
        const connectionEncrypted = extractRawEncryptedConnection(
          doc.connection,
        );
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
        const record = mongoSourceConnectionToRecord(doc);
        if (!record.name || !record.type) return false;
        const row = await sourceConnectionToPgInsert(record, resolver);
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
  } catch {
    return false;
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

      const userMap = await prefetchPgUserUuidMap(
        db,
        collectConnectionsRawUserIds(items),
      );
      const resolver = makePrefetchedUserResolver(userMap);
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
      const userMap = await prefetchPgUserUuidMap(
        db,
        collectConnectionsRawUserIds(items),
      );
      const resolver = makePrefetchedUserResolver(userMap);
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
    case "updateConnectorDefinitionMetadata":
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
      if (!workspaceId) return;
      const payloadDefId = tryEntityIdToMongoHex(payload.definitionId);
      if (payloadDefId) {
        // Delete and tombstone strictly by definitionId (PK) so a delayed retry
        // never wipes or tombstones a newer definition that reused the slug.
        const stillInMongo = await ConnectorDefinition.collection.findOne(
          { _id: new Types.ObjectId(payloadDefId) },
          { projection: { _id: 1 } },
        );
        if (stillInMongo) return;
        await pgRepo.deleteConnectorDefinitionById(
          payloadDefId,
          workspaceId,
          db,
        );
        await recordMigrationTombstone(
          "connector_definitions",
          objectIdToUuid(payloadDefId),
          db,
        );
        return;
      }
      // Legacy fallback without definitionId: confirm the slug is absent from
      // Mongo before deleting from PG so a re-indexed definition survives.
      const wsHex = tryEntityIdToMongoHex(workspaceId);
      if (!wsHex || !slug) return;
      const slugInMongo = await ConnectorDefinition.collection.findOne(
        { workspaceId: new Types.ObjectId(wsHex), slug: slug.trim() },
        { projection: { _id: 1 } },
      );
      if (slugInMongo) return;
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
      return;
    }

    case "deleteConnectorDefinitionsNotInSlugs": {
      const workspaceId = String(payload.workspaceId ?? "");
      if (!workspaceId) return;
      // Delete and tombstone strictly the captured deletedIds (after confirming
      // each is absent from Mongo) instead of re-evaluating keepSlugs against
      // live PG state, which would wipe definitions created after the call.
      const rawDeletedIds = Array.isArray(payload.deletedIds)
        ? payload.deletedIds
        : [];
      const candidateHexIds = [
        ...new Set(
          rawDeletedIds
            .map(tryEntityIdToMongoHex)
            .filter((v): v is string => v !== null),
        ),
      ];
      if (candidateHexIds.length === 0) return;

      const stillInMongoDocs = await ConnectorDefinition.collection
        .find(
          {
            _id: {
              $in: candidateHexIds.map(hex => new Types.ObjectId(hex)),
            },
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      const stillInMongoSet = new Set(
        stillInMongoDocs.map(d => rawIdString(d._id).toLowerCase()),
      );
      const confirmedAbsent = candidateHexIds.filter(
        hex => !stillInMongoSet.has(hex.toLowerCase()),
      );
      if (confirmedAbsent.length === 0) return;

      await pgRepo.deleteConnectorDefinitionsByIds(
        confirmedAbsent,
        workspaceId,
        db,
      );
      for (const hex of confirmedAbsent) {
        await recordMigrationTombstone(
          "connector_definitions",
          objectIdToUuid(hex),
          db,
        );
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
    case "updateConnectorDefinitionMetadata":
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
      if (!workspaceId) return;
      const payloadDefId = tryEntityIdToMongoHex(payload.definitionId);
      if (payloadDefId) {
        const stillInPg = await pgRepo.findConnectorDefinitionById(
          payloadDefId,
          db,
        );
        if (stillInPg) return;
        await mongoRepo.deleteConnectorDefinitionById(
          payloadDefId,
          workspaceId,
        );
        return;
      }
      if (!slug) return;
      const slugInPg = await pgRepo.findConnectorDefinition(
        workspaceId,
        slug,
        db,
      );
      if (slugInPg) return;
      await mongoRepo.deleteConnectorDefinition(workspaceId, slug);
      return;
    }

    case "deleteConnectorDefinitionsNotInSlugs": {
      const workspaceId = String(payload.workspaceId ?? "");
      if (!workspaceId) return;
      const rawDeletedIds = Array.isArray(payload.deletedIds)
        ? payload.deletedIds
        : [];
      const candidateHexIds = [
        ...new Set(
          rawDeletedIds
            .map(tryEntityIdToMongoHex)
            .filter((v): v is string => v !== null),
        ),
      ];
      if (candidateHexIds.length === 0) return;

      const stillInPgIds = await pgRepo.findExistingConnectorDefinitionIds(
        candidateHexIds,
        db,
      );
      const stillInPgSet = new Set(stillInPgIds.map(id => id.toLowerCase()));
      const confirmedAbsent = candidateHexIds.filter(
        hex => !stillInPgSet.has(hex.toLowerCase()),
      );
      if (confirmedAbsent.length === 0) return;

      await mongoRepo.deleteConnectorDefinitionsByIds(
        confirmedAbsent,
        workspaceId,
      );
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
