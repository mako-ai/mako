/**
 * Store-agnostic DTOs and repository contract for the Phase 2A-1 `connections` domain (5 tables).
 *
 * Covers:
 *   - database_connections     (Mongo `databaseconnections`)
 *   - source_connections       (Mongo `connectors`)
 *   - connection_access_events (Mongo `connection_access_events`)
 *   - connection_write_events  (Mongo `connection_write_events`)
 *   - connector_definitions    (Mongo `connectordefinitions`)
 */
import type {
  ConnectionAccessChangesJson,
  ConnectionAccessKind,
  ConnectionAccessVia,
  ConnectorDefinitionStatus,
  DatabaseConnectionType,
  SourceConnectionSettingsJson,
} from "../../database/pg/schema/connections";

export type {
  ConnectionAccessChangesJson,
  ConnectionAccessKind,
  ConnectionAccessVia,
  ConnectorDefinitionStatus,
  DatabaseConnectionType,
  SourceConnectionSettingsJson,
};

export interface ConnectionWriterRecord {
  principal: string;
  where?: string;
  addedBy?: string;
  addedAt?: Date;
}

export interface DatabaseConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  connectionString?: string;
  authSource?: string;
  replicaSet?: string;
  ssl?: boolean;
  instanceConnectionName?: string;
  instance_connection_name?: string;
  domainName?: string;
  domain_name?: string;
  authType?: string;
  ipType?: string;
  service_account_json?: string;
  sshTunnel?: {
    enabled: boolean;
    host?: string;
    port?: number;
    username?: string;
    authMethod?: "password" | "privateKey";
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
  [key: string]: unknown;
}

export interface DatabaseConnectionSummary {
  /** Wire-compatible 24-hex ObjectId (or native UUID post-migration). */
  id: string;
  /** Compatibility alias mirroring `id`. */
  _id: string;
  workspaceId: string;
  name: string;
  type: DatabaseConnectionType;
  isDemo: boolean;
  allowAgentWrites: boolean;
  /** `undefined` preserves Mongo absent field vs explicit `[]`. */
  writers?: ConnectionWriterRecord[];
  createdBy: string;
  lastConnectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseConnectionRecord extends DatabaseConnectionSummary {
  /** Decrypted connection configuration object. */
  connection: DatabaseConnectionConfig;
}

export interface SourceConnectionKeyRequestRecord {
  tokenHash: string;
  expiresAt: Date;
  fields: string[];
  requestedBy: string;
  createdAt: Date;
}

export interface SourceConnectionRecord {
  /** Wire-compatible 24-hex ObjectId (or native UUID post-migration). */
  id: string;
  /** Compatibility alias mirroring `id`. */
  _id: string;
  workspaceId: string;
  name: string;
  type: string;
  description?: string;
  /** Schema-driven encrypted config payload (matches Mongo `connectors.config`). */
  config: Record<string, unknown>;
  settings: SourceConnectionSettingsJson;
  targetDatabases: string[];
  writers?: ConnectionWriterRecord[];
  liveReads: boolean;
  /**
   * CRITICAL: `undefined` = everyone in workspace reads live (when `liveReads` is true);
   * `[]` = writers only. Never coalesce `undefined` to `[]`!
   */
  liveReaders?: ConnectionWriterRecord[];
  /** `undefined` = creator is manager; non-empty overrides. */
  managers?: string[];
  createdBy: string;
  lastSyncedAt?: Date;
  isActive: boolean;
  keyRequest?: SourceConnectionKeyRequestRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionAccessEventRecord {
  id: string;
  _id: string;
  workspaceId: string;
  connectionId: string;
  kind: ConnectionAccessKind;
  actor: string;
  via: ConnectionAccessVia;
  changes: ConnectionAccessChangesJson;
  at: Date;
}

export interface ConnectionWriteEventRecord {
  id: string;
  _id: string;
  workspaceId: string;
  connectionId: string;
  principal: string;
  target?: string;
  allowed: boolean;
  status?: number;
  error?: string;
  at: Date;
}

export interface RecentWriterAggregate {
  principal: string;
  count: number;
  lastAt: Date;
  targets: string[];
}

export interface ConnectorDefinitionBuildRecord {
  status: "built" | "failed";
  hash: string;
  error?: string;
  bytes?: number;
  builtAt?: Date;
}

export interface ConnectorDefinitionRegistryRecord {
  ref: string;
  slug: string;
  range: string;
  version: string;
  hash: string;
  sha256: string;
  latest: string;
  upgradeAvailable?: string;
  resolvedAt: Date;
}

export interface ConnectorDefinitionRecord {
  id: string;
  _id: string;
  workspaceId: string;
  slug: string;
  runtime: string;
  entry: string;
  sha: string;
  sourceSha: string;
  spec?: Record<string, unknown>;
  status: ConnectorDefinitionStatus;
  blockedReason?: string;
  indexRetryAttempts?: number;
  nextIndexRetryAt?: Date;
  entities: string[];
  hasIcon: boolean;
  lastCheckedAt?: Date;
  lastCheckError?: string;
  build?: ConnectorDefinitionBuildRecord;
  registry?: ConnectorDefinitionRegistryRecord;
  createdAt: Date;
  updatedAt: Date;
}

// ── Write inputs ─────────────────────────────────────────────────────────────

export interface CreateDatabaseConnectionInput {
  id?: string;
  workspaceId: string;
  name: string;
  type: DatabaseConnectionType;
  /** Plaintext connection object (encrypted once by repository layer). */
  connection?: Record<string, unknown>;
  /** Pre-encrypted payload used internally for byte-identical dual-writes. */
  connectionEncrypted?: Record<string, unknown>;
  isDemo?: boolean;
  allowAgentWrites?: boolean;
  writers?: ConnectionWriterRecord[];
  createdBy: string;
  lastConnectedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateDatabaseConnectionInput {
  name?: string;
  /** Plaintext connection object (encrypted once by repository layer). */
  connection?: Record<string, unknown>;
  /** Pre-encrypted payload used internally for byte-identical dual-writes. */
  connectionEncrypted?: Record<string, unknown>;
  isDemo?: boolean;
  allowAgentWrites?: boolean;
  /** Pass `null` to clear writers to undefined/NULL; pass `[]` for explicit empty list. */
  writers?: ConnectionWriterRecord[] | null;
  lastConnectedAt?: Date | null;
  updatedAt?: Date;
}

export interface CreateSourceConnectionInput {
  id?: string;
  workspaceId: string;
  name: string;
  type: string;
  description?: string;
  /** Schema-encrypted config object (encrypted by `applySchemaEncryption`). */
  config: Record<string, unknown>;
  settings: SourceConnectionSettingsJson;
  targetDatabases?: string[];
  writers?: ConnectionWriterRecord[];
  liveReads?: boolean;
  liveReaders?: ConnectionWriterRecord[];
  managers?: string[];
  createdBy: string;
  lastSyncedAt?: Date;
  isActive?: boolean;
  keyRequest?: SourceConnectionKeyRequestRecord;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateSourceConnectionInput {
  name?: string;
  description?: string | null;
  type?: string;
  config?: Record<string, unknown>;
  settings?: SourceConnectionSettingsJson;
  targetDatabases?: string[];
  writers?: ConnectionWriterRecord[] | null;
  liveReads?: boolean;
  /** Pass `null` to restore "everyone reads live"; pass `[]` for writers only. */
  liveReaders?: ConnectionWriterRecord[] | null;
  /** Pass `null` to clear managers override (creator becomes manager). */
  managers?: string[] | null;
  lastSyncedAt?: Date | null;
  isActive?: boolean;
  /** Pass `null` to unset keyRequest. */
  keyRequest?: SourceConnectionKeyRequestRecord | null;
  updatedAt?: Date;
}

export interface ClaimSourceConnectionKeyRequestInput {
  id: string;
  workspaceId: string;
  tokenHash: string;
  /** Map of config field name -> already schema-encrypted ciphertext. */
  encryptedFields: Record<string, string>;
  now?: Date;
}

export interface RollbackSourceConnectionKeyRequestInput {
  id: string;
  workspaceId: string;
  /** Exact ciphertext entries that `claimSourceConnectionKeyRequest` wrote. */
  encryptedFields: Record<string, string>;
  keyRequest: SourceConnectionKeyRequestRecord;
  now?: Date;
}

export interface RecordConnectionAccessEventInput {
  id?: string;
  workspaceId: string;
  connectionId: string;
  kind: ConnectionAccessKind;
  actor: string;
  via: ConnectionAccessVia;
  changes: ConnectionAccessChangesJson;
  at?: Date;
}

export interface RecordConnectionWriteEventInput {
  id?: string;
  workspaceId: string;
  connectionId: string;
  principal: string;
  target?: string;
  allowed: boolean;
  status?: number;
  error?: string;
  at?: Date;
}

export interface UpsertConnectorDefinitionInput {
  id?: string;
  workspaceId: string;
  slug: string;
  runtime?: string;
  entry?: string;
  sha: string;
  sourceSha: string;
  spec?: Record<string, unknown> | null;
  status: ConnectorDefinitionStatus;
  blockedReason?: string | null;
  indexRetryAttempts?: number | null;
  nextIndexRetryAt?: Date | null;
  entities?: string[];
  hasIcon?: boolean;
  lastCheckedAt?: Date | null;
  lastCheckError?: string | null;
  build?: ConnectorDefinitionBuildRecord | null;
  registry?: ConnectorDefinitionRegistryRecord | null;
  now?: Date;
}

export interface FindSourceConnectionByIdOrNameResult {
  connection: SourceConnectionRecord | null;
  ambiguous?: boolean;
}

export interface ConnectionsRepository {
  // ── Database connections ────────────────────────────────────────────────
  listDatabaseConnections(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord[]>;
  listDatabaseConnectionMetadata(
    workspaceId: string,
  ): Promise<DatabaseConnectionSummary[]>;
  findDatabaseConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord | null>;
  findDatabaseConnectionSummary(
    id: string,
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary | null>;
  findDatabaseConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionRecord[]>;
  findDatabaseConnectionSummariesByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<DatabaseConnectionSummary[]>;
  findDatabaseConnectionByName(
    workspaceId: string,
    name: string,
  ): Promise<DatabaseConnectionRecord | null>;
  findDemoDatabaseConnection(
    workspaceId: string,
  ): Promise<DatabaseConnectionRecord | null>;
  countDatabaseConnections(workspaceId: string): Promise<number>;
  createDatabaseConnection(
    input: CreateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord>;
  updateDatabaseConnection(
    id: string,
    workspaceId: string,
    patch: UpdateDatabaseConnectionInput,
  ): Promise<DatabaseConnectionRecord | null>;
  touchDatabaseConnectionLastConnected(
    id: string,
    workspaceId: string,
    at?: Date,
  ): Promise<void>;
  deleteDatabaseConnection(id: string, workspaceId: string): Promise<boolean>;

  // ── Source connections ──────────────────────────────────────────────────
  listSourceConnections(
    workspaceId: string,
    filter?: { type?: string; isActive?: boolean },
  ): Promise<SourceConnectionRecord[]>;
  listActiveSourceConnections(filter?: {
    workspaceId?: string;
    type?: string;
  }): Promise<SourceConnectionRecord[]>;
  listSourceConnectionIdNames(filter?: {
    isActive?: boolean;
  }): Promise<Array<{ id: string; name: string }>>;
  findSourceConnectionById(
    id: string,
    workspaceId?: string,
  ): Promise<SourceConnectionRecord | null>;
  findSourceConnectionsByIds(
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<SourceConnectionRecord[]>;
  findSourceConnectionByIdOrName(
    workspaceId: string,
    idOrName: string,
  ): Promise<FindSourceConnectionByIdOrNameResult>;
  findSourceConnectionByKeyTokenHash(
    workspaceId: string,
    tokenHash: string,
  ): Promise<SourceConnectionRecord | null>;
  createSourceConnection(
    input: CreateSourceConnectionInput,
  ): Promise<SourceConnectionRecord>;
  updateSourceConnection(
    id: string,
    workspaceId: string,
    patch: UpdateSourceConnectionInput,
  ): Promise<SourceConnectionRecord | null>;
  claimSourceConnectionKeyRequest(
    input: ClaimSourceConnectionKeyRequestInput,
  ): Promise<boolean>;
  rollbackSourceConnectionKeyRequest(
    input: RollbackSourceConnectionKeyRequestInput,
  ): Promise<boolean>;
  deleteSourceConnection(id: string, workspaceId: string): Promise<boolean>;

  // ── Connection access events (permanent audit) ──────────────────────────
  recordConnectionAccessEvent(
    input: RecordConnectionAccessEventInput,
  ): Promise<ConnectionAccessEventRecord>;
  listConnectionAccessEvents(
    workspaceId: string,
    connectionId: string,
    limit?: number,
  ): Promise<ConnectionAccessEventRecord[]>;

  // ── Connection write events (90-day TTL) ────────────────────────────────
  recordConnectionWriteEvent(
    input: RecordConnectionWriteEventInput,
  ): Promise<ConnectionWriteEventRecord>;
  recordConnectionWriteOutcome(
    id: string,
    workspaceId: string,
    outcome: { status: number } | { error: string },
  ): Promise<void>;
  listRecentWriters(
    connectionId: string,
    since: Date,
    workspaceId?: string,
  ): Promise<RecentWriterAggregate[]>;

  // ── Connector definitions (derived workspace git index) ─────────────────
  findConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<ConnectorDefinitionRecord | null>;
  listConnectorDefinitions(
    workspaceId: string,
  ): Promise<ConnectorDefinitionRecord[]>;
  upsertConnectorDefinition(
    input: UpsertConnectorDefinitionInput,
  ): Promise<ConnectorDefinitionRecord>;
  recordConnectorDefinitionBuild(
    workspaceId: string,
    slug: string,
    build: ConnectorDefinitionBuildRecord,
    options?: { expectedSourceSha?: string; now?: Date },
  ): Promise<boolean>;
  recordConnectorDefinitionCheckResult(
    workspaceId: string,
    slug: string,
    result: {
      ok: boolean;
      checkedAt: Date;
      expectedSourceSha?: string;
      error?: string;
    },
  ): Promise<boolean>;
  deleteConnectorDefinition(
    workspaceId: string,
    slug: string,
  ): Promise<boolean>;
  deleteConnectorDefinitionsNotInSlugs(
    workspaceId: string,
    keepSlugs: readonly string[],
  ): Promise<string[]>;
  listWorkspaceIdsWithDueRetries(now?: Date): Promise<string[]>;
}
