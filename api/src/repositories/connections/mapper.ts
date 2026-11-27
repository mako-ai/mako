/**
 * Bidirectional MongoDB <-> Postgres <-> DTO mappers + user-ID principal rewriting
 * for the Phase 2A-1 `connections` domain (5 tables).
 */
import type { Types } from "mongoose";
import {
  isObjectIdHex,
  objectIdToUuid,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import type {
  ConnectionAccessChangesJson,
  ConnectionAccessEventRow,
  ConnectionAccessKind,
  ConnectionAccessVia,
  ConnectionWriteEventRow,
  ConnectionWriterJson,
  ConnectorDefinitionBuildJson,
  ConnectorDefinitionRegistryJson,
  ConnectorDefinitionRow,
  ConnectorDefinitionStatus,
  DatabaseConnectionRow,
  DatabaseConnectionType,
  NewConnectionAccessEventRow,
  NewConnectionWriteEventRow,
  NewConnectorDefinitionRow,
  NewDatabaseConnectionRow,
  NewSourceConnectionRow,
  SourceConnectionRow,
  SourceConnectionSettingsJson,
} from "../../database/pg/schema/connections";
import { decryptConnectionObject } from "./crypto";
import type {
  ConnectionAccessEventRecord,
  ConnectionWriteEventRecord,
  ConnectionWriterRecord,
  ConnectorDefinitionBuildRecord,
  ConnectorDefinitionRecord,
  ConnectorDefinitionRegistryRecord,
  DatabaseConnectionConfig,
  DatabaseConnectionRecord,
  DatabaseConnectionSummary,
  SourceConnectionRecord,
} from "./types";

export type UserUuidResolver = (
  idOrLegacyId: string,
) => Promise<string | null> | string | null;

export function coerceDate(
  value: Date | string | number | null | undefined,
  fallback?: Date,
): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? (fallback ?? new Date(0)) : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback ?? new Date(0);
}

export function coerceOptionalDate(
  value: Date | string | number | null | undefined,
): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = coerceDate(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function entityIdToPgUuid(id: string | Types.ObjectId): string {
  const raw = typeof id === "string" ? id : id.toString();
  const parsed = parseEntityId(raw);
  if (!parsed) {
    throw new Error(`Invalid entity ID: ${JSON.stringify(raw)}`);
  }
  return parsed.uuid;
}

export function entityIdToMongoHex(id: string | Types.ObjectId): string {
  const raw = typeof id === "string" ? id : id.toString();
  if (isObjectIdHex(raw)) return raw.toLowerCase();
  return toWireId(raw);
}

export function stripUndefinedDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map(item => stripUndefinedDeep(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

// ── User-ID principal rewriting (Decision #3 & #35 §2.4) ─────────────────────

const USER_PRINCIPAL_PREFIXES = [
  "dry-run:agent:user:",
  "dry-run:user:",
  "agent:user:",
  "user:",
] as const;

/**
 * Extract the raw user ID from a `user:<id>`, `agent:user:<id>`, `dry-run:user:<id>`,
 * or `dry-run:agent:user:<id>` principal. Returns `null` for non-user principals
 * (`workflow:*`, `workflow:<name>`, `worker:workflows`, etc.).
 */
export function extractPrincipalUserId(principal: string): {
  prefix: string;
  userId: string;
} | null {
  for (const prefix of USER_PRINCIPAL_PREFIXES) {
    if (principal.startsWith(prefix)) {
      const userId = principal.slice(prefix.length);
      if (userId.length > 0) {
        return { prefix, userId };
      }
    }
  }
  return null;
}

/**
 * Rewrite `user:<legacyId>`, `agent:user:<legacyId>`, `dry-run:user:<legacyId>`,
 * and `dry-run:agent:user:<legacyId>` to their PG user UUIDv7 when resolvable.
 * Non-user principals (`workflow:*`, `worker:workflows`, etc.) pass through unchanged.
 */
export async function rewritePrincipalForPg(
  principal: string,
  resolveUserUuid: UserUuidResolver,
): Promise<{ principal: string; actorUserId: string | null }> {
  const extracted = extractPrincipalUserId(principal);
  if (!extracted) {
    return { principal, actorUserId: null };
  }
  const resolved = await resolveUserUuid(extracted.userId);
  if (!resolved) {
    return { principal, actorUserId: null };
  }
  return {
    principal: `${extracted.prefix}${resolved}`,
    actorUserId: resolved,
  };
}

/**
 * Rewrite a writer label (`"user:<id>"` or `"user:<id> schema.table"`) for Postgres.
 */
export async function rewriteWriterLabelForPg(
  label: string,
  resolveUserUuid: UserUuidResolver,
): Promise<string> {
  const spaceIdx = label.indexOf(" ");
  const principalPart = spaceIdx === -1 ? label : label.slice(0, spaceIdx);
  const suffix = spaceIdx === -1 ? "" : label.slice(spaceIdx);
  const rewritten = await rewritePrincipalForPg(principalPart, resolveUserUuid);
  return `${rewritten.principal}${suffix}`;
}

export function normalizeWriters(
  raw:
    | ReadonlyArray<{
        principal: string;
        where?: string | null;
        addedBy?: string | null;
        addedAt?: Date | string | null;
      }>
    | null
    | undefined,
): ConnectionWriterRecord[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  return raw.map(w => {
    const entry: ConnectionWriterRecord = {
      principal: String(w.principal),
    };
    if (typeof w.where === "string" && w.where.length > 0) {
      entry.where = w.where;
    }
    if (typeof w.addedBy === "string" && w.addedBy.length > 0) {
      entry.addedBy = w.addedBy;
    }
    const addedAt = coerceOptionalDate(w.addedAt);
    if (addedAt) {
      entry.addedAt = addedAt;
    }
    return entry;
  });
}

export async function writersToPgJson(
  writers: readonly ConnectionWriterRecord[] | null | undefined,
  resolveUserUuid: UserUuidResolver,
): Promise<ConnectionWriterJson[] | null> {
  if (writers === null || writers === undefined) return null;
  const out: ConnectionWriterJson[] = [];
  for (const w of writers) {
    const rewrittenPrincipal = (
      await rewritePrincipalForPg(w.principal, resolveUserUuid)
    ).principal;
    const entry: ConnectionWriterJson = {
      principal: rewrittenPrincipal,
    };
    if (w.where !== undefined && w.where.length > 0) {
      entry.where = w.where;
    }
    if (w.addedBy !== undefined && w.addedBy.length > 0) {
      const mappedAddedBy = await resolveUserUuid(w.addedBy);
      entry.addedBy = mappedAddedBy ?? w.addedBy;
    }
    if (w.addedAt !== undefined) {
      entry.addedAt = coerceDate(w.addedAt).toISOString();
    }
    out.push(entry);
  }
  return out;
}

export function pgJsonToWriters(
  raw: readonly ConnectionWriterJson[] | null | undefined,
): ConnectionWriterRecord[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  return normalizeWriters(raw);
}

export async function managersToPgUuids(
  managers: readonly string[] | null | undefined,
  resolveUserUuid: UserUuidResolver,
): Promise<string[] | null> {
  if (managers === null || managers === undefined) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of managers) {
    if (!m) continue;
    const resolved = await resolveUserUuid(m);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export async function rewriteAccessChangesForPg(
  changes: ConnectionAccessChangesJson,
  resolveUserUuid: UserUuidResolver,
): Promise<ConnectionAccessChangesJson> {
  const out: ConnectionAccessChangesJson = {};

  if (changes.writers) {
    out.writers = {
      added: await Promise.all(
        changes.writers.added.map(l =>
          rewriteWriterLabelForPg(l, resolveUserUuid),
        ),
      ),
      removed: await Promise.all(
        changes.writers.removed.map(l =>
          rewriteWriterLabelForPg(l, resolveUserUuid),
        ),
      ),
    };
  }

  if (changes.liveReaders) {
    out.liveReaders = {
      added: await Promise.all(
        changes.liveReaders.added.map(l =>
          rewriteWriterLabelForPg(l, resolveUserUuid),
        ),
      ),
      removed: await Promise.all(
        changes.liveReaders.removed.map(l =>
          rewriteWriterLabelForPg(l, resolveUserUuid),
        ),
      ),
      ...(changes.liveReaders.everyone !== undefined
        ? { everyone: changes.liveReaders.everyone }
        : {}),
      ...(changes.liveReaders.limited !== undefined
        ? { limited: changes.liveReaders.limited }
        : {}),
    };
  }

  if (changes.managers) {
    out.managers = {
      added: await Promise.all(
        changes.managers.added.map(
          async id => (await resolveUserUuid(id)) ?? id,
        ),
      ),
      removed: await Promise.all(
        changes.managers.removed.map(
          async id => (await resolveUserUuid(id)) ?? id,
        ),
      ),
    };
  }

  if (changes.liveReads !== undefined) {
    out.liveReads = changes.liveReads;
  }
  if (changes.agentWrites !== undefined) {
    out.agentWrites = changes.agentWrites;
  }

  return out;
}

// ── 1. database_connections ──────────────────────────────────────────────────

export interface MongoDatabaseConnectionLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  name: string;
  type: DatabaseConnectionType;
  connection?: unknown;
  isDemo?: boolean | null;
  allowAgentWrites?: boolean | null;
  writers?: Array<{
    principal: string;
    where?: string | null;
    addedBy?: string | null;
    addedAt?: Date | string | null;
  }> | null;
  createdBy?: string | null;
  lastConnectedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoDatabaseConnectionToSummary(
  doc: MongoDatabaseConnectionLike,
): DatabaseConnectionSummary {
  const id = entityIdToMongoHex(doc._id);
  const createdAt = coerceDate(doc.createdAt);
  const updatedAt = coerceDate(doc.updatedAt, createdAt);
  const summary: DatabaseConnectionSummary = {
    id,
    _id: id,
    workspaceId: entityIdToMongoHex(doc.workspaceId),
    name: String(doc.name ?? ""),
    type: doc.type,
    isDemo: Boolean(doc.isDemo),
    allowAgentWrites: Boolean(doc.allowAgentWrites),
    createdBy: doc.createdBy ? String(doc.createdBy) : "system",
    createdAt,
    updatedAt,
  };
  const writers = normalizeWriters(doc.writers);
  if (writers !== undefined) summary.writers = writers;
  const lastConnectedAt = coerceOptionalDate(doc.lastConnectedAt);
  if (lastConnectedAt) summary.lastConnectedAt = lastConnectedAt;
  return summary;
}

export function mongoDatabaseConnectionToRecord(
  doc: MongoDatabaseConnectionLike,
  options: { alreadyDecrypted?: boolean } = {},
): DatabaseConnectionRecord {
  const summary = mongoDatabaseConnectionToSummary(doc);
  const connection: DatabaseConnectionConfig = options.alreadyDecrypted
    ? ((doc.connection &&
      typeof doc.connection === "object" &&
      !Array.isArray(doc.connection)
        ? doc.connection
        : {}) as DatabaseConnectionConfig)
    : (decryptConnectionObject(doc.connection) as DatabaseConnectionConfig);
  return {
    ...summary,
    connection,
  };
}

export function pgDatabaseConnectionToSummary(
  row: DatabaseConnectionRow,
): DatabaseConnectionSummary {
  const id = toWireId(row.id);
  const summary: DatabaseConnectionSummary = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    type: row.type,
    isDemo: row.isDemo,
    allowAgentWrites: row.allowAgentWrites,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "system",
    createdAt: coerceDate(row.createdAt),
    updatedAt: coerceDate(row.updatedAt),
  };
  const writers = pgJsonToWriters(row.writers);
  if (writers !== undefined) summary.writers = writers;
  if (row.lastConnectedAt) {
    summary.lastConnectedAt = coerceDate(row.lastConnectedAt);
  }
  return summary;
}

export function pgDatabaseConnectionToRecord(
  row: DatabaseConnectionRow,
): DatabaseConnectionRecord {
  return {
    ...pgDatabaseConnectionToSummary(row),
    connection: decryptConnectionObject(
      row.connectionEncrypted,
    ) as DatabaseConnectionConfig,
  };
}

export async function databaseConnectionToPgInsert(
  doc: {
    id: string;
    workspaceId: string;
    name: string;
    type: DatabaseConnectionType;
    connectionEncrypted: Record<string, unknown>;
    isDemo: boolean;
    allowAgentWrites: boolean;
    writers?: ConnectionWriterRecord[];
    createdBy?: string | null;
    lastConnectedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  },
  resolveUserUuid: UserUuidResolver,
): Promise<NewDatabaseConnectionRow> {
  const createdByUuid = doc.createdBy
    ? await resolveUserUuid(doc.createdBy)
    : null;
  const writersJson = await writersToPgJson(doc.writers, resolveUserUuid);
  return {
    id: entityIdToPgUuid(doc.id),
    workspaceId: entityIdToPgUuid(doc.workspaceId),
    name: doc.name,
    type: doc.type,
    connectionEncrypted: stripUndefinedDeep(doc.connectionEncrypted),
    isDemo: doc.isDemo,
    allowAgentWrites: doc.allowAgentWrites,
    writers: writersJson,
    createdBy: createdByUuid,
    lastConnectedAt: doc.lastConnectedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── 2. source_connections ────────────────────────────────────────────────────

export interface MongoSourceConnectionLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  name: string;
  type: string;
  description?: string | null;
  config?: Record<string, unknown> | null;
  settings?: {
    sync_batch_size?: number;
    rate_limit_delay_ms?: number;
    max_retries?: number;
    timeout_ms?: number;
    timezone?: string;
  } | null;
  targetDatabases?: Array<Types.ObjectId | string> | null;
  writers?: Array<{
    principal: string;
    where?: string | null;
    addedBy?: string | null;
    addedAt?: Date | string | null;
  }> | null;
  liveReads?: boolean | null;
  liveReaders?: Array<{
    principal: string;
    where?: string | null;
    addedBy?: string | null;
    addedAt?: Date | string | null;
  }> | null;
  managers?: string[] | null;
  createdBy?: string | null;
  lastSyncedAt?: Date | string | null;
  isActive?: boolean | null;
  keyRequest?: {
    tokenHash: string;
    expiresAt: Date | string;
    fields: string[];
    requestedBy?: string | null;
    createdAt: Date | string;
  } | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function normalizeSourceSettings(
  raw: MongoSourceConnectionLike["settings"],
): SourceConnectionSettingsJson {
  const out: SourceConnectionSettingsJson = {
    sync_batch_size:
      typeof raw?.sync_batch_size === "number" ? raw.sync_batch_size : 100,
    rate_limit_delay_ms:
      typeof raw?.rate_limit_delay_ms === "number"
        ? raw.rate_limit_delay_ms
        : 200,
  };
  if (typeof raw?.max_retries === "number") out.max_retries = raw.max_retries;
  if (typeof raw?.timeout_ms === "number") out.timeout_ms = raw.timeout_ms;
  if (typeof raw?.timezone === "string" && raw.timezone.length > 0) {
    out.timezone = raw.timezone;
  }
  return out;
}

export function mongoSourceConnectionToRecord(
  doc: MongoSourceConnectionLike,
): SourceConnectionRecord {
  const id = entityIdToMongoHex(doc._id);
  const createdAt = coerceDate(doc.createdAt);
  const updatedAt = coerceDate(doc.updatedAt, createdAt);
  const record: SourceConnectionRecord = {
    id,
    _id: id,
    workspaceId: entityIdToMongoHex(doc.workspaceId),
    name: String(doc.name ?? ""),
    type: String(doc.type ?? ""),
    config:
      doc.config && typeof doc.config === "object" && !Array.isArray(doc.config)
        ? stripUndefinedDeep({ ...doc.config })
        : {},
    settings: normalizeSourceSettings(doc.settings),
    targetDatabases: Array.isArray(doc.targetDatabases)
      ? doc.targetDatabases.map(entityIdToMongoHex)
      : [],
    liveReads: doc.liveReads === true,
    createdBy: doc.createdBy ? String(doc.createdBy) : "system",
    isActive: doc.isActive !== false,
    createdAt,
    updatedAt,
  };
  if (typeof doc.description === "string") {
    record.description = doc.description;
  }
  const writers = normalizeWriters(doc.writers);
  if (writers !== undefined) record.writers = writers;
  // CRITICAL: preserve undefined vs [] for liveReaders!
  const liveReaders = normalizeWriters(doc.liveReaders);
  if (liveReaders !== undefined) record.liveReaders = liveReaders;
  if (Array.isArray(doc.managers)) {
    record.managers = doc.managers.map(String);
  }
  const lastSyncedAt = coerceOptionalDate(doc.lastSyncedAt);
  if (lastSyncedAt) record.lastSyncedAt = lastSyncedAt;
  if (doc.keyRequest && doc.keyRequest.tokenHash) {
    record.keyRequest = {
      tokenHash: String(doc.keyRequest.tokenHash),
      expiresAt: coerceDate(doc.keyRequest.expiresAt),
      fields: Array.isArray(doc.keyRequest.fields)
        ? doc.keyRequest.fields.map(String)
        : [],
      requestedBy: doc.keyRequest.requestedBy
        ? String(doc.keyRequest.requestedBy)
        : "system",
      createdAt: coerceDate(doc.keyRequest.createdAt),
    };
  }
  return record;
}

export function pgSourceConnectionToRecord(
  row: SourceConnectionRow,
): SourceConnectionRecord {
  const id = toWireId(row.id);
  const record: SourceConnectionRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    type: row.type,
    config:
      row.configEncrypted &&
      typeof row.configEncrypted === "object" &&
      !Array.isArray(row.configEncrypted)
        ? { ...row.configEncrypted }
        : {},
    settings: normalizeSourceSettings(row.settings),
    targetDatabases: (row.targetDatabaseIds ?? []).map(toWireId),
    liveReads: row.liveReads,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "system",
    isActive: row.isActive,
    createdAt: coerceDate(row.createdAt),
    updatedAt: coerceDate(row.updatedAt),
  };
  if (row.description !== null && row.description !== undefined) {
    record.description = row.description;
  }
  const writers = pgJsonToWriters(row.writers);
  if (writers !== undefined) record.writers = writers;
  // CRITICAL: NULL -> undefined (everyone reads live); [] -> [] (writers only)
  const liveReaders = pgJsonToWriters(row.liveReaders);
  if (liveReaders !== undefined) record.liveReaders = liveReaders;
  if (row.managers !== null && row.managers !== undefined) {
    record.managers = row.managers.map(m => m.toLowerCase());
  }
  if (row.lastSyncedAt) {
    record.lastSyncedAt = coerceDate(row.lastSyncedAt);
  }
  if (
    row.keyRequestTokenHash !== null &&
    row.keyRequestExpiresAt !== null &&
    row.keyRequestFields !== null &&
    row.keyRequestCreatedAt !== null
  ) {
    record.keyRequest = {
      tokenHash: row.keyRequestTokenHash,
      expiresAt: coerceDate(row.keyRequestExpiresAt),
      fields: [...row.keyRequestFields],
      requestedBy: row.keyRequestRequestedBy
        ? row.keyRequestRequestedBy.toLowerCase()
        : "system",
      createdAt: coerceDate(row.keyRequestCreatedAt),
    };
  }
  return record;
}

export async function sourceConnectionToPgInsert(
  record: SourceConnectionRecord,
  resolveUserUuid: UserUuidResolver,
): Promise<NewSourceConnectionRow> {
  const createdByUuid = record.createdBy
    ? await resolveUserUuid(record.createdBy)
    : null;
  const writersJson = await writersToPgJson(record.writers, resolveUserUuid);
  const liveReadersJson = await writersToPgJson(
    record.liveReaders,
    resolveUserUuid,
  );
  const managersUuids = await managersToPgUuids(
    record.managers,
    resolveUserUuid,
  );
  const keyReqRequestedByUuid = record.keyRequest?.requestedBy
    ? await resolveUserUuid(record.keyRequest.requestedBy)
    : null;

  const targetDatabaseIds: string[] = [];
  for (const tid of record.targetDatabases ?? []) {
    try {
      targetDatabaseIds.push(entityIdToPgUuid(tid));
    } catch {
      // Skip malformed legacy targetDatabase IDs
    }
  }

  return {
    id: entityIdToPgUuid(record.id),
    workspaceId: entityIdToPgUuid(record.workspaceId),
    name: record.name,
    type: record.type,
    description: record.description ?? null,
    configEncrypted: stripUndefinedDeep(record.config ?? {}),
    settings: normalizeSourceSettings(record.settings),
    targetDatabaseIds,
    writers: writersJson,
    liveReads: record.liveReads,
    liveReaders: liveReadersJson,
    managers: managersUuids,
    createdBy: createdByUuid,
    lastSyncedAt: record.lastSyncedAt ?? null,
    isActive: record.isActive,
    keyRequestTokenHash: record.keyRequest?.tokenHash ?? null,
    keyRequestExpiresAt: record.keyRequest?.expiresAt ?? null,
    keyRequestFields: record.keyRequest ? [...record.keyRequest.fields] : null,
    keyRequestRequestedBy: record.keyRequest ? keyReqRequestedByUuid : null,
    keyRequestCreatedAt: record.keyRequest?.createdAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ── 3. connection_access_events ──────────────────────────────────────────────

export interface MongoConnectionAccessEventLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  connectionId: Types.ObjectId | string;
  kind: ConnectionAccessKind;
  actor: string;
  via: ConnectionAccessVia;
  changes: ConnectionAccessChangesJson;
  at?: Date | string;
}

export function mongoAccessEventToRecord(
  doc: MongoConnectionAccessEventLike,
): ConnectionAccessEventRecord {
  const id = entityIdToMongoHex(doc._id);
  return {
    id,
    _id: id,
    workspaceId: entityIdToMongoHex(doc.workspaceId),
    connectionId: entityIdToMongoHex(doc.connectionId),
    kind: doc.kind,
    actor: String(doc.actor ?? "unknown"),
    via: doc.via,
    changes: stripUndefinedDeep(doc.changes ?? {}),
    at: coerceDate(doc.at),
  };
}

export function pgAccessEventToRecord(
  row: ConnectionAccessEventRow,
): ConnectionAccessEventRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    connectionId: toWireId(row.connectionId),
    kind: row.kind,
    actor: row.actorUserId
      ? row.actorUserId.toLowerCase()
      : (row.actorRaw ?? "unknown"),
    via: row.via,
    changes: stripUndefinedDeep(row.changes ?? {}),
    at: coerceDate(row.at),
  };
}

export async function accessEventToPgInsert(
  record: ConnectionAccessEventRecord,
  resolveUserUuid: UserUuidResolver,
): Promise<NewConnectionAccessEventRow> {
  const actorUserId = record.actor ? await resolveUserUuid(record.actor) : null;
  const changes = await rewriteAccessChangesForPg(
    record.changes,
    resolveUserUuid,
  );
  return {
    id: entityIdToPgUuid(record.id),
    workspaceId: entityIdToPgUuid(record.workspaceId),
    connectionId: entityIdToPgUuid(record.connectionId),
    kind: record.kind,
    actorUserId,
    actorRaw: actorUserId ? null : record.actor || "unknown",
    via: record.via,
    changes: stripUndefinedDeep(changes),
    at: record.at,
  };
}

// ── 4. connection_write_events ───────────────────────────────────────────────

export interface MongoConnectionWriteEventLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  connectionId: Types.ObjectId | string;
  principal: string;
  target?: string | null;
  allowed: boolean;
  status?: number | null;
  error?: string | null;
  at?: Date | string;
}

export function mongoWriteEventToRecord(
  doc: MongoConnectionWriteEventLike,
): ConnectionWriteEventRecord {
  const id = entityIdToMongoHex(doc._id);
  const record: ConnectionWriteEventRecord = {
    id,
    _id: id,
    workspaceId: entityIdToMongoHex(doc.workspaceId),
    connectionId: entityIdToMongoHex(doc.connectionId),
    principal: String(doc.principal ?? ""),
    allowed: Boolean(doc.allowed),
    at: coerceDate(doc.at),
  };
  if (typeof doc.target === "string") record.target = doc.target;
  if (typeof doc.status === "number") record.status = doc.status;
  if (typeof doc.error === "string") record.error = doc.error;
  return record;
}

export function pgWriteEventToRecord(
  row: ConnectionWriteEventRow,
): ConnectionWriteEventRecord {
  const id = toWireId(row.id);
  const record: ConnectionWriteEventRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    connectionId: toWireId(row.connectionId),
    principal: row.principal,
    allowed: row.allowed,
    at: coerceDate(row.at),
  };
  if (row.target !== null && row.target !== undefined) {
    record.target = row.target;
  }
  if (row.status !== null && row.status !== undefined) {
    record.status = row.status;
  }
  if (row.error !== null && row.error !== undefined) {
    record.error = row.error;
  }
  return record;
}

export async function writeEventToPgInsert(
  record: ConnectionWriteEventRecord,
  resolveUserUuid: UserUuidResolver,
): Promise<NewConnectionWriteEventRow> {
  const { principal, actorUserId } = await rewritePrincipalForPg(
    record.principal,
    resolveUserUuid,
  );
  return {
    id: entityIdToPgUuid(record.id),
    workspaceId: entityIdToPgUuid(record.workspaceId),
    connectionId: entityIdToPgUuid(record.connectionId),
    principal,
    actorUserId,
    target: record.target ?? null,
    allowed: record.allowed,
    status: record.status ?? null,
    error: record.error ?? null,
    at: record.at,
  };
}

// ── 5. connector_definitions ─────────────────────────────────────────────────

export interface MongoConnectorDefinitionLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  slug: string;
  runtime?: string | null;
  entry?: string | null;
  sha: string;
  sourceSha: string;
  spec?: Record<string, unknown> | null;
  status?: ConnectorDefinitionStatus | null;
  blockedReason?: string | null;
  indexRetryAttempts?: number | null;
  nextIndexRetryAt?: Date | string | null;
  entities?: string[] | null;
  hasIcon?: boolean | null;
  lastCheckedAt?: Date | string | null;
  lastCheckError?: string | null;
  build?: {
    status: "built" | "failed";
    hash: string;
    error?: string | null;
    bytes?: number | null;
    builtAt?: Date | string | null;
  } | null;
  registry?: {
    ref: string;
    slug: string;
    range: string;
    version: string;
    hash: string;
    sha256: string;
    latest: string;
    upgradeAvailable?: string | null;
    resolvedAt: Date | string;
  } | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

function normalizeBuild(
  raw:
    | MongoConnectorDefinitionLike["build"]
    | ConnectorDefinitionBuildJson
    | null
    | undefined,
): ConnectorDefinitionBuildRecord | undefined {
  if (!raw) return undefined;
  const out: ConnectorDefinitionBuildRecord = {
    status: raw.status,
    hash: raw.hash,
  };
  if (typeof raw.error === "string" && raw.error.length > 0) {
    out.error = raw.error;
  }
  if (typeof raw.bytes === "number") {
    out.bytes = raw.bytes;
  }
  const builtAt = coerceOptionalDate(raw.builtAt);
  if (builtAt) out.builtAt = builtAt;
  return out;
}

function buildToPgJson(
  build: ConnectorDefinitionBuildRecord | null | undefined,
): ConnectorDefinitionBuildJson | null {
  if (!build) return null;
  return {
    status: build.status,
    hash: build.hash,
    ...(build.error !== undefined ? { error: build.error } : {}),
    ...(build.bytes !== undefined ? { bytes: build.bytes } : {}),
    ...(build.builtAt !== undefined
      ? { builtAt: coerceDate(build.builtAt).toISOString() }
      : {}),
  };
}

function normalizeRegistry(
  raw:
    | MongoConnectorDefinitionLike["registry"]
    | ConnectorDefinitionRegistryJson
    | null
    | undefined,
): ConnectorDefinitionRegistryRecord | undefined {
  if (!raw) return undefined;
  const out: ConnectorDefinitionRegistryRecord = {
    ref: raw.ref,
    slug: raw.slug,
    range: raw.range,
    version: raw.version,
    hash: raw.hash,
    sha256: raw.sha256,
    latest: raw.latest,
    resolvedAt: coerceDate(raw.resolvedAt),
  };
  if (
    typeof raw.upgradeAvailable === "string" &&
    raw.upgradeAvailable.length > 0
  ) {
    out.upgradeAvailable = raw.upgradeAvailable;
  }
  return out;
}

function registryToPgJson(
  reg: ConnectorDefinitionRegistryRecord | null | undefined,
): ConnectorDefinitionRegistryJson | null {
  if (!reg) return null;
  return {
    ref: reg.ref,
    slug: reg.slug,
    range: reg.range,
    version: reg.version,
    hash: reg.hash,
    sha256: reg.sha256,
    latest: reg.latest,
    ...(reg.upgradeAvailable !== undefined
      ? { upgradeAvailable: reg.upgradeAvailable }
      : {}),
    resolvedAt: coerceDate(reg.resolvedAt).toISOString(),
  };
}

export function mongoConnectorDefinitionToRecord(
  doc: MongoConnectorDefinitionLike,
): ConnectorDefinitionRecord {
  const id = entityIdToMongoHex(doc._id);
  const createdAt = coerceDate(doc.createdAt);
  const updatedAt = coerceDate(doc.updatedAt, createdAt);
  const record: ConnectorDefinitionRecord = {
    id,
    _id: id,
    workspaceId: entityIdToMongoHex(doc.workspaceId),
    slug: String(doc.slug ?? ""),
    runtime: doc.runtime ? String(doc.runtime) : "node",
    entry: doc.entry ? String(doc.entry) : "connector.ts",
    sha: String(doc.sha ?? ""),
    sourceSha: String(doc.sourceSha ?? ""),
    status: doc.status ?? "indexed",
    entities: Array.isArray(doc.entities) ? doc.entities.map(String) : [],
    hasIcon: doc.hasIcon === true,
    createdAt,
    updatedAt,
  };
  if (doc.spec && typeof doc.spec === "object" && !Array.isArray(doc.spec)) {
    record.spec = stripUndefinedDeep({ ...doc.spec });
  }
  if (typeof doc.blockedReason === "string" && doc.blockedReason.length > 0) {
    record.blockedReason = doc.blockedReason;
  }
  if (typeof doc.indexRetryAttempts === "number") {
    record.indexRetryAttempts = doc.indexRetryAttempts;
  }
  const nextRetry = coerceOptionalDate(doc.nextIndexRetryAt);
  if (nextRetry) record.nextIndexRetryAt = nextRetry;
  const lastChecked = coerceOptionalDate(doc.lastCheckedAt);
  if (lastChecked) record.lastCheckedAt = lastChecked;
  if (typeof doc.lastCheckError === "string" && doc.lastCheckError.length > 0) {
    record.lastCheckError = doc.lastCheckError;
  }
  const build = normalizeBuild(doc.build);
  if (build) record.build = build;
  const registry = normalizeRegistry(doc.registry);
  if (registry) record.registry = registry;
  return record;
}

export function pgConnectorDefinitionToRecord(
  row: ConnectorDefinitionRow,
): ConnectorDefinitionRecord {
  const id = toWireId(row.id);
  const record: ConnectorDefinitionRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    slug: row.slug,
    runtime: row.runtime,
    entry: row.entry,
    sha: row.sha,
    sourceSha: row.sourceSha,
    status: row.status,
    entities: [...(row.entities ?? [])],
    hasIcon: row.hasIcon,
    createdAt: coerceDate(row.createdAt),
    updatedAt: coerceDate(row.updatedAt),
  };
  if (row.spec !== null && row.spec !== undefined) {
    record.spec = stripUndefinedDeep({ ...row.spec });
  }
  if (row.blockedReason !== null && row.blockedReason !== undefined) {
    record.blockedReason = row.blockedReason;
  }
  if (row.indexRetryAttempts !== null && row.indexRetryAttempts !== undefined) {
    record.indexRetryAttempts = row.indexRetryAttempts;
  }
  if (row.nextIndexRetryAt !== null && row.nextIndexRetryAt !== undefined) {
    record.nextIndexRetryAt = coerceDate(row.nextIndexRetryAt);
  }
  if (row.lastCheckedAt !== null && row.lastCheckedAt !== undefined) {
    record.lastCheckedAt = coerceDate(row.lastCheckedAt);
  }
  if (row.lastCheckError !== null && row.lastCheckError !== undefined) {
    record.lastCheckError = row.lastCheckError;
  }
  const build = normalizeBuild(row.build);
  if (build) record.build = build;
  const registry = normalizeRegistry(row.registry);
  if (registry) record.registry = registry;
  return record;
}

export function connectorDefinitionToPgInsert(
  record: ConnectorDefinitionRecord,
): NewConnectorDefinitionRow {
  return {
    id: entityIdToPgUuid(record.id),
    workspaceId: entityIdToPgUuid(record.workspaceId),
    slug: record.slug,
    runtime: record.runtime,
    entry: record.entry,
    sha: record.sha,
    sourceSha: record.sourceSha,
    spec: record.spec ? stripUndefinedDeep(record.spec) : null,
    status: record.status,
    blockedReason: record.blockedReason ?? null,
    indexRetryAttempts: record.indexRetryAttempts ?? null,
    nextIndexRetryAt: record.nextIndexRetryAt ?? null,
    entities: [...(record.entities ?? [])],
    hasIcon: record.hasIcon,
    lastCheckedAt: record.lastCheckedAt ?? null,
    lastCheckError: record.lastCheckError ?? null,
    build: buildToPgJson(record.build),
    registry: registryToPgJson(record.registry),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { buildToPgJson, objectIdToUuid, registryToPgJson };
