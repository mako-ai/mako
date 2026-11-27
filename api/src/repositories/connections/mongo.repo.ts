/**
 * MongoDB implementation of `ConnectionsRepository`.
 *
 * Key invariants:
 *   - `databaseconnections` writes go through the raw MongoDB collection so
 *     repository-layer `encryptConnectionObject()` ciphertext is stored verbatim
 *     (bypassing Mongoose's `set: encryptObject` setter) for byte-identical dual-writes
 *     with Postgres. Metadata-only queries project `{ connection: 0 }` and skip decryption.
 *   - `source_connections` (`connectors`) preserves `liveReaders: undefined` (everyone reads)
 *     vs `liveReaders: []` (writers only) and executes atomic `keyRequest` claim & CAS rollback.
 *   - `connection_write_events` implements `listRecentWriters()` via Mongo aggregation.
 */
import { Types } from "mongoose";
import { ConnectionAccessEvent } from "../../access/connection-access-event";
import { ConnectionWriteEvent } from "../../access/connection-write-event";
import { isObjectIdHex, newDualId } from "../../database/pg/id-codec";
import {
  ConnectorDefinition,
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { encryptConnectionObject } from "./crypto";
import {
  entityIdToMongoHex,
  mongoAccessEventToRecord,
  mongoConnectorDefinitionToRecord,
  mongoDatabaseConnectionToRecord,
  mongoDatabaseConnectionToSummary,
  mongoSourceConnectionToRecord,
  mongoWriteEventToRecord,
  normalizeSourceSettings,
  normalizeWriters,
  stripUndefinedDeep,
  type MongoConnectionAccessEventLike,
  type MongoConnectionWriteEventLike,
  type MongoConnectorDefinitionLike,
  type MongoDatabaseConnectionLike,
  type MongoSourceConnectionLike,
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

function toObjectIdOrNull(id: string): Types.ObjectId | null {
  try {
    const hex = entityIdToMongoHex(id);
    if (!isObjectIdHex(hex)) return null;
    return new Types.ObjectId(hex);
  } catch {
    return null;
  }
}

function toObjectIdRequired(id: string, label: string): Types.ObjectId {
  const oid = toObjectIdOrNull(id);
  if (!oid) {
    throw new Error(`Invalid ${label} ObjectId: ${JSON.stringify(id)}`);
  }
  return oid;
}

export class MongoConnectionsRepository implements ConnectionsRepository {
  // ── Database connections ────────────────────────────────────────────────

  async listDatabaseConnections(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const docs = (await DatabaseConnection.collection
      .find({ workspaceId: wsOid })
      .sort({ createdAt: -1 })
      .toArray()) as unknown as MongoDatabaseConnectionLike[];
    return docs.map(d => mongoDatabaseConnectionToRecord(d));
  }

  async listDatabaseConnectionMetadata(
    workspaceId: string,
  ): Promise<DatabaseConnectionSummary[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const docs = (await DatabaseConnection.collection
      .find({ workspaceId: wsOid }, { projection: { connection: 0 } })
      .sort({ createdAt: -1 })
      .toArray()) as unknown as MongoDatabaseConnectionLike[];
    return docs.map(mongoDatabaseConnectionToSummary);
  }

  async listAllDatabaseConnectionMetadata(
    limit?: number,
  ): Promise<DatabaseConnectionSummary[]> {
    const cursor = DatabaseConnection.collection
      .find({}, { projection: { connection: 0 } })
      .sort({ createdAt: -1 });
    if (limit !== undefined && limit > 0) {
      cursor.limit(limit);
    }
    const docs =
      (await cursor.toArray()) as unknown as MongoDatabaseConnectionLike[];
    return docs.map(mongoDatabaseConnectionToSummary);
  }

  async findDatabaseConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord | null> {
    const oid = toObjectIdOrNull(id);
    if (!oid) return null;
    const filter: Record<string, unknown> = { _id: oid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = (await DatabaseConnection.collection.findOne(
      filter,
    )) as unknown as MongoDatabaseConnectionLike | null;
    return doc ? mongoDatabaseConnectionToRecord(doc) : null;
  }

  async findDatabaseConnectionRawById(
    id: string,
    workspaceId?: string,
  ): Promise<{
    record: DatabaseConnectionRecord;
    connectionEncrypted: Record<string, unknown>;
  } | null> {
    const oid = toObjectIdOrNull(id);
    if (!oid) return null;
    const filter: Record<string, unknown> = { _id: oid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = (await DatabaseConnection.collection.findOne(
      filter,
    )) as unknown as MongoDatabaseConnectionLike | null;
    if (!doc) return null;
    const connectionEncrypted =
      doc.connection &&
      typeof doc.connection === "object" &&
      !Array.isArray(doc.connection)
        ? (doc.connection as Record<string, unknown>)
        : {};
    return {
      record: mongoDatabaseConnectionToRecord(doc),
      connectionEncrypted,
    };
  }

  async findDatabaseConnectionSummary(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary | null> {
    const oid = toObjectIdOrNull(id);
    if (!oid) return null;
    const filter: Record<string, unknown> = { _id: oid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = (await DatabaseConnection.collection.findOne(filter, {
      projection: { connection: 0 },
    })) as unknown as MongoDatabaseConnectionLike | null;
    return doc ? mongoDatabaseConnectionToSummary(doc) : null;
  }

  async findDatabaseConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord[]> {
    const oids = ids
      .map(toObjectIdOrNull)
      .filter((v): v is Types.ObjectId => v !== null);
    if (oids.length === 0) return [];
    const filter: Record<string, unknown> = { _id: { $in: oids } };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return [];
      filter.workspaceId = wsOid;
    }
    const docs = (await DatabaseConnection.collection
      .find(filter)
      .toArray()) as unknown as MongoDatabaseConnectionLike[];
    return docs.map(d => mongoDatabaseConnectionToRecord(d));
  }

  async findDatabaseConnectionSummariesByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary[]> {
    const oids = ids
      .map(toObjectIdOrNull)
      .filter((v): v is Types.ObjectId => v !== null);
    if (oids.length === 0) return [];
    const filter: Record<string, unknown> = { _id: { $in: oids } };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return [];
      filter.workspaceId = wsOid;
    }
    const docs = (await DatabaseConnection.collection
      .find(filter, { projection: { connection: 0 } })
      .toArray()) as unknown as MongoDatabaseConnectionLike[];
    return docs.map(mongoDatabaseConnectionToSummary);
  }

  async findDatabaseConnectionByName(
    workspaceId: string,
    name: string,
  ): Promise<DatabaseConnectionRecord | null> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return null;
    const doc = (await DatabaseConnection.collection.findOne({
      workspaceId: wsOid,
      name: name.trim(),
    })) as unknown as MongoDatabaseConnectionLike | null;
    return doc ? mongoDatabaseConnectionToRecord(doc) : null;
  }

  async findDemoDatabaseConnection(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord | null> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return null;
    const doc = (await DatabaseConnection.collection.findOne({
      workspaceId: wsOid,
      isDemo: true,
    })) as unknown as MongoDatabaseConnectionLike | null;
    return doc ? mongoDatabaseConnectionToRecord(doc) : null;
  }

  async countDatabaseConnections(workspaceId: string): Promise<number> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return 0;
    return DatabaseConnection.collection.countDocuments({ workspaceId: wsOid });
  }

  async createDatabaseConnection(
    input: CreateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord> {
    if (!isDatabaseConnectionType(input.type)) {
      throw new Error(
        `Invalid database connection type: ${String(input.type)}`,
      );
    }
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const oid = input.id
      ? toObjectIdRequired(input.id, "databaseConnection.id")
      : new Types.ObjectId(newDualId(now.getTime()).oid);
    const wsOid = toObjectIdRequired(input.workspaceId, "workspaceId");
    const encrypted =
      input.connectionEncrypted !== undefined
        ? stripUndefinedDeep(input.connectionEncrypted)
        : encryptConnectionObject(input.connection ?? {});

    const doc: Record<string, unknown> = {
      _id: oid,
      workspaceId: wsOid,
      name: input.name.trim(),
      type: input.type,
      connection: encrypted,
      isDemo: input.isDemo ?? false,
      allowAgentWrites: input.allowAgentWrites ?? false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt,
    };
    const writers = normalizeWriters(input.writers);
    if (writers !== undefined) {
      doc.writers = writers;
    }
    if (input.lastConnectedAt !== undefined) {
      doc.lastConnectedAt = input.lastConnectedAt;
    }

    // Raw collection insert bypasses Mongoose's `set: encryptObject` setter so
    // Mongo and Postgres hold byte-identical AES-256-CBC IV + ciphertext.
    await DatabaseConnection.collection.insertOne(doc);
    return mongoDatabaseConnectionToRecord(
      doc as unknown as MongoDatabaseConnectionLike,
    );
  }

  async updateDatabaseConnection(
    id: string,
    workspaceId: string,
    patch: UpdateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord | null> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return null;

    const $set: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    const $unset: Record<string, ""> = {};

    if (patch.name !== undefined) {
      $set.name = patch.name.trim();
    }
    if (patch.connectionEncrypted !== undefined) {
      $set.connection = stripUndefinedDeep(patch.connectionEncrypted);
    } else if (patch.connection !== undefined) {
      $set.connection = encryptConnectionObject(patch.connection);
    }
    if (patch.isDemo !== undefined) {
      $set.isDemo = patch.isDemo;
    }
    if (patch.allowAgentWrites !== undefined) {
      $set.allowAgentWrites = patch.allowAgentWrites;
    }
    if (patch.writers === null) {
      $unset.writers = "";
    } else if (patch.writers !== undefined) {
      $set.writers = normalizeWriters(patch.writers) ?? [];
    }
    if (patch.lastConnectedAt === null) {
      $unset.lastConnectedAt = "";
    } else if (patch.lastConnectedAt !== undefined) {
      $set.lastConnectedAt = patch.lastConnectedAt;
    }

    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) {
      updateDoc.$unset = $unset;
    }

    const updated = (await DatabaseConnection.collection.findOneAndUpdate(
      { _id: oid, workspaceId: wsOid },
      updateDoc,
      { returnDocument: "after" },
    )) as unknown as MongoDatabaseConnectionLike | null;
    return updated ? mongoDatabaseConnectionToRecord(updated) : null;
  }

  async touchDatabaseConnectionLastConnected(
    id: string,
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<void> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return;
    await DatabaseConnection.collection.updateOne(
      { _id: oid, workspaceId: wsOid },
      { $set: { lastConnectedAt: at, updatedAt: at } },
    );
  }

  async deleteDatabaseConnection(
    id: string,
    workspaceId: string,
  ): Promise<boolean> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return false;
    const res = await DatabaseConnection.collection.deleteOne({
      _id: oid,
      workspaceId: wsOid,
    });
    return res.deletedCount > 0;
  }

  /** Idempotent Stage 4 reverse sync-retry raw upsert into Mongo. */
  async upsertDatabaseConnectionRaw(doc: {
    id: string;
    workspaceId: string;
    name: string;
    type: DatabaseConnectionRecord["type"];
    connectionEncrypted: Record<string, unknown>;
    isDemo: boolean;
    allowAgentWrites: boolean;
    writers?: DatabaseConnectionRecord["writers"];
    createdBy: string;
    lastConnectedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<void> {
    const oid = toObjectIdRequired(doc.id, "databaseConnection.id");
    const wsOid = toObjectIdRequired(doc.workspaceId, "workspaceId");
    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      name: doc.name,
      type: doc.type,
      connection: stripUndefinedDeep(doc.connectionEncrypted),
      isDemo: doc.isDemo,
      allowAgentWrites: doc.allowAgentWrites,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    const $unset: Record<string, ""> = {};
    if (doc.writers !== undefined) {
      $set.writers = doc.writers;
    } else {
      $unset.writers = "";
    }
    if (doc.lastConnectedAt !== undefined) {
      $set.lastConnectedAt = doc.lastConnectedAt;
    } else {
      $unset.lastConnectedAt = "";
    }
    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateDoc.$unset = $unset;
    await DatabaseConnection.collection.updateOne({ _id: oid }, updateDoc, {
      upsert: true,
    });
  }

  // ── Source connections (`connectors`) ───────────────────────────────────

  async listSourceConnections(
    workspaceId: string,
    filter: { type?: string; isActive?: boolean } = {},
  ): Promise<SourceConnectionRecord[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const query: Record<string, unknown> = { workspaceId: wsOid };
    if (filter.type !== undefined) query.type = filter.type;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    const docs = await SourceConnection.find(query)
      .sort({ createdAt: -1 })
      .lean<MongoSourceConnectionLike[]>();
    return docs.map(mongoSourceConnectionToRecord);
  }

  async listActiveSourceConnections(
    filter: { workspaceId?: string; type?: string } = {},
  ): Promise<SourceConnectionRecord[]> {
    const query: Record<string, unknown> = { isActive: true };
    if (filter.workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(filter.workspaceId);
      if (!wsOid) return [];
      query.workspaceId = wsOid;
    }
    if (filter.type !== undefined) {
      query.type = filter.type;
    }
    const docs =
      await SourceConnection.find(query).lean<MongoSourceConnectionLike[]>();
    return docs.map(mongoSourceConnectionToRecord);
  }

  async listSourceConnectionIdNames(
    filter: { isActive?: boolean } = {},
  ): Promise<Array<{ id: string; name: string }>> {
    const query: Record<string, unknown> = {};
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    const docs = await SourceConnection.find(query)
      .select("_id name")
      .lean<Array<{ _id: Types.ObjectId | string; name: string }>>();
    return docs.map(d => ({
      id: entityIdToMongoHex(d._id),
      name: String(d.name ?? ""),
    }));
  }

  async listSourceConnectionIdNameWorkspaces(
    filter: { isActive?: boolean } = {},
  ): Promise<Array<{ id: string; name: string; workspaceId: string }>> {
    const query: Record<string, unknown> = {};
    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    const docs = await SourceConnection.find(query)
      .select("_id name workspaceId")
      .lean<
        Array<{
          _id: Types.ObjectId | string;
          name: string;
          workspaceId: Types.ObjectId | string;
        }>
      >();
    return docs.map(d => ({
      id: entityIdToMongoHex(d._id),
      name: String(d.name ?? ""),
      workspaceId: entityIdToMongoHex(d.workspaceId),
    }));
  }

  async findSourceConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<SourceConnectionRecord | null> {
    const oid = toObjectIdOrNull(id);
    if (!oid) return null;
    const filter: Record<string, unknown> = { _id: oid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = await SourceConnection.findOne(
      filter,
    ).lean<MongoSourceConnectionLike | null>();
    return doc ? mongoSourceConnectionToRecord(doc) : null;
  }

  async findSourceConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<SourceConnectionRecord[]> {
    const oids = ids
      .map(toObjectIdOrNull)
      .filter((v): v is Types.ObjectId => v !== null);
    if (oids.length === 0) return [];
    const filter: Record<string, unknown> = { _id: { $in: oids } };
    if (workspaceId !== undefined) {
      const wsOid = toObjectIdOrNull(workspaceId);
      if (!wsOid) return [];
      filter.workspaceId = wsOid;
    }
    const docs =
      await SourceConnection.find(filter).lean<MongoSourceConnectionLike[]>();
    return docs.map(mongoSourceConnectionToRecord);
  }

  async findSourceConnectionByIdOrName(
    workspaceId: string,
    idOrName: string,
  ): Promise<FindSourceConnectionByIdOrNameResult> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return { connection: null };
    const byIdOid = toObjectIdOrNull(idOrName);
    if (byIdOid) {
      const byId = await SourceConnection.findOne({
        _id: byIdOid,
        workspaceId: wsOid,
      }).lean<MongoSourceConnectionLike | null>();
      if (byId) return { connection: mongoSourceConnectionToRecord(byId) };
    }
    const byName = await SourceConnection.find({
      workspaceId: wsOid,
      name: idOrName,
    })
      .limit(2)
      .lean<MongoSourceConnectionLike[]>();
    if (byName.length > 1) {
      return { connection: null, ambiguous: true };
    }
    return {
      connection: byName[0] ? mongoSourceConnectionToRecord(byName[0]) : null,
    };
  }

  async findSourceConnectionByKeyTokenHash(
    workspaceId: string,
    tokenHash: string,
  ): Promise<SourceConnectionRecord | null> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid || !tokenHash) return null;
    const doc = await SourceConnection.findOne({
      workspaceId: wsOid,
      "keyRequest.tokenHash": tokenHash,
    }).lean<MongoSourceConnectionLike | null>();
    return doc ? mongoSourceConnectionToRecord(doc) : null;
  }

  async createSourceConnection(
    input: CreateSourceConnectionInput,
  ): Promise<SourceConnectionRecord> {
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const oid = input.id
      ? toObjectIdRequired(input.id, "sourceConnection.id")
      : new Types.ObjectId(newDualId(now.getTime()).oid);
    const wsOid = toObjectIdRequired(input.workspaceId, "workspaceId");

    const targetOids = (input.targetDatabases ?? [])
      .map(toObjectIdOrNull)
      .filter((v): v is Types.ObjectId => v !== null);

    const doc: Record<string, unknown> = {
      _id: oid,
      workspaceId: wsOid,
      name: input.name.trim(),
      type: input.type,
      config: stripUndefinedDeep(input.config ?? {}),
      settings: normalizeSourceSettings(input.settings),
      targetDatabases: targetOids,
      createdBy: input.createdBy,
      isActive: input.isActive !== false,
      createdAt: now,
      updatedAt,
    };
    if (input.description !== undefined) {
      doc.description = input.description.trim();
    }
    if (input.writers !== undefined) {
      doc.writers = normalizeWriters(input.writers);
    }
    if (input.liveReads !== undefined) {
      doc.liveReads = input.liveReads;
    }
    if (input.liveReaders !== undefined) {
      doc.liveReaders = normalizeWriters(input.liveReaders);
    }
    if (input.managers !== undefined) {
      doc.managers = [...input.managers];
    }
    if (input.lastSyncedAt !== undefined) {
      doc.lastSyncedAt = input.lastSyncedAt;
    }
    if (input.keyRequest !== undefined) {
      doc.keyRequest = { ...input.keyRequest };
    }

    await SourceConnection.collection.insertOne(doc);
    return mongoSourceConnectionToRecord(
      doc as unknown as MongoSourceConnectionLike,
    );
  }

  async updateSourceConnection(
    id: string,
    workspaceId: string,
    patch: UpdateSourceConnectionInput,
  ): Promise<SourceConnectionRecord | null> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return null;

    const $set: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    const $unset: Record<string, ""> = {};

    if (patch.name !== undefined) $set.name = patch.name.trim();
    if (patch.description === null) {
      $unset.description = "";
    } else if (patch.description !== undefined) {
      $set.description = patch.description.trim();
    }
    if (patch.type !== undefined) $set.type = patch.type;
    if (patch.config !== undefined && patch.configPatch !== undefined) {
      throw new Error(
        "updateSourceConnection cannot specify both config and configPatch",
      );
    }
    if (patch.config !== undefined) {
      $set.config = stripUndefinedDeep(patch.config);
    } else if (patch.configPatch !== undefined) {
      for (const [key, value] of Object.entries(patch.configPatch)) {
        if (value === undefined) continue;
        if (!key || key.includes(".") || key.startsWith("$")) {
          throw new Error(`Invalid source connection config key: ${key}`);
        }
        $set[`config.${key}`] = stripUndefinedDeep(value);
      }
    }
    if (patch.settings !== undefined) {
      $set.settings = normalizeSourceSettings(patch.settings);
    }
    if (patch.targetDatabases !== undefined) {
      $set.targetDatabases = patch.targetDatabases
        .map(toObjectIdOrNull)
        .filter((v): v is Types.ObjectId => v !== null);
    }
    if (patch.writers === null) {
      $unset.writers = "";
    } else if (patch.writers !== undefined) {
      $set.writers = normalizeWriters(patch.writers) ?? [];
    }
    if (patch.liveReads !== undefined) {
      $set.liveReads = patch.liveReads;
    }
    // CRITICAL: null clears liveReaders (everyone reads); [] restricts to writers only
    if (patch.liveReaders === null) {
      $unset.liveReaders = "";
    } else if (patch.liveReaders !== undefined) {
      $set.liveReaders = normalizeWriters(patch.liveReaders) ?? [];
    }
    if (patch.managers === null) {
      $unset.managers = "";
    } else if (patch.managers !== undefined) {
      $set.managers = [...patch.managers];
    }
    if (patch.lastSyncedAt === null) {
      $unset.lastSyncedAt = "";
    } else if (patch.lastSyncedAt !== undefined) {
      $set.lastSyncedAt = patch.lastSyncedAt;
    }
    if (patch.isActive !== undefined) {
      $set.isActive = patch.isActive;
    }
    if (patch.keyRequest === null) {
      $unset.keyRequest = "";
    } else if (patch.keyRequest !== undefined) {
      $set.keyRequest = { ...patch.keyRequest };
    }

    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateDoc.$unset = $unset;

    const updated = (await SourceConnection.collection.findOneAndUpdate(
      { _id: oid, workspaceId: wsOid },
      updateDoc,
      { returnDocument: "after" },
    )) as unknown as MongoSourceConnectionLike | null;
    return updated ? mongoSourceConnectionToRecord(updated) : null;
  }

  async claimSourceConnectionKeyRequest(
    input: ClaimSourceConnectionKeyRequestInput,
  ): Promise<boolean> {
    const oid = toObjectIdOrNull(input.id);
    const wsOid = toObjectIdOrNull(input.workspaceId);
    if (!oid || !wsOid) return false;
    const now = input.now ?? new Date();
    const configSets = Object.fromEntries(
      Object.entries(input.encryptedFields).map(([k, v]) => [`config.${k}`, v]),
    );
    const res = await SourceConnection.collection.updateOne(
      {
        _id: oid,
        workspaceId: wsOid,
        "keyRequest.tokenHash": input.tokenHash,
        "keyRequest.expiresAt": { $gt: now },
      },
      {
        $set: { ...configSets, isActive: true, updatedAt: now },
        $unset: { keyRequest: "" },
      },
    );
    return res.modifiedCount === 1;
  }

  async rollbackSourceConnectionKeyRequest(
    input: RollbackSourceConnectionKeyRequestInput,
  ): Promise<boolean> {
    const oid = toObjectIdOrNull(input.id);
    const wsOid = toObjectIdOrNull(input.workspaceId);
    if (!oid || !wsOid) return false;
    const now = input.now ?? new Date();
    const configMatch = Object.fromEntries(
      Object.entries(input.encryptedFields).map(([k, v]) => [`config.${k}`, v]),
    );
    const configUnsets = Object.fromEntries(
      Object.keys(input.encryptedFields).map(k => [`config.${k}`, ""]),
    );
    const updateDoc: Record<string, unknown> = {
      $set: {
        keyRequest: { ...input.keyRequest },
        isActive: false,
        updatedAt: now,
      },
    };
    if (Object.keys(configUnsets).length > 0) {
      updateDoc.$unset = configUnsets;
    }
    const res = await SourceConnection.collection.updateOne(
      {
        _id: oid,
        workspaceId: wsOid,
        keyRequest: { $exists: false },
        ...configMatch,
      },
      updateDoc,
    );
    return res.modifiedCount === 1;
  }

  async deleteSourceConnection(
    id: string,
    workspaceId: string,
  ): Promise<boolean> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return false;
    const res = await SourceConnection.collection.deleteOne({
      _id: oid,
      workspaceId: wsOid,
    });
    return res.deletedCount > 0;
  }

  /** Idempotent Stage 4 reverse sync-retry full upsert into Mongo. */
  async upsertSourceConnectionFromRecord(
    record: SourceConnectionRecord,
  ): Promise<void> {
    const oid = toObjectIdRequired(record.id, "sourceConnection.id");
    const wsOid = toObjectIdRequired(record.workspaceId, "workspaceId");
    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      name: record.name,
      type: record.type,
      config: stripUndefinedDeep(record.config),
      settings: normalizeSourceSettings(record.settings),
      targetDatabases: record.targetDatabases
        .map(toObjectIdOrNull)
        .filter((v): v is Types.ObjectId => v !== null),
      liveReads: record.liveReads,
      createdBy: record.createdBy,
      isActive: record.isActive,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const $unset: Record<string, ""> = {};
    if (record.description !== undefined) $set.description = record.description;
    else $unset.description = "";
    if (record.writers !== undefined) $set.writers = record.writers;
    else $unset.writers = "";
    if (record.liveReaders !== undefined) $set.liveReaders = record.liveReaders;
    else $unset.liveReaders = "";
    if (record.managers !== undefined) $set.managers = record.managers;
    else $unset.managers = "";
    if (record.lastSyncedAt !== undefined) {
      $set.lastSyncedAt = record.lastSyncedAt;
    } else {
      $unset.lastSyncedAt = "";
    }
    if (record.keyRequest !== undefined) $set.keyRequest = record.keyRequest;
    else $unset.keyRequest = "";

    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateDoc.$unset = $unset;
    await SourceConnection.collection.updateOne({ _id: oid }, updateDoc, {
      upsert: true,
    });
  }

  // ── Connection access events ────────────────────────────────────────────

  async recordConnectionAccessEvent(
    input: RecordConnectionAccessEventInput,
  ): Promise<ConnectionAccessEventRecord> {
    const at = input.at ?? new Date();
    const oid = input.id
      ? toObjectIdRequired(input.id, "accessEvent.id")
      : new Types.ObjectId(newDualId(at.getTime()).oid);
    const wsOid = toObjectIdRequired(input.workspaceId, "workspaceId");
    const connOid = toObjectIdRequired(input.connectionId, "connectionId");
    const doc = {
      _id: oid,
      workspaceId: wsOid,
      connectionId: connOid,
      kind: input.kind,
      actor: input.actor,
      via: input.via,
      changes: stripUndefinedDeep(input.changes),
      at,
    };
    await ConnectionAccessEvent.collection.insertOne(doc);
    return mongoAccessEventToRecord(doc);
  }

  async listConnectionAccessEvents(
    workspaceId: string,
    connectionId: string,
    limit: number = 100,
  ): Promise<ConnectionAccessEventRecord[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    const connOid = toObjectIdOrNull(connectionId);
    if (!wsOid || !connOid) return [];
    const docs = await ConnectionAccessEvent.find({
      workspaceId: wsOid,
      connectionId: connOid,
    })
      .sort({ at: -1 })
      .limit(limit)
      .lean<MongoConnectionAccessEventLike[]>();
    return docs.map(mongoAccessEventToRecord);
  }

  async upsertAccessEventFromRecord(
    record: ConnectionAccessEventRecord,
  ): Promise<void> {
    const oid = toObjectIdRequired(record.id, "accessEvent.id");
    await ConnectionAccessEvent.collection.updateOne(
      { _id: oid },
      {
        $setOnInsert: {
          _id: oid,
          workspaceId: toObjectIdRequired(record.workspaceId, "workspaceId"),
          connectionId: toObjectIdRequired(record.connectionId, "connectionId"),
          kind: record.kind,
          actor: record.actor,
          via: record.via,
          changes: stripUndefinedDeep(record.changes),
          at: record.at,
        },
      },
      { upsert: true },
    );
  }

  // ── Connection write events ─────────────────────────────────────────────

  async recordConnectionWriteEvent(
    input: RecordConnectionWriteEventInput,
  ): Promise<ConnectionWriteEventRecord> {
    const at = input.at ?? new Date();
    const oid = input.id
      ? toObjectIdRequired(input.id, "writeEvent.id")
      : new Types.ObjectId(newDualId(at.getTime()).oid);
    const wsOid = toObjectIdRequired(input.workspaceId, "workspaceId");
    const connOid = toObjectIdRequired(input.connectionId, "connectionId");
    const doc: Record<string, unknown> = {
      _id: oid,
      workspaceId: wsOid,
      connectionId: connOid,
      principal: input.principal,
      allowed: input.allowed,
      at,
    };
    if (input.target !== undefined) doc.target = input.target;
    if (input.status !== undefined) doc.status = input.status;
    if (input.error !== undefined) doc.error = input.error;
    await ConnectionWriteEvent.collection.insertOne(doc);
    return mongoWriteEventToRecord(
      doc as unknown as MongoConnectionWriteEventLike,
    );
  }

  async recordConnectionWriteOutcome(
    id: string,
    _workspaceId: string,
    outcome: { status: number } | { error: string },
  ): Promise<void> {
    const oid = toObjectIdOrNull(id);
    if (!oid) return;
    await ConnectionWriteEvent.collection.updateOne(
      { _id: oid },
      { $set: outcome },
    );
  }

  async listRecentWriters(
    connectionId: string,
    since: Date,
  ): Promise<RecentWriterAggregate[]> {
    const connOid = toObjectIdOrNull(connectionId);
    if (!connOid) return [];
    const rows = await ConnectionWriteEvent.aggregate<{
      _id: string;
      count: number;
      lastAt: Date;
      targets: Array<string | null>;
    }>([
      {
        $match: {
          connectionId: connOid,
          at: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$principal",
          count: { $sum: 1 },
          lastAt: { $max: "$at" },
          targets: { $addToSet: "$target" },
        },
      },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 50 },
    ]);
    return rows.map(r => ({
      principal: r._id,
      count: r.count,
      lastAt: r.lastAt,
      targets: r.targets.filter((t): t is string => Boolean(t)).sort(),
    }));
  }

  async upsertWriteEventFromRecord(
    record: ConnectionWriteEventRecord,
  ): Promise<void> {
    const oid = toObjectIdRequired(record.id, "writeEvent.id");
    const $set: Record<string, unknown> = {
      workspaceId: toObjectIdRequired(record.workspaceId, "workspaceId"),
      connectionId: toObjectIdRequired(record.connectionId, "connectionId"),
      principal: record.principal,
      allowed: record.allowed,
      at: record.at,
    };
    if (record.target !== undefined) $set.target = record.target;
    if (record.status !== undefined) $set.status = record.status;
    if (record.error !== undefined) $set.error = record.error;
    await ConnectionWriteEvent.collection.updateOne(
      { _id: oid },
      { $set },
      { upsert: true },
    );
  }

  // ── Connector definitions ───────────────────────────────────────────────

  async findConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<ConnectorDefinitionRecord | null> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return null;
    const doc = await ConnectorDefinition.findOne({
      workspaceId: wsOid,
      slug: slug.trim(),
    }).lean<MongoConnectorDefinitionLike | null>();
    return doc ? mongoConnectorDefinitionToRecord(doc) : null;
  }

  async listConnectorDefinitions(
    workspaceId: string,
  ): Promise<ConnectorDefinitionRecord[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const docs = await ConnectorDefinition.find({ workspaceId: wsOid })
      .sort({ slug: 1 })
      .lean<MongoConnectorDefinitionLike[]>();
    return docs.map(mongoConnectorDefinitionToRecord);
  }

  async upsertConnectorDefinition(
    input: UpsertConnectorDefinitionInput,
  ): Promise<ConnectorDefinitionRecord> {
    const wsOid = toObjectIdRequired(input.workspaceId, "workspaceId");
    const now = input.now ?? new Date();
    const slug = input.slug.trim();
    const insertOid = input.id
      ? toObjectIdRequired(input.id, "connectorDefinition.id")
      : new Types.ObjectId(newDualId(now.getTime()).oid);

    const $set: Record<string, unknown> = {
      sha: input.sha,
      sourceSha: input.sourceSha,
      status: input.status,
      updatedAt: now,
    };
    const $unset: Record<string, ""> = {};

    if (input.runtime !== undefined) $set.runtime = input.runtime;
    if (input.entry !== undefined) $set.entry = input.entry;
    if (input.entities !== undefined) $set.entities = [...input.entities];
    if (input.hasIcon !== undefined) $set.hasIcon = input.hasIcon;

    if (input.spec === null) $unset.spec = "";
    else if (input.spec !== undefined) {
      $set.spec = stripUndefinedDeep(input.spec);
    }

    if (input.blockedReason === null) $unset.blockedReason = "";
    else if (input.blockedReason !== undefined) {
      $set.blockedReason = input.blockedReason;
    }

    if (input.indexRetryAttempts === null) $unset.indexRetryAttempts = "";
    else if (input.indexRetryAttempts !== undefined) {
      $set.indexRetryAttempts = input.indexRetryAttempts;
    }

    if (input.nextIndexRetryAt === null) $unset.nextIndexRetryAt = "";
    else if (input.nextIndexRetryAt !== undefined) {
      $set.nextIndexRetryAt = input.nextIndexRetryAt;
    }

    if (input.lastCheckedAt === null) $unset.lastCheckedAt = "";
    else if (input.lastCheckedAt !== undefined) {
      $set.lastCheckedAt = input.lastCheckedAt;
    }

    if (input.lastCheckError === null) $unset.lastCheckError = "";
    else if (input.lastCheckError !== undefined) {
      $set.lastCheckError = input.lastCheckError;
    }

    if (input.build === null) $unset.build = "";
    else if (input.build !== undefined) {
      $set.build = stripUndefinedDeep({ ...input.build });
    }

    if (input.registry === null) $unset.registry = "";
    else if (input.registry !== undefined) {
      $set.registry = stripUndefinedDeep({ ...input.registry });
    }

    const $setOnInsert: Record<string, unknown> = {
      _id: insertOid,
      workspaceId: wsOid,
      slug,
      createdAt: now,
    };
    if (input.runtime === undefined) $setOnInsert.runtime = "node";
    if (input.entry === undefined) $setOnInsert.entry = "connector.ts";
    if (input.entities === undefined) $setOnInsert.entities = [];
    if (input.hasIcon === undefined) $setOnInsert.hasIcon = false;

    const updateDoc: Record<string, unknown> = { $set, $setOnInsert };
    if (Object.keys($unset).length > 0) updateDoc.$unset = $unset;

    const updated = (await ConnectorDefinition.collection.findOneAndUpdate(
      { workspaceId: wsOid, slug },
      updateDoc,
      { upsert: true, returnDocument: "after" },
    )) as unknown as MongoConnectorDefinitionLike;
    return mongoConnectorDefinitionToRecord(updated);
  }

  async updateConnectorDefinitionMetadata(
    workspaceId: string,
    slug: string,
    patch: UpdateConnectorDefinitionMetadataInput,
  ): Promise<boolean> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return false;
    const now = patch.now ?? new Date();
    const filter: Record<string, unknown> = {
      workspaceId: wsOid,
      slug: slug.trim(),
    };
    if (patch.expectedSourceSha !== undefined) {
      filter.sourceSha = patch.expectedSourceSha;
    }
    const $set: Record<string, unknown> = { updatedAt: now };
    const $unset: Record<string, ""> = {};
    if (patch.sha !== undefined) $set.sha = patch.sha;
    if (patch.entry !== undefined) $set.entry = patch.entry;
    if (patch.registry === null) {
      $unset.registry = "";
    } else if (patch.registry !== undefined) {
      $set.registry = stripUndefinedDeep({ ...patch.registry });
    }
    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) updateDoc.$unset = $unset;
    const res = await ConnectorDefinition.collection.updateOne(
      filter,
      updateDoc,
    );
    return res.matchedCount > 0;
  }

  async recordConnectorDefinitionBuild(
    workspaceId: string,
    slug: string,
    build: ConnectorDefinitionBuildRecord,
    options: { expectedSourceSha?: string; now?: Date } = {},
  ): Promise<boolean> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return false;
    const now = options.now ?? new Date();
    const filter: Record<string, unknown> = {
      workspaceId: wsOid,
      slug: slug.trim(),
    };
    if (options.expectedSourceSha !== undefined) {
      filter.sourceSha = options.expectedSourceSha;
    }
    const res = await ConnectorDefinition.collection.updateOne(filter, {
      $set: { build: stripUndefinedDeep({ ...build }), updatedAt: now },
    });
    return res.matchedCount > 0;
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
  ): Promise<boolean> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return false;
    const filter: Record<string, unknown> = {
      workspaceId: wsOid,
      slug: slug.trim(),
      status: { $nin: ["blocked", "retrying"] },
    };
    if (result.expectedSourceSha !== undefined) {
      filter.sourceSha = result.expectedSourceSha;
    }
    const update = result.ok
      ? {
          $set: {
            status: "verified",
            lastCheckedAt: result.checkedAt,
            updatedAt: result.checkedAt,
          },
          $unset: { lastCheckError: "" },
        }
      : {
          $set: {
            status: "indexed",
            lastCheckedAt: result.checkedAt,
            lastCheckError: (result.error ?? "Connection test failed").slice(
              0,
              4000,
            ),
            updatedAt: result.checkedAt,
          },
        };
    const res = await ConnectorDefinition.collection.updateOne(filter, update);
    return res.matchedCount === 1;
  }

  async deleteConnectorDefinitionReturningId(
    workspaceId: string,
    slug: string,
  ): Promise<string | null> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return null;
    const deleted = (await ConnectorDefinition.collection.findOneAndDelete(
      {
        workspaceId: wsOid,
        slug: slug.trim(),
      },
      { projection: { _id: 1 } },
    )) as { _id: Types.ObjectId | string } | null;
    return deleted ? entityIdToMongoHex(deleted._id) : null;
  }

  async deleteConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<boolean> {
    return (
      (await this.deleteConnectorDefinitionReturningId(workspaceId, slug)) !==
      null
    );
  }

  async deleteConnectorDefinitionById(
    id: string,
    workspaceId: string,
  ): Promise<boolean> {
    const oid = toObjectIdOrNull(id);
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!oid || !wsOid) return false;
    const res = await ConnectorDefinition.collection.deleteOne({
      _id: oid,
      workspaceId: wsOid,
    });
    return res.deletedCount > 0;
  }

  async deleteConnectorDefinitionsByIds(
    ids: readonly string[],
    workspaceId: string,
  ): Promise<string[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const oids = ids
      .map(toObjectIdOrNull)
      .filter((v): v is Types.ObjectId => v !== null);
    if (oids.length === 0) return [];
    const toDelete = await ConnectorDefinition.collection
      .find(
        { _id: { $in: oids }, workspaceId: wsOid },
        { projection: { _id: 1 } },
      )
      .toArray();
    if (toDelete.length === 0) return [];
    const deleteOids = toDelete.map(d => d._id);
    await ConnectorDefinition.collection.deleteMany({
      _id: { $in: deleteOids },
      workspaceId: wsOid,
    });
    return deleteOids.map(oid => entityIdToMongoHex(oid));
  }

  async deleteConnectorDefinitionsNotInSlugs(
    workspaceId: string,
    keepSlugs: readonly string[],
  ): Promise<string[]> {
    const wsOid = toObjectIdOrNull(workspaceId);
    if (!wsOid) return [];
    const filter: Record<string, unknown> = { workspaceId: wsOid };
    if (keepSlugs.length > 0) {
      filter.slug = { $nin: [...keepSlugs] };
    }
    const toDelete = await ConnectorDefinition.collection
      .find(filter, { projection: { _id: 1 } })
      .toArray();
    if (toDelete.length === 0) return [];
    const oids = toDelete.map(d => d._id);
    await ConnectorDefinition.collection.deleteMany({ _id: { $in: oids } });
    return oids.map(oid => entityIdToMongoHex(oid));
  }

  async listWorkspaceIdsWithDueRetries(
    now: Date = new Date(),
  ): Promise<string[]> {
    const ids = await ConnectorDefinition.distinct("workspaceId", {
      status: "retrying",
      nextIndexRetryAt: { $lte: now },
    });
    return ids.map(id => entityIdToMongoHex(String(id)));
  }

  async upsertConnectorDefinitionFromRecord(
    record: ConnectorDefinitionRecord,
  ): Promise<void> {
    await this.upsertConnectorDefinition({
      id: record.id,
      workspaceId: record.workspaceId,
      slug: record.slug,
      runtime: record.runtime,
      entry: record.entry,
      sha: record.sha,
      sourceSha: record.sourceSha,
      spec: record.spec ?? null,
      status: record.status,
      blockedReason: record.blockedReason ?? null,
      indexRetryAttempts: record.indexRetryAttempts ?? null,
      nextIndexRetryAt: record.nextIndexRetryAt ?? null,
      entities: record.entities,
      hasIcon: record.hasIcon,
      lastCheckedAt: record.lastCheckedAt ?? null,
      lastCheckError: record.lastCheckError ?? null,
      build: record.build ?? null,
      registry: record.registry ?? null,
      now: record.updatedAt,
    });
  }
}
