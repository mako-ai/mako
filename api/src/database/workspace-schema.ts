import mongoose, { Schema, Document, Types } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { loggers } from "../logging";

// Encryption helper functions
let _encryptionKey: string | null = null;

function getEncryptionKey(): string {
  if (!_encryptionKey) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }
    _encryptionKey = key;
  }
  return _encryptionKey;
}

const IV_LENGTH = 16;

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    iv,
  );
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text: string): string {
  const textParts = text.split(":");
  const ivHex = textParts.shift();
  if (!ivHex) {
    throw new Error("Invalid encrypted text format: missing IV");
  }
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    iv,
  );
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

function encryptObject(obj: any): any {
  const encrypted: any = {};
  for (const key in obj) {
    if (typeof obj[key] === "string" && obj[key]) {
      encrypted[key] = encrypt(obj[key]);
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      encrypted[key] = encryptObject(obj[key]);
    } else {
      encrypted[key] = obj[key];
    }
  }
  return encrypted;
}

function decryptObject(obj: any): any {
  try {
    // If connection was stored as a JSON string, parse and decrypt.
    // Guard: only recurse when JSON.parse yields a non-string (object/array)
    // to prevent infinite recursion on doubly-quoted strings like '"foo"'.
    if (typeof obj === "string") {
      try {
        const parsed = JSON.parse(obj);
        if (typeof parsed !== "string") {
          return decryptObject(parsed);
        }
      } catch {
        // Not valid JSON — fall through to direct decrypt
      }
      try {
        return decrypt(obj);
      } catch {
        return obj;
      }
    }
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    const decrypted: any = {};
    for (const key in obj) {
      if (typeof obj[key] === "string" && obj[key] && obj[key].includes(":")) {
        try {
          decrypted[key] = decrypt(obj[key]);
        } catch {
          decrypted[key] = obj[key]; // If decryption fails, return as is
        }
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        try {
          decrypted[key] = decryptObject(obj[key]);
        } catch {
          decrypted[key] = obj[key]; // Nested decrypt failure (e.g. wrong key), return as is
        }
      } else {
        decrypted[key] = obj[key];
      }
    }
    return decrypted;
  } catch (err) {
    // Unexpected error (e.g. RangeError from invalid hex): return unchanged so list doesn't break.
    loggers
      .db()
      .warn("decryptObject failed — returning raw value", { error: err });
    return obj;
  }
}

// Pass-through for DataSource config - encryption handled at route using connector schema
function encryptDataSourceConfig(config: any): any {
  return config;
}

function decryptDataSourceConfig(config: any): any {
  return config;
}

/**
 * Workspace model interface
 */
export interface IWorkspaceBilling {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus:
    | "active"
    | "past_due"
    | "canceled"
    | "trialing"
    | "incomplete"
    | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  plan: "free" | "pro" | "enterprise";
  lastReportedOverageCents?: number;
  pendingReportedOverageCents?: number | null;
  pendingMeterEventIdempotencyKey?: string | null;
}

export interface IWorkspace extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  settings: {
    maxDatabases: number;
    maxMembers: number;
    billingTier: "free" | "pro" | "enterprise";
    customPrompt?: string;
    disabledModelIds?: string[];
  };
  billing: IWorkspaceBilling;
  selfDirective?: string;
  apiKeys?: IWorkspaceApiKey[];
}

/**
 * API Key interface for workspace authentication
 */
export interface IWorkspaceApiKey {
  _id?: Types.ObjectId;
  name: string;
  keyHash: string;
  prefix: string; // First 8 characters to help identify the key
  createdAt: Date;
  lastUsedAt?: Date;
  createdBy: string;
}

/**
 * WorkspaceMember model interface
 */
export interface IWorkspaceMember extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: Date;
  /** True only for the first workspace auto-created during user onboarding */
  isDefaultMembership?: boolean;
}

/**
 * WorkspaceInvite model interface
 */
export interface IWorkspaceInvite extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email: string;
  token: string;
  role: "admin" | "member" | "viewer";
  invitedBy: string;
  expiresAt: Date;
  acceptedAt?: Date;
}

/**
 * DatabaseConnection model interface
 * Represents a saved connection to a database server (may contain multiple databases)
 */
export interface IDatabaseConnection extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  type:
    | "mongodb"
    | "postgresql"
    | "redshift"
    | "cloudsql-postgres"
    | "mysql"
    | "sqlite"
    | "mssql"
    | "bigquery"
    | "clickhouse"
    | "cloudflare-d1"
    | "cloudflare-kv";
  connection: {
    host?: string;
    port?: number;
    database?: string; // Optional: specific database within the server
    username?: string;
    password?: string;
    connectionString?: string;
    authSource?: string;
    replicaSet?: string;
    ssl?: boolean;
    // Cloud SQL Postgres
    instanceConnectionName?: string; // e.g., "my-project:region:instance"
    instance_connection_name?: string; // snake_case variant supported
    domainName?: string; // optional DNS domain for automatic failover
    domain_name?: string;
    authType?: string; // 'IAM' or 'PASSWORD'
    ipType?: string; // 'PUBLIC' | 'PRIVATE'
    service_account_json?: string; // Stored encrypted
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
  };
  isDemo?: boolean; // True if this is a demo database connection
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt?: Date;
}

/** @deprecated Use IDatabaseConnection instead */
export type IDatabase = IDatabaseConnection;

/**
 * Connector model interface
 */
export interface IConnector extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  type: string;
  description?: string;
  config: {
    // API sources
    api_key?: string;
    api_base_url?: string;

    // GraphQL sources
    endpoint?: string;
    headers?: { [key: string]: string };
    queries?: Array<{
      name: string;
      query: string;
      variables?: { [key: string]: any };
      dataPath?: string;
      hasNextPagePath?: string;
      cursorPath?: string;
      totalCountPath?: string;
    }>;

    // Database sources
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    connection_string?: string;

    // Additional fields
    [key: string]: any;
  };
  settings: {
    sync_batch_size: number;
    rate_limit_delay_ms: number;
    max_retries?: number;
    timeout_ms?: number;
    timezone?: string;
  };
  targetDatabases?: Types.ObjectId[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastSyncedAt?: Date;
  isActive: boolean;
}

/**
 * ConsoleFolder model interface
 */
export interface IConsoleFolder extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId;
  /** @deprecated Use `access` instead */
  isPrivate: boolean;
  ownerId?: string;
  access: ConsoleAccessLevel;
  createdAt: Date;
}

/**
 * Console access level (visibility scope).
 * - 'private': only the owner can see/edit (default for new consoles)
 * - 'workspace': visible to all workspace members (admins can edit; others read-only unless owner)
 */
export type ConsoleAccessLevel = "private" | "workspace";

/**
 * Google Workspace-style sharing primitives, shared by dashboards, consoles
 * and apps.
 *
 * - `sharedWith` entries grant a specific user `viewer` (read) or `editor`
 *   (read + write) access regardless of the resource's `access` scope.
 * - `workspaceRole` is the role every workspace member gets when the
 *   resource's `access` is "workspace" (workspace members with the `viewer`
 *   member role are always capped to viewer).
 * - `publicShare` (dashboards + apps only) exposes the resource read-only at
 *   /share/:token, optionally protected by a bcrypt-hashed password. Public
 *   viewers see materialized snapshot artifacts by default. When the owner
 *   opts in with `allowLiveQueries`, an app's public viewer may also re-run the
 *   app's *published* (owner-defined, never viewer-supplied) live bindings
 *   server-side under the owner's connection — read-only and row-capped, so
 *   "live" never means "arbitrary".
 */
export type ResourceShareRole = "viewer" | "editor";

export interface IResourceShareEntry {
  userId: string;
  role: ResourceShareRole;
  addedAt: Date;
  addedBy?: string;
}

export interface IPublicShare {
  enabled: boolean;
  token?: string;
  passwordHash?: string | null;
  /** AES-encrypted copy so owners/admins can reveal the password in the UI. */
  passwordEncrypted?: string | null;
  createdAt?: Date;
  createdBy?: string;
  /** Throttle marker for the anonymous "Refresh data" action (dashboards). */
  lastPublicRefreshAt?: Date;
  /**
   * Apps only. When true, the public viewer may execute the app's published
   * live bindings server-side (read-only, row-capped, rate-limited) instead of
   * being limited to frozen snapshots. Default false — existing shares stay
   * snapshot-only. The query is always the owner's published SQL; the viewer
   * never supplies SQL.
   */
  allowLiveQueries?: boolean;
}

/**
 * SavedConsole model interface
 *
 * Consoles can be:
 * 1. Saved consoles: isSaved=true, explicitly saved by user to a path
 * 2. Draft consoles: isSaved=false/undefined, auto-saved when content is modified
 *
 * Draft consoles are restored when opening a chat by scanning the chat's
 * modify_console and create_console tool calls to find which console IDs were used.
 * Only saved consoles (isSaved=true) appear in the console explorer.
 *
 * Access model (added in console-access-model migration):
 * - `access` is the source of truth for visibility/editability ('private' | 'workspace')
 * - `isPrivate` is kept for backward compatibility (deprecated; use `access` instead)
 * - `owner_id` tracks the console creator; backfilled from `createdBy`
 */
export interface ISavedConsole extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  folderId?: Types.ObjectId;
  connectionId?: Types.ObjectId;
  databaseName?: string;
  databaseId?: string;
  name: string;
  description?: string;
  descriptionEmbedding?: number[];
  embeddingModel?: string;
  descriptionGeneratedAt?: Date;
  code: string;
  language: "sql" | "javascript" | "mongodb";
  chartSpec?: Record<string, unknown>;
  resultsViewMode?: "table" | "json" | "chart";
  mongoOptions?: {
    collection: string;
    operation:
      | "find"
      | "aggregate"
      | "insertMany"
      | "updateMany"
      | "deleteMany"
      | "findOne"
      | "updateOne"
      | "deleteOne";
  };
  createdBy: string;
  /** @deprecated Use `access` field instead */
  isPrivate: boolean;
  isSaved: boolean; // true = explicitly saved, false/undefined = draft
  access: ConsoleAccessLevel;
  /** Role granted to workspace members when access is "workspace". */
  workspaceRole?: ResourceShareRole;
  /** Per-user collaborators (viewer/editor), independent of `access`. */
  sharedWith?: IResourceShareEntry[];
  owner_id: string;
  schedule?: {
    cron: string;
    timezone: string;
  };
  scheduledRun?: {
    nextAt?: Date;
    lastAt?: Date;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    lastRowsAffected?: number;
    lastRowCount?: number;
    runCount: number;
    consecutiveFailures: number;
  };
  /**
   * Explicit-save snapshot counter (optimistic concurrency for the Save
   * action; see PUT /consoles/:id `expectedVersion`). Unchanged by drafts.
   */
  version: number;
  /**
   * Monotonic draft revision: bumped on EVERY content-bearing write (user
   * autosave, explicit save, agent modify). Drives the realtime
   * poke-then-pull sync — clients compare revisions and refetch when stale.
   * Legacy documents without the field count as revision 1.
   */
  draftRevision: number;
  /**
   * Who produced the most recent content-bearing draft write: "agent"
   * (modify_console / create_console) or "user" (autosave, explicit save).
   * Lets reconnecting clients surface an agent edit as a reviewable diff even
   * when the live `console.updated` poke was missed (the revision sync echoes
   * this back). Undefined on legacy docs ⇒ treated as a user edit.
   */
  lastDraftOrigin?: "user" | "agent";
  /**
   * Latest run artifact (server-side run_console / console execution).
   * Persisted so results survive a detached agent session — when the user
   * reopens the console, the results are still there. sampleRows is capped
   * (50 rows / ~256KB) at write time.
   */
  lastRun?: {
    at: Date;
    status: "running" | "success" | "error" | "cancelled";
    rowCount?: number;
    durationMs: number;
    error?: string;
    sampleRows?: unknown[];
    fields?: unknown;
    runBy: string;
    source: string;
    /** Detached-run correlation: when the (still-running) task started. */
    startedAt?: Date;
    /** Detached-run correlation: id used to poll/cancel this execution. */
    executionId?: string;
  };
  is_deleted?: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
  executionCount: number;
}

export interface IScheduledQueryRun extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  consoleId: Types.ObjectId;
  triggeredAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: "queued" | "running" | "success" | "error";
  triggerType: "schedule" | "manual";
  triggeredBy?: string;
  durationMs?: number;
  rowsAffected?: number;
  rowCount?: number;
  error?: {
    message: string;
    code?: string;
  };
  inngestRunId?: string;
}

export type NotificationResourceType = "scheduled_query" | "flow";

export type NotificationTrigger = "success" | "failure";

export type NotificationChannelType = "email" | "webhook" | "slack";

export interface INotificationRuleChannelEmail {
  type: "email";
  recipients: string[];
}

export interface INotificationRuleChannelWebhook {
  type: "webhook";
  /** Encrypted URL */
  urlEncrypted: string;
  /** Encrypted signing secret (HMAC SHA256 over JSON body) */
  signingSecretEncrypted: string;
}

export interface INotificationRuleChannelSlack {
  type: "slack";
  /** Encrypted incoming webhook URL */
  webhookUrlEncrypted: string;
  /** UI label only, e.g. #alerts */
  displayLabel?: string;
}

export type INotificationRuleChannel =
  | INotificationRuleChannelEmail
  | INotificationRuleChannelWebhook
  | INotificationRuleChannelSlack;

export interface INotificationRule extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  resourceType: NotificationResourceType;
  resourceId: Types.ObjectId;
  enabled: boolean;
  triggers: NotificationTrigger[];
  channel: INotificationRuleChannel;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "skipped";

export interface INotificationDelivery extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  ruleId: Types.ObjectId;
  resourceType: NotificationResourceType;
  resourceId: Types.ObjectId;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  idempotencyKey: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  lastError?: string;
  httpStatus?: number;
  sentAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

/**
 * Message part types for AI SDK v6 compatibility
 * Stores parts in chronological order to preserve the original message structure
 */
export interface IMessagePart {
  type: string; // "text", "reasoning", "tool-{toolName}", "dynamic-tool"
  text?: string; // For text and reasoning parts
  reasoning?: string; // Alternative field for reasoning content
  // Provider metadata for reasoning parts. Anthropic extended thinking returns a
  // per-block `signature` (lives at providerMetadata.anthropic.signature). The
  // signature MUST round-trip byte-for-byte: on a tool-use continuation Anthropic
  // rejects the turn ("thinking ... blocks in the latest assistant message cannot
  // be modified") if a replayed thinking block lacks/alters its original
  // signature. Persisting it keeps reloaded chats continuable.
  providerMetadata?: unknown;
  toolCallId?: string; // For tool parts
  toolName?: string; // For tool parts
  input?: unknown; // Tool input/arguments (named 'input' for AI SDK v6 compat, was 'args')
  output?: unknown; // Tool result (named 'output' for AI SDK v6 compat, was 'result')
  state?: string; // Tool state: "input-streaming", "input-available", "output-streaming", "output-available", "error"
  // File parts (AI SDK FileUIPart). Without these fields, persisted attachments
  // are reduced to `{ type: "file", _id }` and break `convertToModelMessages`
  // with "The messages do not match the ModelMessage[] schema."
  url?: string; // Data URL or remote URL of the attachment
  mediaType?: string; // MIME type, e.g. "image/png"
  filename?: string; // Optional original file name
}

/**
 * Usage history entry for tracking token consumption per turn
 * Useful for metered billing and cost analysis
 */
export interface IUsageHistoryEntry {
  messageIndex: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
  timestamp: Date;
}

/**
 * Chat usage tracking for token consumption
 */
export interface IChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  history?: IUsageHistoryEntry[];
}

/**
 * Chat model interface
 */
export interface IChat extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  threadId?: string; // Custom thread ID for conversation continuity
  messages: Array<{
    id?: string; // Message ID from AI SDK (for message identification)
    role: "user" | "assistant";
    parts?: IMessagePart[]; // NEW: Raw parts array (source of truth for chronological order)
    // Legacy fields - kept for backward compatibility with existing chats
    content?: string;
    reasoning?: string[]; // Array of reasoning/thinking blocks
    toolCalls?: Array<{
      toolCallId?: string;
      toolName: string;
      timestamp?: Date;
      status?: "started" | "completed";
      input?: unknown;
      result?: unknown;
    }>;
  }>;
  activeAgent?: "mongo" | "bigquery" | "triage"; // Pinned specialist for this thread
  pinnedConsoleId?: string; // Console ID that this chat session is bound to
  createdBy: string;
  titleGenerated: boolean;
  // Resume pointer for in-flight turns: the resumable-stream ID clients can
  // reattach to via GET /api/agent/chat/:chatId/stream. Null when idle.
  activeStreamId?: string | null;
  systemPrompt?: string; // System prompt used for this conversation
  workspacePrompt?: string; // Workspace custom prompt appended to system prompt
  usage?: IChatUsage; // Token usage tracking for billing
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Chat attachment model interface.
 *
 * Chat image attachments are uploaded to object storage (filesystem / GCS / S3)
 * instead of being inlined as base64 data URLs in the chat document. This keeps
 * chat documents well under the 16 MB BSON limit (the previous behaviour caused
 * silent save failures and "lost" images on reload) and lets the browser fetch
 * each image lazily through an authenticated proxy.
 */
export interface IChatAttachment extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  chatId: string; // Chat _id this attachment belongs to (string ObjectId hex)
  createdBy: string; // User id that owns the attachment (matches Chat.createdBy)
  storageKey: string; // Key within the object store
  mediaType: string; // MIME type, e.g. "image/png"
  filename?: string; // Optional original file name
  size: number; // Byte size of the stored object
  sha256: string; // Content hash, used to deduplicate re-uploads within a chat
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Query configuration for GraphQL/PostHog flows
 */
export interface IFlowQuery {
  name: string;
  query: string;
  variables?: { [key: string]: any };
  dataPath?: string;
  data_path?: string;
  hasNextPagePath?: string;
  has_next_page_path?: string;
  cursorPath?: string;
  cursor_path?: string;
  totalCountPath?: string;
  total_count_path?: string;
  batchSize?: number;
  batch_size?: number;
}

/**
 * Database source configuration for db-to-db flows
 */
export interface IDatabaseSource {
  connectionId: Types.ObjectId;
  database?: string; // Database name within the connection
  query: string; // SQL query to fetch data
}

/**
 * BigQuery partitioning configuration for table destination
 */
export interface ITablePartitioning {
  enabled: boolean;
  type?: "time" | "ingestion";
  field?: string;
  granularity?: "day" | "hour" | "month" | "year";
  requirePartitionFilter?: boolean;
}

/**
 * BigQuery clustering configuration for table destination
 */
export interface ITableClustering {
  enabled: boolean;
  fields?: string[];
}

/**
 * Per-entity table layout config for connector -> BigQuery flows
 */
export interface IEntityLayout {
  entity: string;
  label?: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  enabled?: boolean;
}

/**
 * Table destination configuration for writing to SQL tables
 */
export interface ITableDestination {
  connectionId: Types.ObjectId;
  database?: string;
  schema?: string;
  tableName: string;
  createIfNotExists?: boolean;
  partitioning?: ITablePartitioning;
  clustering?: ITableClustering;
}

/**
 * Incremental sync configuration
 */
export interface IIncrementalConfig {
  trackingColumn: string; // e.g., 'updated_at' or 'id'
  trackingType: "timestamp" | "numeric";
  lastValue?: string; // Last synced value (stored as string for flexibility)
}

/**
 * Conflict resolution configuration for upserts
 */
export interface IConflictConfig {
  keyColumns: string[]; // Columns that form the unique key
  strategy: "update" | "ignore" | "replace" | "upsert";
}

/**
 * Pagination configuration for database syncs
 */
export interface IPaginationConfig {
  mode: "offset" | "keyset"; // offset uses LIMIT/OFFSET, keyset uses WHERE col > last_value
  keysetColumn?: string; // Column for keyset pagination (e.g., 'id', 'created_at')
  keysetDirection?: "asc" | "desc"; // Sort direction (must match ORDER BY in query)
  lastKeysetValue?: string; // Last processed keyset value for resumption
}

/**
 * Type coercion configuration for column mapping between databases
 */
export interface ITypeCoercion {
  column: string; // Column name
  sourceType?: string; // Original type (informational)
  targetType: string; // Target type to coerce to
  format?: string; // Optional format string (e.g., for dates: 'YYYY-MM-DD')
  nullValue?: unknown; // Value to use when source is null
  transformer?: string; // Optional transformation: 'lowercase' | 'uppercase' | 'trim' | 'json_parse' | 'json_stringify'
}

export type SyncEngine = "legacy" | "cdc";

/** @deprecated Use StreamState + BackfillStatus instead */
export type SyncState =
  | "idle"
  | "backfill"
  | "catchup"
  | "live"
  | "paused"
  | "degraded";

export type StreamState = "idle" | "active" | "paused" | "error";
export type BackfillStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error";

export interface ISyncStateMeta {
  lastEvent?: string;
  lastReason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

/**
 * Flow model interface (data sync flow configuration)
 */
export interface IFlow extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  type: "scheduled" | "webhook"; // Required field

  // Source configuration - either connector or database
  sourceType: "connector" | "database";
  dataSourceId?: Types.ObjectId; // For connector sources (Stripe, Close, etc.)
  databaseSource?: IDatabaseSource; // For database sources (SQL queries)

  // Destination configuration
  destinationDatabaseId: Types.ObjectId;
  destinationDatabaseName?: string;
  tableDestination?: ITableDestination; // For writing to SQL tables instead of MongoDB collections

  schedule?: {
    enabled: boolean;
    cron?: string;
    timezone?: string;
  };
  /**
   * Optional periodic full backfill cadence for CDC flows. Independent of
   * `schedule` (which only drives `type: scheduled` batch runs). When enabled,
   * `cdcScheduledBackfillFunction` triggers `cdcBackfillService.startBackfill`
   * on the cron cadence so a streaming CDC flow gets a periodic full
   * reconciliation while the live stream stays active between runs.
   */
  backfillSchedule?: {
    enabled: boolean;
    cron?: string;
    timezone?: string;
    lastRunAt?: Date;
  };
  webhookConfig?: {
    endpoint: string;
    secret: string;
    lastReceivedAt?: Date;
    totalReceived: number;
    enabled: boolean;
  };
  entityFilter?: string[]; // Optional: specific entities to sync (for connector sources)
  queries?: IFlowQuery[]; // Queries for GraphQL/PostHog connectors
  syncMode: "full" | "incremental";
  /**
   * Destination write mode (Airbyte-style sync modes; the read mode is
   * `syncMode`):
   * - "append_dedup" (default): upsert by key — the destination holds one
   *   deduplicated row per record.
   * - "append": insert-only — every fetched record version becomes a new row
   *   (re-syncs duplicate, by design).
   * - "overwrite": full-refresh only — the destination is cleared at the
   *   start of each run, ending up as an exact snapshot.
   */
  writeMode?: "append_dedup" | "append" | "overwrite";
  syncEngine: SyncEngine;
  /** @deprecated Use streamState + backfillState.status instead */
  syncState?: SyncState;
  syncStateUpdatedAt?: Date;
  syncStateMeta?: ISyncStateMeta;
  streamState?: StreamState;
  deleteMode?: "hard" | "soft";
  entityLayouts?: IEntityLayout[];

  // Incremental and conflict config (for database sources)
  incrementalConfig?: IIncrementalConfig;
  conflictConfig?: IConflictConfig;
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
  batchSize?: number;
  backfillState?: {
    status?: BackfillStatus;
    runId?: string;
    startedAt?: Date;
    completedAt?: Date;
    consecutiveFailures?: number;
    scope?: {
      mode: "all" | "subset";
      entities?: string[];
    };
  };

  lastRunAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  nextRunAt?: Date;
  runCount: number;
  avgDurationMs?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * FlowExecution model interface
 */
export interface IFlowExecution extends Document {
  _id: Types.ObjectId;
  flowId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeat?: Date;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  success: boolean;
  duration?: number;
  logs: Array<{
    timestamp: Date;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: any;
  }>;
  error?: {
    message: string;
    stack?: string;
    code?: string | number | null;
  } | null;
  context?: any;
  system?: any;
}

/**
 * WebhookEvent model interface
 */
export interface IWebhookEvent extends Document {
  _id: Types.ObjectId;
  flowId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  eventId: string; // External event ID (e.g., Stripe's evt_xxx)
  eventType: string; // e.g., "customer.updated"
  receivedAt: Date;
  processedAt?: Date;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  rawPayload: any;
  signature?: string; // For verification
  processingDurationMs?: number;
  entity?: string;
  operation?: "upsert" | "delete";
  recordId?: string;
  applyStatus?: "pending" | "applied" | "failed" | "dropped";
  appliedAt?: Date;
  applyAttempts?: number;
  applyError?: {
    message: string;
    code?: string;
  };
}

/**
 * BigQuery CDC change event model interface
 * Canonical append-only change log for webhook + backfill writes.
 */
export interface ICdcChangeEvent extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  runId?: string;
  sourceKind: "webhook" | "backfill";
  entity: string;
  recordId: string;
  op: "upsert" | "delete";
  sourceTs: Date;
  ingestTs: Date;
  ingestSeq: number;
  idempotencyKey: string;
  payload?: any;
  webhookEventId?: string;
  stageStatus: "pending" | "staged" | "failed";
  stageAttemptCount: number;
  stagedAt?: Date;
  stageError?: {
    message: string;
    code?: string;
  };
  materializationStatus: "pending" | "applied" | "failed" | "dropped";
  materializationAttemptCount: number;
  appliedAt?: Date;
  materializationError?: {
    message: string;
    code?: string;
  };
}

/**
 * Per-flow/entity CDC state for observability and adaptive cadence
 */
export interface ICdcEntityState extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  mode: "steady" | "backfill";
  runId?: string;
  backfillStartedAt?: Date;
  backfillCompletedAt?: Date;
  lastIngestSeq: number;
  lastMaterializedSeq: number;
  lastMaterializedAt?: Date;
  backlogCount: number;
  lifetimeEventsProcessed: number;
  lifetimeRowsApplied: number;
  lastEnqueuedAt?: Date;
  mergeIntervalSeconds: number;
  backfillCursor?: Record<string, unknown>;
  consecutiveFailures: number;
  lastFailedAt?: Date;
  lastFailureError?: string;
  // Progress of an in-place destination-table repartition (layout change).
  repartition?: {
    status: "pending" | "running" | "done" | "failed";
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
  };
}

export type IBigQueryChangeEvent = ICdcChangeEvent;
export type IBigQueryCdcState = ICdcEntityState;

export interface ICdcStateTransition extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  machine?: "stream" | "backfill";
  fromState: string;
  event: string;
  toState: string;
  at: Date;
  reason?: string;
}

/**
 * QueryExecution model interface
 * Tracks all query executions for usage analytics and billing
 */
export interface IQueryExecution extends Document {
  _id: Types.ObjectId;
  executedAt: Date;

  // Who executed
  userId: string; // Always populated (user or API key owner)
  apiKeyId?: Types.ObjectId; // If executed via API key (nullable for UI sessions)

  // What was executed against
  workspaceId: Types.ObjectId;
  connectionId: Types.ObjectId; // The database connection
  databaseName?: string; // For multi-database connections (D1, clusters)

  // Optional console tracking
  consoleId?: Types.ObjectId; // If executed from a saved console

  // Execution context
  source:
    | "console_ui"
    | "console_ui_admin_override"
    | "api"
    | "agent"
    | "flow"
    | "scheduled_query";
  databaseType: string; // postgresql, mongodb, bigquery, etc.
  queryLanguage: "sql" | "mongodb" | "javascript";

  // Results
  status: "success" | "error" | "cancelled" | "timeout";
  executionTimeMs: number;
  rowCount?: number; // Rows returned (if applicable)
  errorType?: string; // If failed: syntax, connection, timeout, permission

  // Optional resource tracking (some DBs provide this)
  bytesScanned?: number; // BigQuery, ClickHouse report this
}

/**
 * Workspace Schema
 */
const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    settings: {
      maxDatabases: {
        type: Number,
        default: 5,
      },
      maxMembers: {
        type: Number,
        default: 10,
      },
      billingTier: {
        type: String,
        enum: ["free", "pro", "enterprise"],
        default: "free",
      },
      customPrompt: {
        type: String,
        default: `# Custom Prompt Configuration

This is your custom prompt that will be combined with the system prompt to provide additional context about your data and business relationships.

## Business Context
Add information about your business domain, terminology, and key concepts here.

## Data Relationships
Describe important relationships between your collections and how they connect.

## Common Queries
Document frequently requested queries or analysis patterns.

## Custom Instructions
Add any specific instructions for how the AI should interpret your data or respond to certain types of questions.

---

*This prompt is combined with the system prompt to provide context-aware responses. You can edit this through the Settings page.*`,
      },
      disabledModelIds: [{ type: String }],
    },
    billing: {
      stripeCustomerId: { type: String, default: null },
      stripeSubscriptionId: { type: String, default: null },
      subscriptionStatus: {
        type: String,
        enum: [
          "active",
          "past_due",
          "canceled",
          "trialing",
          "incomplete",
          null,
        ],
        default: null,
      },
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null },
      usageQuotaUsd: { type: Number, default: 5 },
      hardLimitUsd: { type: Number, default: 5 },
      plan: {
        type: String,
        enum: ["free", "pro", "enterprise"],
        default: "free",
      },
      lastReportedOverageCents: { type: Number, default: 0 },
      pendingReportedOverageCents: { type: Number, default: null },
      pendingMeterEventIdempotencyKey: { type: String, default: null },
    },
    selfDirective: {
      type: String,
      default: "",
      maxlength: 10000,
    },
    apiKeys: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        keyHash: {
          type: String,
          required: true,
        },
        prefix: {
          type: String,
          required: true,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
        lastUsedAt: {
          type: Date,
        },
        createdBy: {
          type: String,
          ref: "User",
          required: true,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Indexes
WorkspaceSchema.index({ createdBy: 1 });

/**
 * WorkspaceMember Schema
 */
const WorkspaceMemberSchema = new Schema<IWorkspaceMember>({
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: "Workspace",
    required: true,
  },
  userId: {
    type: String,
    ref: "User",
    required: true,
  },
  role: {
    type: String,
    enum: ["owner", "admin", "member", "viewer"],
    required: true,
  },
  joinedAt: {
    type: Date,
    default: Date.now,
  },
  isDefaultMembership: {
    type: Boolean,
    required: false,
  },
});

// Indexes
WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ userId: 1 });
// Prevent duplicate default workspace creation during concurrent onboarding requests
WorkspaceMemberSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { isDefaultMembership: true } },
);

/**
 * WorkspaceInvite Schema
 */
const WorkspaceInviteSchema = new Schema<IWorkspaceInvite>({
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: "Workspace",
    required: true,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
    default: () => uuidv4().replace(/-/g, ""),
  },
  role: {
    type: String,
    enum: ["admin", "member", "viewer"],
    required: true,
  },
  invitedBy: {
    type: String,
    ref: "User",
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
  acceptedAt: {
    type: Date,
  },
});

// Indexes
WorkspaceInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
WorkspaceInviteSchema.index({ workspaceId: 1, email: 1 });

/**
 * DatabaseConnection Schema
 * Represents a saved connection to a database server
 */
const DatabaseConnectionSchema = new Schema<IDatabaseConnection>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: [
        "mongodb",
        "postgresql",
        "redshift",
        "cloudsql-postgres",
        "mysql",
        "sqlite",
        "mssql",
        "bigquery",
        "clickhouse",
        "cloudflare-d1",
        "cloudflare-kv",
      ],
      required: true,
    },
    connection: {
      type: Schema.Types.Mixed,
      required: true,
      set: encryptObject,
      get: decryptObject,
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    lastConnectedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "databaseconnections",
  },
);

// Indexes
DatabaseConnectionSchema.index({ workspaceId: 1 });
DatabaseConnectionSchema.index({ workspaceId: 1, name: 1 });

/**
 * Connector Schema
 */
const ConnectorSchema = new Schema<IConnector>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      trim: true,
    },
    config: {
      type: Schema.Types.Mixed,
      required: true,
      set: encryptDataSourceConfig,
      get: decryptDataSourceConfig,
    },
    settings: {
      sync_batch_size: {
        type: Number,
        required: true,
      },
      rate_limit_delay_ms: {
        type: Number,
        required: true,
      },
      max_retries: {
        type: Number,
      },
      timeout_ms: {
        type: Number,
      },
      timezone: {
        type: String,
      },
    },
    targetDatabases: [
      {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
    ],
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    lastSyncedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "connectors",
  },
);

// Indexes
ConnectorSchema.index({ workspaceId: 1 });
ConnectorSchema.index({ workspaceId: 1, type: 1 });

/**
 * ConsoleFolder Schema
 */
const ConsoleFolderSchema = new Schema<IConsoleFolder>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "ConsoleFolder",
    },
    /** @deprecated Use `access` instead */
    isPrivate: {
      type: Boolean,
      default: false,
    },
    ownerId: {
      type: String,
      ref: "User",
    },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Indexes
ConsoleFolderSchema.index({ workspaceId: 1, parentId: 1 });
ConsoleFolderSchema.index({ workspaceId: 1, ownerId: 1, isPrivate: 1 });
ConsoleFolderSchema.index({ workspaceId: 1, access: 1 });

/**
 * Shared sharing sub-schemas (dashboards, consoles, apps).
 */
const ResourceShareEntrySchema = new Schema<IResourceShareEntry>(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["viewer", "editor"], default: "editor" },
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: String },
  },
  { _id: false },
);

const PublicShareSchema = new Schema<IPublicShare>(
  {
    enabled: { type: Boolean, default: false },
    token: { type: String },
    passwordHash: { type: String, default: null },
    passwordEncrypted: { type: String, default: null },
    createdAt: { type: Date },
    createdBy: { type: String },
    lastPublicRefreshAt: { type: Date },
    allowLiveQueries: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * SavedConsole Schema
 */
const SavedConsoleSchema = new Schema<ISavedConsole>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "ConsoleFolder",
    },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: false,
    },
    databaseName: {
      type: String,
      required: false,
    },
    databaseId: {
      type: String,
      required: false,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    descriptionEmbedding: {
      type: [Number],
      select: false,
    },
    embeddingModel: {
      type: String,
    },
    descriptionGeneratedAt: {
      type: Date,
    },
    code: {
      type: String,
      required: true,
    },
    language: {
      type: String,
      enum: ["sql", "javascript", "mongodb"],
      required: true,
    },
    chartSpec: {
      type: Schema.Types.Mixed,
    },
    resultsViewMode: {
      type: String,
      enum: ["table", "json", "chart"],
    },
    mongoOptions: {
      collection: String,
      operation: {
        type: String,
        enum: [
          "find",
          "aggregate",
          "insertMany",
          "updateMany",
          "deleteMany",
          "findOne",
          "updateOne",
          "deleteOne",
        ],
      },
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    /** @deprecated Kept for backward compat; use `access` instead */
    isPrivate: {
      type: Boolean,
      default: false,
    },
    isSaved: {
      type: Boolean,
      default: false, // Drafts default to false, explicitly saved consoles set to true
    },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
    workspaceRole: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    sharedWith: {
      type: [ResourceShareEntrySchema],
      default: [],
    },
    owner_id: {
      type: String,
      ref: "User",
    },
    schedule: {
      cron: {
        type: String,
        trim: true,
      },
      timezone: {
        type: String,
        trim: true,
      },
    },
    scheduledRun: {
      nextAt: {
        type: Date,
      },
      lastAt: {
        type: Date,
      },
      lastStatus: {
        type: String,
        enum: ["success", "error"],
      },
      lastError: {
        type: String,
      },
      lastDurationMs: {
        type: Number,
      },
      lastRowsAffected: {
        type: Number,
      },
      lastRowCount: {
        type: Number,
      },
      runCount: {
        type: Number,
        default: 0,
      },
      consecutiveFailures: {
        type: Number,
        default: 0,
      },
    },
    lastExecutedAt: {
      type: Date,
    },
    executionCount: {
      type: Number,
      default: 0,
    },
    version: {
      type: Number,
      default: 1,
    },
    // Bumped on every content-bearing write; legacy docs without it are
    // treated as revision 1 (same convention as `version`).
    draftRevision: {
      type: Number,
      default: 1,
    },
    // Origin of the latest content-bearing draft write ("agent" | "user").
    // Drives reconnect-safe agent diff review; undefined ⇒ treated as "user".
    lastDraftOrigin: {
      type: String,
      enum: ["user", "agent"],
      required: false,
    },
    // Latest server-side run artifact. Schema.Types.Mixed members are
    // size-capped by the writer (console-execution.service.ts).
    lastRun: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          status: {
            type: String,
            enum: ["running", "success", "error", "cancelled"],
            required: true,
          },
          rowCount: { type: Number },
          durationMs: { type: Number, required: true },
          error: { type: String },
          sampleRows: { type: [Schema.Types.Mixed] },
          fields: { type: Schema.Types.Mixed },
          runBy: { type: String, required: true },
          source: { type: String, required: true },
          startedAt: { type: Date },
          executionId: { type: String },
        },
        { _id: false },
      ),
      required: false,
    },
    is_deleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
SavedConsoleSchema.index({ workspaceId: 1, folderId: 1 });
SavedConsoleSchema.index({ workspaceId: 1, "sharedWith.userId": 1 });
SavedConsoleSchema.index({ workspaceId: 1, createdBy: 1, isPrivate: 1 });
SavedConsoleSchema.index({ workspaceId: 1, isSaved: 1 }); // For filtering saved vs draft consoles
SavedConsoleSchema.index({ connectionId: 1 }, { sparse: true }); // Sparse index since connectionId is optional
SavedConsoleSchema.index({ workspaceId: 1, access: 1, owner_id: 1 }); // Console access model queries
SavedConsoleSchema.index(
  { workspaceId: 1, "scheduledRun.nextAt": 1 },
  { sparse: true },
);
SavedConsoleSchema.index(
  { name: "text", description: "text" },
  {
    name: "console_text_search",
    // CRITICAL: without this, MongoDB interprets the console's `language`
    // field ("sql" | "javascript" | "mongodb") as the text-index language
    // override and rejects every insert/update with "language override
    // unsupported: sql". Point the override at a field that never exists.
    language_override: "_textSearchLanguage",
  },
);

/**
 * Chat Schema
 */
const ChatSchema = new Schema<IChat>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    threadId: {
      type: String,
      unique: true,
      sparse: true, // Allow null values but ensure uniqueness when present
    },
    messages: [
      {
        id: {
          type: String,
          required: false,
        },
        role: {
          type: String,
          enum: ["user", "assistant"],
          required: true,
        },
        // NEW: parts array - source of truth for message structure and chronological order
        parts: [
          {
            type: {
              type: String,
              required: true,
            },
            text: String,
            reasoning: String,
            // Anthropic extended-thinking signature (and any other provider
            // metadata) for reasoning parts. Must persist so a reloaded chat can
            // replay thinking blocks byte-for-byte on a tool-use continuation;
            // otherwise Anthropic rejects the turn with "thinking ... blocks in
            // the latest assistant message cannot be modified".
            providerMetadata: Schema.Types.Mixed,
            toolCallId: String,
            toolName: String,
            input: Schema.Types.Mixed,
            output: Schema.Types.Mixed,
            state: String,
            // File parts (AI SDK FileUIPart). Persisting these keeps attachments
            // round-trippable; without them Mongoose strict mode strips the
            // fields and breaks convertToModelMessages on the next turn.
            url: String,
            mediaType: String,
            filename: String,
          },
        ],
        // Legacy fields - kept for backward compatibility with existing chats
        content: {
          type: String,
          required: false,
          default: "",
        },
        reasoning: {
          type: [String],
          required: false,
        },
        toolCalls: [
          {
            toolCallId: {
              type: String,
              required: false,
            },
            toolName: {
              type: String,
              required: true,
            },
            timestamp: {
              type: Date,
              default: Date.now,
            },
            status: {
              type: String,
              enum: ["started", "completed"],
              default: "completed",
            },
            input: {
              type: Schema.Types.Mixed,
            },
            result: {
              type: Schema.Types.Mixed,
            },
          },
        ],
      },
    ],
    activeAgent: {
      type: String,
      enum: ["mongo", "bigquery", "triage"],
      required: false,
    },
    pinnedConsoleId: {
      type: String,
      required: false,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    titleGenerated: {
      type: Boolean,
      default: false,
    },
    activeStreamId: {
      type: String,
      default: null,
    },
    systemPrompt: {
      type: String,
      required: false,
    },
    workspacePrompt: {
      type: String,
      required: false,
    },
    usage: {
      promptTokens: {
        type: Number,
        default: 0,
      },
      completionTokens: {
        type: Number,
        default: 0,
      },
      totalTokens: {
        type: Number,
        default: 0,
      },
      cacheReadTokens: {
        type: Number,
        default: 0,
      },
      cacheWriteTokens: {
        type: Number,
        default: 0,
      },
      reasoningTokens: {
        type: Number,
        default: 0,
      },
      costUsd: {
        type: Number,
        default: 0,
      },
      history: [
        {
          messageIndex: {
            type: Number,
            required: true,
          },
          promptTokens: {
            type: Number,
            required: true,
          },
          completionTokens: {
            type: Number,
            required: true,
          },
          totalTokens: {
            type: Number,
            required: true,
          },
          cacheReadTokens: {
            type: Number,
            default: 0,
          },
          cacheWriteTokens: {
            type: Number,
            default: 0,
          },
          reasoningTokens: {
            type: Number,
            default: 0,
          },
          costUsd: {
            type: Number,
            default: 0,
          },
          model: {
            type: String,
            required: false,
          },
          timestamp: {
            type: Date,
            default: Date.now,
          },
        },
      ],
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
ChatSchema.index({ workspaceId: 1 });
ChatSchema.index({ workspaceId: 1, title: 1 });
ChatSchema.index({ workspaceId: 1, createdBy: 1 }); // For user-specific chat queries

/**
 * Chat Attachment Schema
 *
 * Stores metadata for chat image attachments whose bytes live in object
 * storage. The proxy route streams these back to the browser, and the agent
 * route resolves them to data URLs when replaying history to the model.
 */
const ChatAttachmentSchema = new Schema<IChatAttachment>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    chatId: {
      type: String,
      required: true,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
    },
    mediaType: {
      type: String,
      required: true,
    },
    filename: {
      type: String,
      required: false,
    },
    size: {
      type: Number,
      required: true,
    },
    sha256: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Dedupe re-uploads of the same image within a chat (same bytes -> same doc).
ChatAttachmentSchema.index(
  { workspaceId: 1, chatId: 1, sha256: 1 },
  { unique: true },
);

/**
 * Flow Schema (data sync flow configuration)
 */
const FlowSchema = new Schema<IFlow>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    type: {
      type: String,
      enum: ["scheduled", "webhook"],
      required: true,
    },
    // Source type discriminator - defaults to "connector" for backward compatibility
    sourceType: {
      type: String,
      enum: ["connector", "database"],
      default: "connector",
    },
    // For connector sources (Stripe, Close, GraphQL, etc.)
    dataSourceId: {
      type: Schema.Types.ObjectId,
      ref: "Connector",
      required: function () {
        return (this as any).sourceType !== "database";
      },
    },
    // For database sources (SQL queries)
    databaseSource: {
      connectionId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      database: String,
      query: String,
    },
    destinationDatabaseId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    destinationDatabaseName: {
      type: String,
      required: false,
    },
    // For writing to SQL tables instead of MongoDB collections
    tableDestination: {
      connectionId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      database: String,
      schema: String,
      tableName: String,
      createIfNotExists: {
        type: Boolean,
        default: true,
      },
      partitioning: {
        enabled: { type: Boolean, default: false },
        type: { type: String, enum: ["time", "ingestion"] },
        field: String,
        granularity: { type: String, enum: ["day", "hour", "month", "year"] },
        requirePartitionFilter: { type: Boolean, default: false },
      },
      clustering: {
        enabled: { type: Boolean, default: false },
        fields: [String],
      },
    },
    schedule: {
      enabled: {
        type: Boolean,
        default: true,
      },
      cron: {
        type: String,
        // Requiredness stays keyed to `type` for back-compat: webhook flows
        // carry the default `schedule.enabled: true` with no cron. Under the
        // unified trigger model, "cron present when schedule is enabled" is
        // enforced at the route boundary independent of `type` (see
        // routes/flows.ts) and a poll trigger only exists when a cron is set
        // (see services/flow-triggers.service.ts).
        required: function () {
          return this.type === "scheduled" && this.schedule?.enabled;
        },
        validate: {
          validator: function (v: string) {
            // Absence is handled by `required`; any present cron must be
            // well-formed regardless of flow type.
            if (!v) return true;
            // Basic cron validation - 5 or 6 fields
            const fields = v.split(" ");
            return fields.length === 5 || fields.length === 6;
          },
          message: "Invalid cron expression",
        },
      },
      timezone: {
        type: String,
        default: "UTC",
      },
    },
    backfillSchedule: {
      enabled: {
        type: Boolean,
        default: false,
      },
      cron: {
        type: String,
        validate: {
          validator: function (v: string) {
            if (!v) return true;
            const fields = v.split(" ");
            return fields.length === 5 || fields.length === 6;
          },
          message: "Invalid cron expression",
        },
      },
      timezone: {
        type: String,
        default: "UTC",
      },
      lastRunAt: Date,
    },
    webhookConfig: {
      endpoint: {
        type: String,
        unique: true,
        sparse: true,
      },
      secret: {
        type: String,
      },
      lastReceivedAt: Date,
      totalReceived: {
        type: Number,
        default: 0,
      },
      enabled: {
        type: Boolean,
        default: true,
      },
    },
    entityFilter: [String],
    queries: [
      {
        name: { type: String, required: true },
        query: { type: String, required: true },
        variables: { type: Schema.Types.Mixed },
        dataPath: String,
        data_path: String,
        hasNextPagePath: String,
        has_next_page_path: String,
        cursorPath: String,
        cursor_path: String,
        totalCountPath: String,
        total_count_path: String,
        batchSize: Number,
        batch_size: Number,
      },
    ],
    syncMode: {
      type: String,
      enum: ["full", "incremental"],
      default: "full",
    },
    writeMode: {
      type: String,
      enum: ["append_dedup", "append", "overwrite"],
      default: "append_dedup",
    },
    syncEngine: {
      type: String,
      enum: ["legacy", "cdc"],
      default: "legacy",
      required: true,
    },
    syncState: {
      type: String,
      enum: ["idle", "backfill", "catchup", "live", "paused", "degraded"],
      default: "idle",
    },
    syncStateUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    syncStateMeta: {
      lastEvent: String,
      lastReason: String,
      lastErrorCode: String,
      lastErrorMessage: String,
    },
    streamState: {
      type: String,
      enum: ["idle", "active", "paused", "error"],
      default: "idle",
    },
    deleteMode: {
      type: String,
      enum: ["hard", "soft"],
    },
    entityLayouts: [
      {
        entity: { type: String, required: true },
        label: String,
        partitionField: { type: String, required: true },
        partitionGranularity: {
          type: String,
          enum: ["day", "hour", "month", "year"],
          default: "day",
        },
        clusterFields: [String],
        enabled: { type: Boolean, default: true },
      },
    ],
    // Incremental config for database sources
    incrementalConfig: {
      trackingColumn: String,
      trackingType: {
        type: String,
        enum: ["timestamp", "numeric"],
      },
      lastValue: String,
    },
    // Conflict resolution for upserts
    conflictConfig: {
      keyColumns: [String],
      strategy: {
        type: String,
        enum: ["update", "ignore", "replace", "upsert"],
        default: "update",
      },
    },
    // Pagination mode for database syncs
    paginationConfig: {
      mode: {
        type: String,
        enum: ["offset", "keyset"],
        default: "offset",
      },
      keysetColumn: String,
      keysetDirection: {
        type: String,
        enum: ["asc", "desc"],
        default: "asc",
      },
      lastKeysetValue: String,
    },
    // Type coercion rules for column mapping
    typeCoercions: [
      {
        column: { type: String, required: true },
        sourceType: String,
        targetType: { type: String, required: true },
        format: String,
        nullValue: Schema.Types.Mixed,
        transformer: {
          type: String,
          enum: [
            "lowercase",
            "uppercase",
            "trim",
            "json_parse",
            "json_stringify",
          ],
        },
      },
    ],
    batchSize: {
      type: Number,
      default: 2000,
      min: 100,
      max: 50000,
    },
    backfillState: {
      status: {
        type: String,
        enum: ["idle", "running", "paused", "completed", "error"],
        default: "idle",
      },
      runId: String,
      startedAt: Date,
      completedAt: Date,
      consecutiveFailures: { type: Number, default: 0 },
      scope: {
        mode: {
          type: String,
          enum: ["all", "subset"],
          default: "all",
        },
        entities: [String],
      },
    },
    lastRunAt: Date,
    lastSuccessAt: Date,
    lastError: String,
    nextRunAt: Date,
    runCount: {
      type: Number,
      default: 0,
    },
    avgDurationMs: Number,
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "flows",
  },
);

// Indexes
FlowSchema.index({ workspaceId: 1, "schedule.enabled": 1 });
FlowSchema.index({ workspaceId: 1, sourceType: 1 });
FlowSchema.index({ dataSourceId: 1 }, { sparse: true }); // Sparse since not required for database sources
FlowSchema.index({ "databaseSource.connectionId": 1 }, { sparse: true });
FlowSchema.index({ destinationDatabaseId: 1 });
FlowSchema.index({ "tableDestination.connectionId": 1 }, { sparse: true });
FlowSchema.index({ nextRunAt: 1 });
FlowSchema.index({ workspaceId: 1, syncEngine: 1 });
FlowSchema.index({ syncEngine: 1, "backfillSchedule.enabled": 1 });

/**
 * FlowExecution Schema (binds to 'flow_executions' collection)
 */
const FlowExecutionSchema = new Schema<IFlowExecution>(
  {
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    startedAt: { type: Date, required: true },
    completedAt: Date,
    lastHeartbeat: Date,
    status: {
      type: String,
      enum: ["running", "completed", "failed", "cancelled", "abandoned"],
      required: true,
    },
    success: { type: Boolean, required: true },
    duration: Number,
    logs: [
      {
        timestamp: { type: Date, required: true },
        level: {
          type: String,
          enum: ["debug", "info", "warn", "error"],
          required: true,
        },
        message: { type: String, required: true },
        metadata: Schema.Types.Mixed,
      },
    ],
    error: Schema.Types.Mixed,
    context: Schema.Types.Mixed,
    system: Schema.Types.Mixed,
  },
  {
    collection: "flow_executions",
    timestamps: false,
  },
);

// Indexes
FlowExecutionSchema.index({ flowId: 1, startedAt: -1 });

/**
 * WebhookEvent Schema
 */
const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: Date,
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0 },
    error: {
      message: String,
      stack: String,
      code: String,
    },
    rawPayload: { type: Schema.Types.Mixed, required: true },
    signature: String,
    processingDurationMs: Number,
    entity: String,
    operation: {
      type: String,
      enum: ["upsert", "delete"],
    },
    recordId: String,
    applyStatus: {
      type: String,
      enum: ["pending", "applied", "failed", "dropped"],
      default: "pending",
      required: true,
    },
    appliedAt: Date,
    applyAttempts: { type: Number, default: 0 },
    applyError: {
      message: String,
      code: String,
    },
  },
  {
    timestamps: false,
  },
);

// Indexes
WebhookEventSchema.index({ flowId: 1, eventId: 1 }, { unique: true });
WebhookEventSchema.index({ flowId: 1, status: 1, receivedAt: 1 });
WebhookEventSchema.index({ flowId: 1, applyStatus: 1, receivedAt: 1 });
// Supports the GLOBAL cron-ingest query in cdcMaterializeSchedulerFunction:
// find({ status: "pending" }).sort({ receivedAt: 1 }). Without a flowId-free
// index this query does a COLLSCAN + in-memory sort over the whole collection.
WebhookEventSchema.index({ status: 1, receivedAt: 1 });
WebhookEventSchema.index({ workspaceId: 1, receivedAt: -1 });
// Tiered retention by applyStatus (anchored on receivedAt, which is required on
// every doc so the four partial TTLs fully cover the collection). MongoDB allows
// multiple TTL indexes on the same key when they differ by partialFilterExpression
// (same pattern as cdc_change_events applied-vs-dropped). Successfully processed
// events are purged quickly; errors are retained longer for debugging.
/** Successfully processed -> short retention. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_applied_ttl_3d",
    expireAfterSeconds: 3 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "applied" },
  },
);
/** Awaiting destination apply -> safety net (matches prior flat behavior). */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_pending_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "pending" },
  },
);
/** Intentionally skipped -> keep longer for audit. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_dropped_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "dropped" },
  },
);
/** Errors -> retained longest for debugging. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_failed_ttl_30d",
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "failed" },
  },
);

/**
 * CdcChangeEvent Schema
 */
const CdcChangeEventSchema = new Schema<ICdcChangeEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    runId: String,
    sourceKind: {
      type: String,
      enum: ["webhook", "backfill"],
      required: true,
    },
    entity: { type: String, required: true },
    recordId: { type: String, required: true },
    op: { type: String, enum: ["upsert", "delete"], required: true },
    sourceTs: { type: Date, required: true },
    ingestTs: { type: Date, required: true, default: Date.now },
    ingestSeq: { type: Number, required: true },
    idempotencyKey: { type: String, required: true },
    payload: Schema.Types.Mixed,
    webhookEventId: String,
    stageStatus: {
      type: String,
      enum: ["pending", "staged", "failed"],
      default: "pending",
      required: true,
    },
    stageAttemptCount: { type: Number, default: 0 },
    stagedAt: Date,
    stageError: {
      message: String,
      code: String,
    },
    materializationStatus: {
      type: String,
      enum: ["pending", "applied", "failed", "dropped"],
      default: "pending",
      required: true,
    },
    materializationAttemptCount: { type: Number, default: 0 },
    appliedAt: Date,
    materializationError: {
      message: String,
      code: String,
    },
  },
  {
    collection: "cdc_change_events",
    timestamps: false,
  },
);

CdcChangeEventSchema.index({ idempotencyKey: 1 }, { unique: true });
CdcChangeEventSchema.index({ flowId: 1, entity: 1, ingestSeq: 1 });
CdcChangeEventSchema.index(
  { flowId: 1, entity: 1, recordId: 1, sourceTs: 1, ingestSeq: 1 },
  { unique: true },
);
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  sourceTs: 1,
  ingestSeq: 1,
});
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  materializationStatus: 1,
  ingestSeq: 1,
});
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  stageStatus: 1,
  ingestSeq: 1,
});
/** Successfully materialized rows — shorter retention. */
CdcChangeEventSchema.index(
  { appliedAt: 1 },
  {
    name: "cdc_applied_events_ttl_36h",
    expireAfterSeconds: 36 * 60 * 60,
    partialFilterExpression: {
      appliedAt: { $exists: true },
      materializationStatus: "applied",
    },
  },
);
/** Dropped rows (e.g. entity disabled) — keep longer for audit. */
CdcChangeEventSchema.index(
  { appliedAt: 1 },
  {
    name: "cdc_dropped_events_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: {
      appliedAt: { $exists: true },
      materializationStatus: "dropped",
    },
  },
);

/**
 * CdcEntityState schema
 */
const CdcEntityStateSchema = new Schema<ICdcEntityState>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    entity: { type: String, required: true },
    mode: {
      type: String,
      enum: ["steady", "backfill"],
      default: "steady",
      required: true,
    },
    runId: String,
    backfillStartedAt: Date,
    backfillCompletedAt: Date,
    lastIngestSeq: { type: Number, default: 0 },
    lastMaterializedSeq: { type: Number, default: 0 },
    lastMaterializedAt: Date,
    backlogCount: { type: Number, default: 0 },
    lifetimeEventsProcessed: { type: Number, default: 0 },
    lifetimeRowsApplied: { type: Number, default: 0 },
    lastEnqueuedAt: Date,
    mergeIntervalSeconds: { type: Number, default: 300 },
    backfillCursor: Schema.Types.Mixed,
    consecutiveFailures: { type: Number, default: 0 },
    lastFailedAt: Date,
    lastFailureError: String,
    repartition: {
      status: {
        type: String,
        enum: ["pending", "running", "done", "failed"],
      },
      startedAt: Date,
      completedAt: Date,
      error: String,
    },
  },
  {
    collection: "cdc_entity_state",
    timestamps: false,
  },
);

CdcEntityStateSchema.index({ flowId: 1, entity: 1 }, { unique: true });
CdcEntityStateSchema.index({ workspaceId: 1, flowId: 1 });

const CdcStateTransitionSchema = new Schema<ICdcStateTransition>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    machine: {
      type: String,
      enum: ["stream", "backfill"],
    },
    fromState: {
      type: String,
      required: true,
    },
    event: { type: String, required: true },
    toState: {
      type: String,
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
    reason: String,
  },
  {
    collection: "cdc_state_transitions",
    timestamps: false,
  },
);

CdcStateTransitionSchema.index({ flowId: 1, at: -1 });
CdcStateTransitionSchema.index({ workspaceId: 1, flowId: 1, at: -1 });

/**
 * QueryExecution Schema
 * Tracks all query executions for usage analytics and billing
 */
const QueryExecutionSchema = new Schema<IQueryExecution>(
  {
    executedAt: { type: Date, required: true, default: Date.now },

    // Who executed
    userId: { type: String, ref: "User", required: true },
    apiKeyId: { type: Schema.Types.ObjectId, required: false },

    // What was executed against
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    databaseName: { type: String, required: false },

    // Optional console tracking
    consoleId: {
      type: Schema.Types.ObjectId,
      ref: "SavedConsole",
      required: false,
    },

    // Execution context
    source: {
      type: String,
      enum: [
        "console_ui",
        "console_ui_admin_override",
        "api",
        "agent",
        "flow",
        "scheduled_query",
      ],
      required: true,
    },
    databaseType: { type: String, required: true },
    queryLanguage: {
      type: String,
      enum: ["sql", "mongodb", "javascript"],
      required: true,
    },

    // Results
    status: {
      type: String,
      enum: ["success", "error", "cancelled", "timeout"],
      required: true,
    },
    executionTimeMs: { type: Number, required: true },
    rowCount: { type: Number, required: false },
    errorType: { type: String, required: false },

    // Optional resource tracking
    bytesScanned: { type: Number, required: false },
  },
  {
    collection: "query_executions",
    timestamps: false,
  },
);

// Indexes for QueryExecution
QueryExecutionSchema.index({ workspaceId: 1, executedAt: -1 }); // Usage over time per workspace
QueryExecutionSchema.index({ userId: 1, executedAt: -1 }); // Per-user analytics
QueryExecutionSchema.index({ apiKeyId: 1, executedAt: -1 }, { sparse: true }); // API key usage
QueryExecutionSchema.index({ workspaceId: 1, status: 1 }); // Error rate monitoring
QueryExecutionSchema.index({ executedAt: 1 }, { expireAfterSeconds: 7776000 }); // TTL: 90 days

const ScheduledQueryRunSchema = new Schema<IScheduledQueryRun>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    consoleId: {
      type: Schema.Types.ObjectId,
      ref: "SavedConsole",
      required: true,
    },
    triggeredAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["queued", "running", "success", "error"],
      required: true,
    },
    triggerType: {
      type: String,
      enum: ["schedule", "manual"],
      required: true,
    },
    triggeredBy: {
      type: String,
      ref: "User",
    },
    durationMs: {
      type: Number,
    },
    rowsAffected: {
      type: Number,
    },
    rowCount: {
      type: Number,
    },
    error: {
      message: {
        type: String,
      },
      code: {
        type: String,
      },
    },
    inngestRunId: {
      type: String,
    },
  },
  {
    collection: "scheduled_query_runs",
    timestamps: false,
  },
);

ScheduledQueryRunSchema.index({
  workspaceId: 1,
  consoleId: 1,
  triggeredAt: -1,
});
ScheduledQueryRunSchema.index(
  { completedAt: 1 },
  { sparse: true, expireAfterSeconds: 7776000 },
);

const NotificationRuleSchema = new Schema<INotificationRule>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    resourceType: {
      type: String,
      enum: ["scheduled_query", "flow"],
      required: true,
    },
    resourceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    triggers: {
      type: [String],
      enum: ["success", "failure"],
      validate: {
        validator: (v: string[]) =>
          Array.isArray(v) &&
          v.length > 0 &&
          v.every(t => t === "success" || t === "failure"),
        message: "At least one trigger required",
      },
      required: true,
    },
    channel: {
      type: Schema.Types.Mixed,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    collection: "notification_rules",
    timestamps: true,
  },
);

NotificationRuleSchema.index({
  workspaceId: 1,
  resourceType: 1,
  resourceId: 1,
  enabled: 1,
});

const NotificationDeliverySchema = new Schema<INotificationDelivery>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: "NotificationRule",
      required: true,
    },
    resourceType: {
      type: String,
      enum: ["scheduled_query", "flow"],
      required: true,
    },
    resourceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    runId: {
      type: String,
      required: true,
    },
    trigger: {
      type: String,
      enum: ["success", "failure"],
      required: true,
    },
    channelType: {
      type: String,
      enum: ["email", "webhook", "slack"],
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: String,
    httpStatus: Number,
    sentAt: Date,
    completedAt: Date,
  },
  {
    collection: "notification_deliveries",
    timestamps: { createdAt: true, updatedAt: false },
  },
);

NotificationDeliverySchema.index({
  workspaceId: 1,
  resourceType: 1,
  resourceId: 1,
  completedAt: -1,
});

NotificationDeliverySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7776000 },
);

export interface IMaterializationRun extends Document {
  workspaceId: Types.ObjectId;
  dashboardId: Types.ObjectId;
  dataSourceId: string;
  runId: string;
  triggerType: "manual" | "schedule" | "dashboard_update";
  lastHeartbeat?: Date;
  workerId?: string;
  stage?: string;
  attempt?: number;
  status: "queued" | "building" | "ready" | "error" | "abandoned" | "cancelled";
  requestedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  artifactKey?: string;
  version?: string;
  definitionHash?: string;
  artifactRevision?: string;
  rowCount?: number;
  byteSize?: number;
  error?: string;
  events: Array<{
    type: string;
    timestamp: Date;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
}

const MaterializationRunSchema = new Schema<IMaterializationRun>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    dashboardId: {
      type: Schema.Types.ObjectId,
      ref: "Dashboard",
      required: true,
    },
    dataSourceId: { type: String, required: true },
    runId: { type: String, required: true, unique: true },
    triggerType: {
      type: String,
      enum: ["manual", "schedule", "dashboard_update"],
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "building", "ready", "error", "abandoned", "cancelled"],
      required: true,
    },
    requestedAt: { type: Date, required: true, default: Date.now },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    lastHeartbeat: { type: Date },
    workerId: { type: String },
    stage: { type: String },
    attempt: { type: Number, default: 1 },
    artifactKey: { type: String },
    version: { type: String },
    definitionHash: { type: String },
    artifactRevision: { type: String },
    rowCount: { type: Number },
    byteSize: { type: Number },
    error: { type: String },
    events: [
      {
        type: { type: String, required: true },
        timestamp: { type: Date, required: true },
        message: { type: String, required: true },
        metadata: { type: Schema.Types.Mixed },
      },
    ],
  },
  {
    collection: "materialization_runs",
    timestamps: false,
  },
);

MaterializationRunSchema.index({
  dashboardId: 1,
  dataSourceId: 1,
  requestedAt: -1,
});
MaterializationRunSchema.index({ workspaceId: 1, requestedAt: -1 });
MaterializationRunSchema.index({ status: 1, lastHeartbeat: 1 });
MaterializationRunSchema.index(
  { requestedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

/**
 * Dashboard model interface (AI-native dashboard engine)
 */
export interface IDashboard extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  description?: string;
  /**
   * Client-supplied creation idempotency key (the agent toolCallId). Multiple
   * windows attached to the same chat stream each dispatch the same
   * create_dashboard call; the unique partial index on
   * { workspaceId, creationIdempotencyKey } makes the second insert a
   * duplicate, and the create route returns the existing dashboard instead.
   */
  creationIdempotencyKey?: string;

  dataSources: IDashboardDataSource[];

  relationships: Array<{
    id: string;
    from: { dataSourceId: string; column: string };
    to: { dataSourceId: string; column: string };
    type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  }>;

  widgets: Array<{
    id: string;
    title?: string;
    type: "chart" | "kpi" | "table";
    dataSourceId: string;
    localSql: string;
    vegaLiteSpec?: Record<string, unknown>;
    kpiConfig?: {
      valueField: string;
      format?: string;
      comparisonField?: string;
      comparisonLabel?: string;
    };
    tableConfig?: { columns?: string[]; pageSize?: number };
    crossFilter: { enabled: boolean; fields?: string[] };
    layouts: {
      lg: {
        x: number;
        y: number;
        w: number;
        h: number;
        minW?: number;
        minH?: number;
      };
      md?: {
        x: number;
        y: number;
        w: number;
        h: number;
        minW?: number;
        minH?: number;
      };
      sm?: {
        x: number;
        y: number;
        w: number;
        h: number;
        minW?: number;
        minH?: number;
      };
      xs?: {
        x: number;
        y: number;
        w: number;
        h: number;
        minW?: number;
        minH?: number;
      };
    };
  }>;

  globalFilters: Array<{
    id: string;
    type: "date-range" | "select" | "multi-select" | "search";
    label: string;
    dataSourceId: string;
    column: string;
    config: Record<string, unknown>;
    layout: { order: number; width?: number };
  }>;

  crossFilter: {
    enabled: boolean;
    resolution: "intersect" | "union";
    engine?: "mosaic" | "legacy";
  };

  materializationSchedule: {
    enabled: boolean;
    cron: string | null;
    timezone?: string;
    dataFreshnessTtlMs?: number | null;
  };

  layout: {
    columns: number;
    rowHeight: number;
  };

  cache: {
    lastRefreshedAt?: Date;
  };

  snapshots?: Record<
    string,
    {
      version: string;
      generatedAt: Date;
      rowCount: number;
      rows: Record<string, unknown>[];
      fields: Array<{ name: string; type: string }>;
    }
  >;

  version: number;
  versionHistory: Array<{
    version: number;
    snapshot: Record<string, unknown>;
    createdAt: Date;
    createdBy: string;
    message?: string;
  }>;

  editLock?: {
    userId: string;
    userName: string;
    lockedAt: Date;
    expiresAt: Date;
  };

  /**
   * Last published definition snapshot (draft/published split, mirrors
   * MakoApp). The top-level definition fields are the working draft; `published`
   * is what public/shared viewers render. Set on every explicit save (which
   * also creates a version); a restore reverts the draft only, leaving
   * `published` until the next save. Absent until first save — readers fall
   * back to the live definition for back-compat. Shape = buildDashboardSnapshot.
   */
  published?: Record<string, unknown>;
  /** EntityVersion number that was published into `published`. */
  publishedVersion?: number;
  publishedAt?: Date;

  folderId?: Types.ObjectId;
  access: "private" | "workspace";
  /** Role granted to workspace members when access is "workspace". */
  workspaceRole?: ResourceShareRole;
  /**
   * Per-user collaborators (viewer/editor), independent of the `access`
   * level. Editors can read + write; viewers can only read.
   */
  sharedWith?: IResourceShareEntry[];
  /** Public link sharing (read-only, snapshot data, optional password). */
  publicShare?: IPublicShare;
  owner_id?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * DashboardFolder model interface
 */
export interface IDashboardFolder extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId;
  ownerId?: string;
  access: "private" | "workspace";
  createdAt: Date;
}

export interface IDashboardQueryDefinition {
  connectionId: Types.ObjectId;
  language: "sql" | "javascript" | "mongodb";
  code: string;
  databaseId?: string;
  databaseName?: string;
  mongoOptions?: {
    collection?: string;
    operation?:
      | "find"
      | "aggregate"
      | "insertMany"
      | "updateMany"
      | "deleteMany"
      | "findOne"
      | "updateOne"
      | "deleteOne";
  };
}

export interface IDashboardDataSourceOrigin {
  type: "saved_console" | "local";
  consoleId?: Types.ObjectId;
  consoleName?: string;
  importedAt?: Date;
  /** Agent toolCallId that created this data source (creation idempotency). */
  createdByToolCallId?: string;
}

export interface IDashboardDataSource {
  id: string;
  name: string;
  tableRef: string;
  query: IDashboardQueryDefinition;
  origin?: IDashboardDataSourceOrigin;
  timeDimension?: string;
  rowLimit?: number;
  /**
   * How the data reaches widgets. `parquet` (default) materializes to a cached
   * artifact; `live` streams the query server-side into DuckDB on every load.
   */
  materialization: "live" | "parquet";
  computedColumns?: Array<{
    name: string;
    expression: string;
    type: "quantitative" | "temporal" | "nominal" | "ordinal";
  }>;
  cache?: {
    lastRefreshedAt?: Date;
    rowCount?: number;
    byteSize?: number;
    parquetArtifactKey?: string;
    definitionHash?: string;
    artifactRevision?: string;
    parquetVersion?: string;
    parquetBuiltAt?: Date;
    parquetBuildStatus?: "missing" | "queued" | "building" | "ready" | "error";
    parquetLastError?: string;
    parquetUrl?: string;
  };
}

/**
 * Dashboard Schema
 */
const DashboardSchema = new Schema<IDashboard>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    creationIdempotencyKey: { type: String },

    dataSources: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        tableRef: { type: String, required: true },
        query: {
          connectionId: {
            type: Schema.Types.ObjectId,
            ref: "DatabaseConnection",
            required: true,
          },
          language: {
            type: String,
            enum: ["sql", "javascript", "mongodb"],
            required: true,
          },
          code: { type: String, required: true },
          databaseId: { type: String },
          databaseName: { type: String },
          mongoOptions: {
            collection: { type: String },
            operation: {
              type: String,
              enum: [
                "find",
                "aggregate",
                "insertMany",
                "updateMany",
                "deleteMany",
                "findOne",
                "updateOne",
                "deleteOne",
              ],
            },
          },
        },
        origin: {
          type: {
            type: String,
            enum: ["saved_console", "local"],
          },
          consoleId: {
            type: Schema.Types.ObjectId,
            ref: "SavedConsole",
          },
          consoleName: { type: String },
          importedAt: { type: Date },
          createdByToolCallId: { type: String },
        },
        timeDimension: { type: String },
        rowLimit: { type: Number },
        materialization: {
          type: String,
          enum: ["live", "parquet"],
          default: "parquet",
        },
        computedColumns: [
          {
            name: { type: String, required: true },
            expression: { type: String, required: true },
            type: {
              type: String,
              enum: ["quantitative", "temporal", "nominal", "ordinal"],
              required: true,
            },
          },
        ],
        cache: {
          lastRefreshedAt: { type: Date },
          rowCount: { type: Number },
          byteSize: { type: Number },
          parquetArtifactKey: { type: String },
          definitionHash: { type: String },
          artifactRevision: { type: String },
          parquetVersion: { type: String },
          parquetBuiltAt: { type: Date },
          parquetBuildStatus: {
            type: String,
            enum: ["missing", "queued", "building", "ready", "error", null],
          },
          parquetLastError: { type: String },
        },
      },
    ],

    relationships: [
      {
        id: { type: String, required: true },
        from: {
          dataSourceId: { type: String, required: true },
          column: { type: String, required: true },
        },
        to: {
          dataSourceId: { type: String, required: true },
          column: { type: String, required: true },
        },
        type: {
          type: String,
          enum: ["one-to-one", "one-to-many", "many-to-one", "many-to-many"],
          required: true,
        },
      },
    ],

    widgets: [
      {
        id: { type: String, required: true },
        title: { type: String },
        type: {
          type: String,
          enum: ["chart", "kpi", "table"],
          required: true,
        },
        dataSourceId: { type: String, required: true },
        localSql: { type: String, required: true },
        vegaLiteSpec: { type: Schema.Types.Mixed },
        kpiConfig: {
          valueField: { type: String },
          format: { type: String },
          comparisonField: { type: String },
          comparisonLabel: { type: String },
        },
        tableConfig: {
          columns: [{ type: String }],
          pageSize: { type: Number },
        },
        crossFilter: {
          enabled: { type: Boolean, default: true },
          fields: [{ type: String }],
        },
        layouts: {
          lg: {
            x: { type: Number, required: true },
            y: { type: Number, required: true },
            w: { type: Number, required: true },
            h: { type: Number, required: true },
            minW: { type: Number },
            minH: { type: Number },
          },
          md: {
            x: { type: Number },
            y: { type: Number },
            w: { type: Number },
            h: { type: Number },
            minW: { type: Number },
            minH: { type: Number },
            custom: { type: Boolean },
          },
          sm: {
            x: { type: Number },
            y: { type: Number },
            w: { type: Number },
            h: { type: Number },
            minW: { type: Number },
            minH: { type: Number },
            custom: { type: Boolean },
          },
          xs: {
            x: { type: Number },
            y: { type: Number },
            w: { type: Number },
            h: { type: Number },
            minW: { type: Number },
            minH: { type: Number },
            custom: { type: Boolean },
          },
        },
      },
    ],

    globalFilters: [
      {
        id: { type: String, required: true },
        type: {
          type: String,
          enum: ["date-range", "select", "multi-select", "search"],
          required: true,
        },
        label: { type: String, required: true },
        dataSourceId: { type: String, required: true },
        column: { type: String, required: true },
        config: { type: Schema.Types.Mixed, default: {} },
        layout: {
          order: { type: Number, default: 0 },
          width: { type: Number },
        },
      },
    ],

    crossFilter: {
      enabled: { type: Boolean, default: true },
      resolution: {
        type: String,
        enum: ["intersect", "union"],
        default: "intersect",
      },
      engine: {
        type: String,
        enum: ["mosaic", "legacy"],
        default: "mosaic",
      },
    },

    materializationSchedule: {
      enabled: { type: Boolean, default: true },
      cron: { type: String, default: "0 0 * * *" },
      timezone: { type: String, default: "UTC" },
      dataFreshnessTtlMs: { type: Number, default: null },
    },

    layout: {
      columns: { type: Number, default: 12 },
      rowHeight: { type: Number, default: 80 },
    },

    cache: {
      lastRefreshedAt: { type: Date },
    },

    snapshots: { type: Schema.Types.Mixed, default: {} },

    version: { type: Number, default: 1 },
    versionHistory: [
      {
        version: { type: Number, required: true },
        snapshot: { type: Schema.Types.Mixed, required: true },
        createdAt: { type: Date, default: Date.now },
        createdBy: { type: String, required: true },
        message: { type: String },
      },
    ],

    editLock: {
      userId: { type: String },
      userName: { type: String },
      lockedAt: { type: Date },
      expiresAt: { type: Date },
    },

    // Draft/published split (mirrors MakoApp): `published` holds the last
    // committed definition snapshot (Mixed — same shape as
    // buildDashboardSnapshot). Public/shared viewers render this.
    published: { type: Schema.Types.Mixed, default: undefined },
    publishedVersion: { type: Number },
    publishedAt: { type: Date },

    folderId: {
      type: Schema.Types.ObjectId,
      ref: "DashboardFolder",
    },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
    workspaceRole: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    sharedWith: {
      type: [ResourceShareEntrySchema],
      default: [],
    },
    publicShare: { type: PublicShareSchema, default: undefined },
    owner_id: { type: String },
    createdBy: { type: String, required: true },
  },
  {
    collection: "dashboards",
    timestamps: true,
  },
);

DashboardSchema.index({ workspaceId: 1 });
DashboardSchema.index({ workspaceId: 1, createdBy: 1 });
DashboardSchema.index({ workspaceId: 1, access: 1, owner_id: 1 });
DashboardSchema.index({ workspaceId: 1, "sharedWith.userId": 1 });
DashboardSchema.index(
  { "publicShare.token": 1 },
  { unique: true, sparse: true },
);
// Creation idempotency (see IDashboard.creationIdempotencyKey). Partial (not
// sparse): a sparse COMPOUND index still indexes docs that have workspaceId
// but no key, which would make every keyless dashboard collide.
DashboardSchema.index(
  { workspaceId: 1, creationIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { creationIdempotencyKey: { $type: "string" } },
  },
);

/**
 * DashboardFolder Schema
 */
const DashboardFolderSchema = new Schema<IDashboardFolder>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "DashboardFolder",
    },
    ownerId: {
      type: String,
      ref: "User",
    },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

DashboardFolderSchema.index({ workspaceId: 1, parentId: 1 });

// Models
export const Workspace = mongoose.model<IWorkspace>(
  "Workspace",
  WorkspaceSchema,
);
export const WorkspaceMember = mongoose.model<IWorkspaceMember>(
  "WorkspaceMember",
  WorkspaceMemberSchema,
);
export const WorkspaceInvite = mongoose.model<IWorkspaceInvite>(
  "WorkspaceInvite",
  WorkspaceInviteSchema,
);
export const DatabaseConnection = mongoose.model<IDatabaseConnection>(
  "DatabaseConnection",
  DatabaseConnectionSchema,
);
/** @deprecated Use DatabaseConnection instead */
export const Database = DatabaseConnection;
export const Connector = mongoose.model<IConnector>(
  "Connector",
  ConnectorSchema,
);
/**
 * EntityVersion — immutable append-only version snapshots for consoles and dashboards.
 * Every explicit save creates a new version record; history is never rewritten.
 */
export type VersionableEntityType =
  | "console"
  | "dashboard"
  | "dbt-file"
  | "app";

export interface IEntityVersion extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  entityType: VersionableEntityType;
  entityId: Types.ObjectId;
  version: number;
  snapshot: Record<string, unknown>;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
  createdAt: Date;
}

const EntityVersionSchema = new Schema<IEntityVersion>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    entityType: {
      type: String,
      enum: ["console", "dashboard", "dbt-file", "app"],
      required: true,
    },
    entityId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    version: {
      type: Number,
      required: true,
    },
    snapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    savedBy: {
      type: String,
      required: true,
    },
    savedByName: {
      type: String,
      required: true,
    },
    comment: {
      type: String,
      default: "",
    },
    restoredFrom: {
      type: Number,
    },
  },
  {
    collection: "entity_versions",
    timestamps: { createdAt: true, updatedAt: false },
  },
);

EntityVersionSchema.index({ entityId: 1, version: -1 });
EntityVersionSchema.index(
  { entityId: 1, entityType: 1, version: 1 },
  { unique: true },
);
EntityVersionSchema.index({
  workspaceId: 1,
  entityType: 1,
  createdAt: -1,
});

export const EntityVersion = mongoose.model<IEntityVersion>(
  "EntityVersion",
  EntityVersionSchema,
);

export const ConsoleFolder = mongoose.model<IConsoleFolder>(
  "ConsoleFolder",
  ConsoleFolderSchema,
);
export const SavedConsole = mongoose.model<ISavedConsole>(
  "SavedConsole",
  SavedConsoleSchema,
);
export const Chat = mongoose.model<IChat>("Chat", ChatSchema);
export const ChatAttachment = mongoose.model<IChatAttachment>(
  "ChatAttachment",
  ChatAttachmentSchema,
);
export const Flow = mongoose.model<IFlow>("Flow", FlowSchema);
export const FlowExecution = mongoose.model<IFlowExecution>(
  "FlowExecution",
  FlowExecutionSchema,
);
export const WebhookEvent = mongoose.model<IWebhookEvent>(
  "WebhookEvent",
  WebhookEventSchema,
);
export const CdcChangeEvent = mongoose.model<ICdcChangeEvent>(
  "CdcChangeEvent",
  CdcChangeEventSchema,
);
export const CdcEntityState = mongoose.model<ICdcEntityState>(
  "CdcEntityState",
  CdcEntityStateSchema,
);
export const CdcStateTransition = mongoose.model<ICdcStateTransition>(
  "CdcStateTransition",
  CdcStateTransitionSchema,
);
// Legacy aliases for backward compatibility
export const BigQueryChangeEvent = CdcChangeEvent;
export const BigQueryCdcState = CdcEntityState;
export const QueryExecution = mongoose.model<IQueryExecution>(
  "QueryExecution",
  QueryExecutionSchema,
);
export const ScheduledQueryRun = mongoose.model<IScheduledQueryRun>(
  "ScheduledQueryRun",
  ScheduledQueryRunSchema,
);
export const NotificationRule = mongoose.model<INotificationRule>(
  "NotificationRule",
  NotificationRuleSchema,
);
export const NotificationDelivery = mongoose.model<INotificationDelivery>(
  "NotificationDelivery",
  NotificationDeliverySchema,
);
export const MaterializationRun = mongoose.model<IMaterializationRun>(
  "MaterializationRun",
  MaterializationRunSchema,
);
export const DashboardFolder = mongoose.model<IDashboardFolder>(
  "DashboardFolder",
  DashboardFolderSchema,
);
export const Dashboard = mongoose.model<IDashboard>(
  "Dashboard",
  DashboardSchema,
);

/**
 * MakoApp — a workspace-scoped React app (Lovable / v0 style) that runs inside
 * Mako with first-class access to workspace database connections via data
 * bindings. The app body is a virtual filesystem (`files`) + npm dependency
 * manifest (`dependencies`) + `dataBindings`. See `@mako/schemas` AppDefinition.
 */
export interface IMakoAppFile {
  path: string;
  contents: string;
}

export interface IMakoAppBindingMaterializationRun {
  at: Date;
  status: "ready" | "error";
  rowCount?: number;
  byteSize?: number;
  durationMs?: number;
  error?: string;
}

export interface IMakoAppBindingCache {
  parquetArtifactKey?: string;
  definitionHash?: string;
  artifactRevision?: string;
  parquetBuildStatus?:
    | "missing"
    | "queued"
    | "building"
    | "ready"
    | "error"
    | null;
  /**
   * Heartbeat for the current build. Refreshed periodically while a build is
   * queued/running so stuck "building" statuses can be detected and recovered.
   */
  parquetBuildStatusAt?: Date | null;
  parquetLastError?: string | null;
  rowCount?: number;
  byteSize?: number;
  lastRefreshedAt?: Date;
  parquetBuiltAt?: Date;
  history?: IMakoAppBindingMaterializationRun[];
}

export interface IMakoAppDataBinding {
  id: string;
  name: string;
  /**
   * Optional link to a dbt project. When set, the `{{ dbt_schema }}` token in
   * `code` resolves to a dbt environment's target schema at execution time —
   * the prod-like environment by default (published apps, materialization,
   * public shares), or a per-user preview override in the draft preview.
   */
  dbtProjectId?: string;
  connectionId: string;
  language: "sql" | "javascript" | "mongodb";
  code: string;
  databaseId?: string;
  databaseName?: string;
  materialization: "live" | "parquet";
  materializationSchedule?: {
    enabled: boolean;
    cron: string | null;
    timezone?: string;
    dataFreshnessTtlMs?: number | null;
  };
  cache?: IMakoAppBindingCache;
}

export interface IMakoApp extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  description?: string;
  template: string;
  runtime: "cdn" | "webcontainer";
  entrypoint: string;
  files: IMakoAppFile[];
  dependencies: Record<string, string>;
  dataBindings: IMakoAppDataBinding[];
  version: number;
  /**
   * Last published definition snapshot (draft/published split). The top-level
   * fields above are the working DRAFT (autosaved on every edit); `published`
   * is the committed definition that public/shared viewers render. Absent until
   * the app is first published — readers fall back to the draft for back-compat.
   * Shape matches `buildAppSnapshot` (no server-owned binding `cache`).
   */
  published?: Record<string, unknown>;
  /** EntityVersion number that was published into `published`. */
  publishedVersion?: number;
  publishedAt?: Date;
  access: "private" | "workspace";
  /** Role granted to workspace members when access is "workspace". */
  workspaceRole?: ResourceShareRole;
  /** Per-user collaborators (viewer/editor), independent of `access`. */
  sharedWith?: IResourceShareEntry[];
  /** Public link sharing (read-only, snapshot data, optional password). */
  publicShare?: IPublicShare;
  owner_id?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const MakoAppFileSchema = new Schema<IMakoAppFile>(
  {
    path: { type: String, required: true },
    contents: { type: String, default: "" },
  },
  { _id: false },
);

const MakoAppBindingMaterializationRunSchema =
  new Schema<IMakoAppBindingMaterializationRun>(
    {
      at: { type: Date, required: true },
      status: { type: String, enum: ["ready", "error"], required: true },
      rowCount: { type: Number },
      byteSize: { type: Number },
      durationMs: { type: Number },
      error: { type: String },
    },
    { _id: false },
  );

const MakoAppBindingCacheSchema = new Schema<IMakoAppBindingCache>(
  {
    parquetArtifactKey: { type: String },
    definitionHash: { type: String },
    artifactRevision: { type: String },
    parquetBuildStatus: {
      type: String,
      enum: ["missing", "queued", "building", "ready", "error", null],
      default: null,
    },
    parquetBuildStatusAt: { type: Date, default: null },
    parquetLastError: { type: String, default: null },
    rowCount: { type: Number },
    byteSize: { type: Number },
    lastRefreshedAt: { type: Date },
    parquetBuiltAt: { type: Date },
    history: {
      type: [MakoAppBindingMaterializationRunSchema],
      default: undefined,
    },
  },
  { _id: false },
);

const MakoAppDataBindingSchema = new Schema<IMakoAppDataBinding>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    dbtProjectId: { type: String },
    connectionId: { type: String, required: true },
    language: {
      type: String,
      enum: ["sql", "javascript", "mongodb"],
      default: "sql",
    },
    code: { type: String, default: "" },
    databaseId: { type: String },
    databaseName: { type: String },
    materialization: {
      type: String,
      enum: ["live", "parquet"],
      default: "live",
    },
    materializationSchedule: {
      enabled: { type: Boolean, default: false },
      cron: { type: String, default: null },
      timezone: { type: String, default: "UTC" },
      dataFreshnessTtlMs: { type: Number, default: null },
    },
    cache: { type: MakoAppBindingCacheSchema, default: undefined },
  },
  { _id: false },
);

const MakoAppSchema = new Schema<IMakoApp>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    template: { type: String, default: "react-ts" },
    runtime: {
      type: String,
      enum: ["cdn", "webcontainer"],
      default: "cdn",
    },
    entrypoint: { type: String, default: "src/App.tsx" },
    files: { type: [MakoAppFileSchema], default: [] },
    dependencies: { type: Schema.Types.Mixed, default: {} },
    dataBindings: { type: [MakoAppDataBindingSchema], default: [] },
    version: { type: Number, default: 1 },
    // Draft/published split: `published` holds the last committed definition
    // snapshot (Mixed — same shape as buildAppSnapshot). Public/shared viewers
    // render this; the top-level fields are the working draft.
    published: { type: Schema.Types.Mixed, default: undefined },
    publishedVersion: { type: Number },
    publishedAt: { type: Date },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
    workspaceRole: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    sharedWith: {
      type: [ResourceShareEntrySchema],
      default: [],
    },
    publicShare: { type: PublicShareSchema, default: undefined },
    owner_id: { type: String, index: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

MakoAppSchema.index({ workspaceId: 1, updatedAt: -1 });
MakoAppSchema.index({ workspaceId: 1, "sharedWith.userId": 1 });
MakoAppSchema.index({ "publicShare.token": 1 }, { unique: true, sparse: true });

export const MakoApp = mongoose.model<IMakoApp>("MakoApp", MakoAppSchema);

/**
 * Skill — workspace-scoped knowledge + procedure primitive.
 *
 * See GitHub issue #365. A skill is a named, conditional playbook with:
 *   - loadWhen: short trigger description (what query/task it applies to)
 *   - body:     schema facts + procedural hints (SQL shapes, gotchas, etc.)
 *   - entities: tokens used for retrieval (authored + extracted)
 *
 * Retrieval combines entity overlap with semantic similarity on `loadWhen`.
 * The full index (name + loadWhen) is injected into the agent's system prompt
 * every turn; bodies are injected only for top-k matches above a threshold
 * or when the agent explicitly calls `load_skill`.
 */
export type SkillScopeType = "workspace" | "user" | "connection";

export interface ISkill extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  loadWhen: string;
  body: string;
  entities: string[];
  /** Embedding over `loadWhen` only. Bodies are too long to embed usefully. */
  loadWhenEmbedding?: number[];
  embeddingModel?: string;
  /** Reserved for future scoping. MVP: all skills are scope_type="workspace". */
  scopeType: SkillScopeType;
  scopeRefId?: Types.ObjectId | string;
  /** "agent" for model-authored skills, otherwise a user id. */
  createdBy: string;
  /** Soft-disable without deletion — lets admins A/B whether a skill helps. */
  suppressed: boolean;
  useCount: number;
  lastUsedAt?: Date;
  /** Single-slot undo for wrong overwrites. */
  previousBody?: string;
  previousUpdatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SkillSchema = new Schema<ISkill>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    loadWhen: { type: String, required: true, trim: true, maxlength: 500 },
    body: { type: String, required: true, maxlength: 20000 },
    entities: { type: [String], default: [] },
    loadWhenEmbedding: { type: [Number], select: false },
    embeddingModel: { type: String },
    scopeType: {
      type: String,
      enum: ["workspace", "user", "connection"],
      default: "workspace",
      required: true,
    },
    scopeRefId: { type: Schema.Types.Mixed },
    createdBy: { type: String, required: true },
    suppressed: { type: Boolean, default: false },
    useCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
    previousBody: { type: String },
    previousUpdatedAt: { type: Date },
  },
  { collection: "skills", timestamps: true },
);

SkillSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
SkillSchema.index({ workspaceId: 1, suppressed: 1 });
SkillSchema.index({ workspaceId: 1, entities: 1 });
SkillSchema.index(
  { name: "text", loadWhen: "text", body: "text" },
  { name: "skill_text_search" },
);

export const Skill = mongoose.model<ISkill>("Skill", SkillSchema);

/**
 * RealtimePresence — one document per connected realtime (SSE) client tab.
 *
 * Heartbeated by routes/realtime.ts while the connection is open; reaped by
 * a TTL index after 90s without a heartbeat. Lets server-side code answer
 * "is any browser attached to this workspace right now?" across instances
 * (used by the agent's "no client attached" tool fallback).
 */
export interface IRealtimePresence extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  clientId: string;
  userId: string;
  lastSeenAt: Date;
}

const RealtimePresenceSchema = new Schema<IRealtimePresence>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    clientId: { type: String, required: true },
    userId: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { collection: "realtime_presence" },
);

RealtimePresenceSchema.index({ workspaceId: 1, clientId: 1 }, { unique: true });
// TTL reaper: connections that stop heartbeating disappear automatically.
RealtimePresenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 });

export const RealtimePresence = mongoose.model<IRealtimePresence>(
  "RealtimePresence",
  RealtimePresenceSchema,
);

/**
 * dbt — workspace-scoped dbt Core projects ("dbt Cloud replica").
 *
 * A project is a virtual filesystem in Mongo (one DbtFile doc per file)
 * materialized to a temp dir at run time by api/src/dbt/runner.service.ts.
 * Jobs hold command lists + cron schedules (claim pattern mirrors
 * SavedConsole.scheduledRun); runs are the per-execution records with
 * capped logs and parsed run_results.json step results.
 */

export interface IDbtEnvironment {
  /** Environment name, e.g. "dev" or "prod". Unique within the project. */
  name: string;
  /** DatabaseConnection id used as the warehouse target. */
  connectionId: Types.ObjectId;
  /** Target schema (dataset for BigQuery) dbt builds into. */
  targetSchema: string;
  /** dbt threads; default low (4) — prod container is memory-constrained. */
  threads: number;
  /** dbt vars passed as --vars for every command in this environment. */
  vars?: Record<string, unknown>;
  /**
   * Personal (per-developer) environment: set to the owning user's id when
   * this environment was auto-provisioned as that user's private dev target
   * (dbt Cloud-style development credentials, e.g. schema `dbt_jonas`).
   * Unset for shared environments (dev/prod). Agent/user actions without an
   * explicit environment default to the caller's personal environment.
   */
  ownerUserId?: string;
}

/**
 * Optional binding of a dbt project to a Git repository. When present, the
 * project's files are imported/synced from this repo. Mongo (DbtFile) stays
 * the canonical source the runner materializes from; this binding records
 * where those files came from and lets us sync/commit against the remote.
 */
export interface IDbtRepoBinding {
  provider: "github";
  /** GitHub App installation id granting access to the repo (omit for public). */
  installationId?: number;
  /** Repo owner (org or user login). */
  owner: string;
  /** Repo name. */
  repo: string;
  /** Branch tracked for import/sync, e.g. "main". */
  branch: string;
  /**
   * Optional sub-directory inside the repo holding the dbt project (when
   * dbt_project.yml is not at the repo root). POSIX, no leading/trailing slash.
   */
  subdirectory?: string;
  /** Commit SHA of the last successful import/sync. */
  lastSyncedSha?: string;
  lastSyncedAt?: Date;
}

export interface IDbtProject extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  /** Pinned dbt-core minor version, e.g. "1.9". Informational for now. */
  dbtVersion: string;
  environments: IDbtEnvironment[];
  defaultEnvironment: string;
  /**
   * Explicit PRODUCTION environment (the defer target). Drives which
   * environment's successful runs update `lastProdManifestKey` (what ad-hoc
   * `--defer` resolves against), what `{{ dbt_schema }}` resolves to for
   * published apps, and which environment refuses ad-hoc warehouse writes.
   * Unset → convention: the environment literally named "prod" when one
   * exists, else the project default.
   */
  prodEnvironment?: string;
  /**
   * Artifact-store key of the last successful prod manifest.json. This is
   * the state artifact for --defer / state:modified+ (Slim CI, later phase).
   */
  lastProdManifestKey?: string;
  /** Git repository this project is imported/synced from (optional). */
  repo?: IDbtRepoBinding;
  /**
   * Branches that refuse direct commits from Mako (dbt Cloud "read-only"
   * main). Changes reach these branches only through a pull request
   * (commit-to-branch → open PR → merge). New GitHub imports default this to
   * the repo's default branch; existing projects migrated to [] (opt-in).
   */
  protectedBranches?: string[];
  /**
   * Pull-request CI config. When enabled, an opened/updated PR from the
   * tracked branch triggers `dbt build --select state:modified+` (deferring to
   * the prod manifest) and posts a GitHub commit status — like a dbt Cloud CI
   * job. Off by default so connecting a repo never silently runs warehouse jobs.
   */
  ci?: {
    enabled: boolean;
    /** Environment (schema/connection) CI builds run against. */
    environment?: string;
    /** Defer unselected refs to the last prod manifest (Slim CI). Default true. */
    deferToProduction?: boolean;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtEnvironmentSchema = new Schema<IDbtEnvironment>(
  {
    name: { type: String, required: true, trim: true },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    targetSchema: { type: String, required: true, trim: true },
    threads: { type: Number, default: 4, min: 1, max: 16 },
    vars: { type: Schema.Types.Mixed },
    ownerUserId: { type: String },
  },
  { _id: false },
);

const DbtRepoBindingSchema = new Schema<IDbtRepoBinding>(
  {
    provider: { type: String, enum: ["github"], default: "github" },
    installationId: { type: Number },
    owner: { type: String, required: true, trim: true },
    repo: { type: String, required: true, trim: true },
    branch: { type: String, required: true, trim: true, default: "main" },
    subdirectory: { type: String, trim: true },
    lastSyncedSha: { type: String },
    lastSyncedAt: { type: Date },
  },
  { _id: false },
);

const DbtProjectSchema = new Schema<IDbtProject>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    dbtVersion: { type: String, default: "1.9" },
    environments: { type: [DbtEnvironmentSchema], default: [] },
    defaultEnvironment: { type: String, default: "dev" },
    prodEnvironment: { type: String },
    lastProdManifestKey: { type: String },
    repo: { type: DbtRepoBindingSchema },
    protectedBranches: { type: [String], default: undefined },
    ci: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          environment: { type: String },
          deferToProduction: { type: Boolean, default: true },
        },
        { _id: false },
      ),
      required: false,
    },
    createdBy: { type: String, required: true },
  },
  { collection: "dbt_projects", timestamps: true },
);

DbtProjectSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
DbtProjectSchema.index({ workspaceId: 1, updatedAt: -1 });

export const DbtProject = mongoose.model<IDbtProject>(
  "DbtProject",
  DbtProjectSchema,
);

export interface IDbtFile extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  /**
   * Branch this row belongs to (repo-bound projects). A repo project keeps
   * one COMMITTED base tree per checked-out branch: content always mirrors
   * the branch head, uncommitted work lives in per-user DbtFileDraft
   * overlays. Blank (non-repo) projects leave this unset — their DbtFile
   * rows remain the single shared working tree.
   */
  branch?: string;
  /** POSIX path relative to project root, e.g. "models/staging/stg_x.sql". */
  path: string;
  content: string;
  updatedBy: string;
  is_deleted: boolean;
  /**
   * Git blob SHA of this file at the last import/sync/push. Per-user git
   * status diffs a draft's blob SHA against this without re-fetching GitHub.
   */
  repoBlobSha?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtFileSchema = new Schema<IDbtFile>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    branch: { type: String, trim: true },
    path: { type: String, required: true, trim: true },
    content: { type: String, default: "" },
    updatedBy: { type: String, required: true },
    is_deleted: { type: Boolean, default: false },
    repoBlobSha: { type: String },
  },
  { collection: "dbt_files", timestamps: true },
);

// One row per (project, branch, path). Blank projects store branch: null,
// which the unique index treats as a value, so their single tree stays unique.
DbtFileSchema.index({ projectId: 1, branch: 1, path: 1 }, { unique: true });
DbtFileSchema.index({ workspaceId: 1, projectId: 1, is_deleted: 1 });

export const DbtFile = mongoose.model<IDbtFile>("DbtFile", DbtFileSchema);

/**
 * Per-user, per-branch uncommitted edit to a dbt file (the draft overlay).
 * Reads for a user merge draft-over-base: other workspace members never see a
 * draft, so collaborators only observe committed changes — like separate git
 * working trees. Drafts are keyed to the branch they were made on, so
 * switching branches leaves each branch's uncommitted work exactly where it
 * was (git-worktree semantics: no carrying dirty state onto another branch's
 * base). Drafts are cleared when committed.
 */
export interface IDbtFileDraft extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Owning user id (or "agent" for agent edits outside a user session). */
  userId: string;
  /** Branch the draft was made on (drafts only exist for repo projects). */
  branch: string;
  path: string;
  content: string;
  /** Pending deletion of the base file (a staged `git rm`). */
  is_deleted: boolean;
  /** Blob SHA of the base content the draft started from (informational). */
  baseBlobSha?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtFileDraftSchema = new Schema<IDbtFileDraft>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    userId: { type: String, required: true },
    branch: { type: String, required: true },
    path: { type: String, required: true, trim: true },
    content: { type: String, default: "" },
    is_deleted: { type: Boolean, default: false },
    baseBlobSha: { type: String },
  },
  { collection: "dbt_file_drafts", timestamps: true },
);

// One draft per (project, user, branch, path): each branch keeps its own
// uncommitted overlay per user.
DbtFileDraftSchema.index(
  { projectId: 1, userId: 1, branch: 1, path: 1 },
  { unique: true },
);
DbtFileDraftSchema.index({ workspaceId: 1, projectId: 1, userId: 1 });
// Branch-wide draft ops (relocate on PR merge, drop on branch delete).
DbtFileDraftSchema.index({ projectId: 1, branch: 1 });

export const DbtFileDraft = mongoose.model<IDbtFileDraft>(
  "DbtFileDraft",
  DbtFileDraftSchema,
);

/**
 * Per-user branch pointer for a repo-bound dbt project (dbt Cloud-style
 * per-developer checkout). Absence of a row means the user implicitly tracks
 * the project default branch (`project.repo.branch`). Two users on the same
 * project can work on different branches simultaneously.
 */
export interface IDbtCheckout extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: string;
  branch: string;
  /** Commit SHA this user's branch base tree was last synced/pushed at. */
  lastSyncedSha?: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DbtCheckoutSchema = new Schema<IDbtCheckout>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    userId: { type: String, required: true },
    branch: { type: String, required: true, trim: true },
    lastSyncedSha: { type: String },
    lastSyncedAt: { type: Date },
  },
  { collection: "dbt_checkouts", timestamps: true },
);

DbtCheckoutSchema.index({ projectId: 1, userId: 1 }, { unique: true });
DbtCheckoutSchema.index({ projectId: 1, branch: 1 });

/**
 * Per-user DEVELOPMENT environment choice for a dbt project — which
 * environment this user's ad-hoc work (editor runs, agent builds, previews)
 * targets by default.
 *
 * The working model this encodes:
 *  - Single player: the shared dev environment IS your personal target —
 *    drafts and branch verification build against dev. No row needed.
 *  - Multiple players: each user points at their own personal environment
 *    (schema `dbt_<user>`), so nobody stomps a teammate's schema.
 *
 * Absent row → resolution falls back to the user's personal environment when
 * one exists, else the project default. Explicit requests always win.
 */
export interface IDbtEnvPreference extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: string;
  /** Environment name from the project's environments list. */
  environment: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtEnvPreferenceSchema = new Schema<IDbtEnvPreference>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    userId: { type: String, required: true },
    environment: { type: String, required: true, trim: true },
  },
  { collection: "dbt_env_preferences", timestamps: true },
);

DbtEnvPreferenceSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export const DbtEnvPreference = mongoose.model<IDbtEnvPreference>(
  "DbtEnvPreference",
  DbtEnvPreferenceSchema,
);

export const DbtCheckout = mongoose.model<IDbtCheckout>(
  "DbtCheckout",
  DbtCheckoutSchema,
);

/**
 * GitHub App installation linked to a workspace. We never persist installation
 * access tokens (they expire hourly and are minted on demand from the App's
 * private key); this record just maps a workspace to the installation id and
 * the account it was installed on so we can list repos and sync dbt projects.
 */
export interface IGitHubInstallation extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** GitHub App installation id (from install callback / webhook). */
  installationId: number;
  /** Login of the org/user the app is installed on. */
  accountLogin: string;
  accountType: "Organization" | "User";
  /** Whether the app can access all repos or a selected subset. */
  repositorySelection: "all" | "selected";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const GitHubInstallationSchema = new Schema<IGitHubInstallation>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    installationId: { type: Number, required: true },
    accountLogin: { type: String, required: true, trim: true },
    accountType: {
      type: String,
      enum: ["Organization", "User"],
      default: "Organization",
    },
    repositorySelection: {
      type: String,
      enum: ["all", "selected"],
      default: "all",
    },
    createdBy: { type: String, required: true },
  },
  { collection: "github_installations", timestamps: true },
);

GitHubInstallationSchema.index(
  { workspaceId: 1, installationId: 1 },
  { unique: true },
);

export const GitHubInstallation = mongoose.model<IGitHubInstallation>(
  "GitHubInstallation",
  GitHubInstallationSchema,
);

export interface IDbtJob extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  /** Environment name from the project's environments list. */
  environment: string;
  /** Validated against the dbt command allowlist (api/src/dbt/commands.ts). */
  commands: string[];
  schedule?: {
    cron: string;
    timezone: string;
  };
  /** Mirrors SavedConsole.scheduledRun so the optimistic claim transfers. */
  scheduledRun?: {
    nextAt?: Date;
    lastAt?: Date;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    runCount: number;
    consecutiveFailures: number;
  };
  enabled: boolean;
  /** Reserved for Slim CI (--defer against the stored prod manifest). */
  deferToProduction: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtJobSchema = new Schema<IDbtJob>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    environment: { type: String, required: true },
    commands: { type: [String], default: [] },
    schedule: {
      cron: { type: String },
      timezone: { type: String },
    },
    scheduledRun: {
      nextAt: { type: Date },
      lastAt: { type: Date },
      lastStatus: { type: String, enum: ["success", "error"] },
      lastError: { type: String },
      lastDurationMs: { type: Number },
      runCount: { type: Number, default: 0 },
      consecutiveFailures: { type: Number, default: 0 },
    },
    enabled: { type: Boolean, default: true },
    deferToProduction: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
  },
  { collection: "dbt_jobs", timestamps: true },
);

DbtJobSchema.index({ workspaceId: 1, projectId: 1 });
DbtJobSchema.index({ "scheduledRun.nextAt": 1, enabled: 1 }, { sparse: true });

export const DbtJob = mongoose.model<IDbtJob>("DbtJob", DbtJobSchema);

export type DbtRunStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "cancelled";

export interface IDbtRunLogLine {
  ts: Date;
  level: string;
  line: string;
}

export interface IDbtRunStepResult {
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

export interface IDbtRun extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  jobId?: Types.ObjectId;
  environment: string;
  commands: string[];
  status: DbtRunStatus;
  trigger: "schedule" | "manual" | "agent" | "ci";
  /** User id for manual triggers, "scheduler" / "agent" / "ci-webhook". */
  triggeredBy: string;
  /**
   * Branch whose committed base tree the run executes against (repo-bound
   * projects). Unset means the project default branch. CI runs set the PR
   * head branch so Slim CI builds the PR's code.
   */
  gitBranch?: string;
  /**
   * When set, the run builds this user's WORKING tree (their checkout branch
   * plus draft overlay) instead of a committed base tree — used by
   * agent-triggered verification builds of uncommitted work. Scheduled /
   * CI / deploy runs leave this unset.
   */
  workingTreeUserId?: string;
  /**
   * DISPLAY-ONLY: the git branch this run's source tree came from, stamped
   * at trigger time so the Runs UI can say what was built without re-deriving
   * it. Working-tree runs record the caller's checkout branch; job/deploy
   * runs record the tracked branch; CI runs record the PR head. The executor
   * never reads this — `gitBranch` / `workingTreeUserId` stay authoritative.
   */
  sourceBranch?: string;
  /**
   * Ad-hoc/agent runs only: run with `--defer --state <prod manifest>` so
   * unselected refs resolve to the last production build instead of
   * rebuilding the whole upstream DAG in the target schema. Job runs read
   * the flag from the job (`job.deferToProduction`) and CI runs from the
   * project CI config, so those leave this unset.
   */
  deferToProduction?: boolean;
  /**
   * Pull-request CI context (trigger === "ci"). Drives the GitHub commit
   * status posted back to the PR head on completion.
   */
  ci?: {
    prNumber: number;
    headSha: string;
    headRef: string;
    baseRef: string;
    owner: string;
    repo: string;
    installationId?: number;
  };
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  /** When a cancel was requested / finalized (status === "cancelled"). */
  cancelledAt?: Date;
  /** User id that cancelled the run, or "agent" for automated cancels. */
  cancelledBy?: string;
  /** Capped, batch-written log lines (parsed from --log-format json). */
  logs: IDbtRunLogLine[];
  /** Parsed from run_results.json after each command. */
  stepResults: IDbtRunStepResult[];
  artifactKeys: {
    manifest?: string;
    runResults?: string;
    catalog?: string;
    sources?: string;
  };
  /** Set on retry runs: the run this was retried from. */
  retryOfRunId?: Types.ObjectId;
  /**
   * Artifact keys restored into target/ before commands run (retry-from-
   * failure: run_results.json drives `dbt retry`).
   */
  restoreArtifactKeys?: {
    runResults?: string;
    manifest?: string;
  };
  error?: string;
  inngestRunId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtRunSchema = new Schema<IDbtRun>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: "DbtJob" },
    environment: { type: String, required: true },
    commands: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["queued", "running", "success", "error", "cancelled"],
      default: "queued",
      required: true,
    },
    trigger: {
      type: String,
      enum: ["schedule", "manual", "agent", "ci"],
      required: true,
    },
    triggeredBy: { type: String, required: true },
    gitBranch: { type: String },
    workingTreeUserId: { type: String },
    sourceBranch: { type: String },
    deferToProduction: { type: Boolean },
    ci: {
      type: new Schema(
        {
          prNumber: { type: Number, required: true },
          headSha: { type: String, required: true },
          headRef: { type: String, required: true },
          baseRef: { type: String, required: true },
          owner: { type: String, required: true },
          repo: { type: String, required: true },
          installationId: { type: Number },
        },
        { _id: false },
      ),
      required: false,
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    durationMs: { type: Number },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },
    logs: {
      type: [
        new Schema<IDbtRunLogLine>(
          {
            ts: { type: Date, required: true },
            level: { type: String, default: "info" },
            line: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    stepResults: {
      type: [
        new Schema<IDbtRunStepResult>(
          {
            uniqueId: { type: String, required: true },
            name: { type: String, required: true },
            resourceType: { type: String, default: "model" },
            status: { type: String, required: true },
            executionTimeMs: { type: Number, default: 0 },
            rowsAffected: { type: Number },
            message: { type: String },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    artifactKeys: {
      manifest: { type: String },
      runResults: { type: String },
      catalog: { type: String },
      sources: { type: String },
    },
    retryOfRunId: { type: Schema.Types.ObjectId, ref: "DbtRun" },
    restoreArtifactKeys: {
      runResults: { type: String },
      manifest: { type: String },
    },
    error: { type: String },
    inngestRunId: { type: String },
  },
  { collection: "dbt_runs", timestamps: true },
);

DbtRunSchema.index({ workspaceId: 1, projectId: 1, createdAt: -1 });
DbtRunSchema.index({ jobId: 1, createdAt: -1 }, { sparse: true });

export const DbtRun = mongoose.model<IDbtRun>("DbtRun", DbtRunSchema);

/**
 * MCP (Model Context Protocol) integration.
 *
 * Three collections, modeled after Onyx's split between server definitions
 * and credentials:
 *  - `mcp_servers`            — workspace-level server definition (URL,
 *                               transport, tool policy, cached tool list).
 *  - `mcp_connection_configs` — encrypted credentials; one per workspace
 *                               (shared) or one per user, depending on the
 *                               server's `authPerformer`.
 *  - `mcp_tool_grants`        — per-user "always allow" / "always deny"
 *                               decisions that back the chat approval flow.
 */

export type McpTransportType = "http";
export type McpAuthType = "none" | "api_key" | "oauth";
/**
 * Who supplies credentials. Following the Claude-connectors model, every
 * user authenticates individually ("user") — enabling a connector for the
 * workspace never grants shared data access. "workspace" is retained for
 * backward compatibility with early servers only.
 */
export type McpAuthPerformer = "workspace" | "user";

/**
 * Admin-set permission ceiling for one tool (Claude-connectors model):
 *  - "always": users can choose Always allow, Ask, or Block
 *  - "ask":    users can choose Ask or Block (never Always allow)
 *  - "block":  the tool is never exposed to the agent
 * Restrictions set a ceiling — users can always choose a stricter setting.
 */
export type McpToolRestriction = "always" | "ask" | "block";
export type McpWriteScope = "read" | "write_safe" | "write_destructive";
export type McpServerStatus =
  | "created"
  | "awaiting_auth"
  | "connected"
  | "error";

export interface IMcpCachedTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input, captured at discovery time. */
  inputSchema?: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, ...) if provided. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    [key: string]: unknown;
  };
}

export interface IMcpServer extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  /** Preset key ("close", "custom", ...) — drives the config form + defaults. */
  connectorType: string;
  transport: {
    type: McpTransportType;
    url: string;
  };
  authType: McpAuthType;
  authPerformer: McpAuthPerformer;
  /**
   * Write capability requested from the server. For servers with a scope
   * header preset (e.g. Close's `Close-Scope`), this is sent on connect and
   * enforced server-side by the provider. Also used as the fallback risk
   * tier for tools without MCP annotations.
   */
  writeScope: McpWriteScope;
  toolPolicy: {
    /**
     * Ceiling applied to tools without a specific restriction below —
     * including tools the server adds later.
     */
    defaultRestriction: McpToolRestriction;
    /** Per-tool ceilings, keyed by the raw MCP tool name. */
    restrictions: Record<string, McpToolRestriction>;
  };
  /**
   * OAuth client registration (Dynamic Client Registration) for this server.
   * Shared across all users connecting to the server; per-user tokens live on
   * their `mcp_connection_configs` document. `clientInformation` is the
   * encrypted JSON of the DCR response (client_id, client_secret, ...).
   */
  oauth?: {
    clientInformation?: string;
  };
  /** Discovered tools from the last successful connect/test. */
  cachedTools: IMcpCachedTool[];
  status: McpServerStatus;
  lastError?: string;
  lastConnectedAt?: Date;
  createdBy: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const McpServerSchema = new Schema<IMcpServer>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    connectorType: { type: String, required: true, default: "custom" },
    transport: {
      type: new Schema(
        {
          type: { type: String, enum: ["http"], required: true },
          url: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    authType: {
      type: String,
      enum: ["none", "api_key", "oauth"],
      required: true,
      default: "api_key",
    },
    authPerformer: {
      type: String,
      enum: ["workspace", "user"],
      required: true,
      default: "workspace",
    },
    writeScope: {
      type: String,
      enum: ["read", "write_safe", "write_destructive"],
      required: true,
      default: "read",
    },
    toolPolicy: {
      type: new Schema(
        {
          defaultRestriction: {
            type: String,
            enum: ["always", "ask", "block"],
            required: true,
            default: "always",
          },
          restrictions: { type: Schema.Types.Mixed, default: {} },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({
        defaultRestriction: "always",
        restrictions: {},
      }),
    },
    cachedTools: {
      type: [
        new Schema<IMcpCachedTool>(
          {
            name: { type: String, required: true },
            description: { type: String },
            inputSchema: { type: Schema.Types.Mixed },
            annotations: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    oauth: {
      type: new Schema(
        {
          clientInformation: { type: String },
        },
        { _id: false },
      ),
      required: false,
    },
    status: {
      type: String,
      enum: ["created", "awaiting_auth", "connected", "error"],
      required: true,
      default: "created",
    },
    lastError: { type: String },
    lastConnectedAt: { type: Date },
    createdBy: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: "mcp_servers", timestamps: true },
);

McpServerSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
McpServerSchema.index({ workspaceId: 1, isActive: 1 });

export const McpServer = mongoose.model<IMcpServer>(
  "McpServer",
  McpServerSchema,
);

export interface IMcpConnectionConfig extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** Empty string for the shared workspace credential; else the user id. */
  userId: string;
  /** Encrypted header values (crypto.service `iv:ciphertext` format). */
  headers: Record<string, string>;
  /** OAuth tokens for this connection (encrypted JSON of OAuthTokens). */
  oauthTokens?: string;
  /** Absolute epoch-ms expiry of the current access token, if known. */
  oauthExpiresAt?: number;
  createdAt: Date;
  updatedAt: Date;
}

const McpConnectionConfigSchema = new Schema<IMcpConnectionConfig>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    userId: { type: String, required: false, default: "" },
    headers: { type: Schema.Types.Mixed, default: {} },
    oauthTokens: { type: String },
    oauthExpiresAt: { type: Number },
  },
  { collection: "mcp_connection_configs", timestamps: true },
);

McpConnectionConfigSchema.index({ serverId: 1, userId: 1 }, { unique: true });
McpConnectionConfigSchema.index({ workspaceId: 1 });

export const McpConnectionConfig = mongoose.model<IMcpConnectionConfig>(
  "McpConnectionConfig",
  McpConnectionConfigSchema,
);

/**
 * Pending MCP OAuth authorization flow: one document per in-flight browser
 * redirect, keyed by the unguessable `state` parameter. Holds the PKCE code
 * verifier until the callback exchanges the authorization code. TTL-reaped
 * after 10 minutes.
 */
export interface IMcpOAuthFlow extends Document {
  _id: Types.ObjectId;
  state: string;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** User who started the flow ("" for the shared workspace credential). */
  configUserId: string;
  /** Session user who must complete the callback. */
  startedByUserId: string;
  /** Encrypted PKCE code verifier. */
  codeVerifier?: string;
  createdAt: Date;
}

const McpOAuthFlowSchema = new Schema<IMcpOAuthFlow>(
  {
    state: { type: String, required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    configUserId: { type: String, required: true, default: "" },
    startedByUserId: { type: String, required: true },
    codeVerifier: { type: String },
  },
  { collection: "mcp_oauth_flows", timestamps: { createdAt: true } },
);

McpOAuthFlowSchema.index({ state: 1 }, { unique: true });
McpOAuthFlowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const McpOAuthFlow = mongoose.model<IMcpOAuthFlow>(
  "McpOAuthFlow",
  McpOAuthFlowSchema,
);

export type McpGrantDecision = "always_allow" | "always_deny";

export interface IMcpToolGrant extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** Grants are always per-user, even on shared workspace credentials. */
  userId: string;
  toolName: string;
  decision: McpGrantDecision;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const McpToolGrantSchema = new Schema<IMcpToolGrant>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    userId: { type: String, required: true },
    toolName: { type: String, required: true },
    decision: {
      type: String,
      enum: ["always_allow", "always_deny"],
      required: true,
    },
    lastUsedAt: { type: Date },
  },
  { collection: "mcp_tool_grants", timestamps: true },
);

McpToolGrantSchema.index(
  { serverId: 1, userId: 1, toolName: 1 },
  { unique: true },
);
McpToolGrantSchema.index({ workspaceId: 1, userId: 1 });

export const McpToolGrant = mongoose.model<IMcpToolGrant>(
  "McpToolGrant",
  McpToolGrantSchema,
);
