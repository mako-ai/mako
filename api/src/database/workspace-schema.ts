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

function encrypt(text: string): string {
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

function decrypt(text: string): string {
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
  };
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
      privateKey?: string;
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
  code: string;
  language: "sql" | "javascript" | "mongodb";
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
  owner_id: string;
  is_deleted?: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
  executionCount: number;
}

/**
 * Message part types for AI SDK v6 compatibility
 * Stores parts in chronological order to preserve the original message structure
 */
export interface IMessagePart {
  type: string; // "text", "reasoning", "tool-{toolName}", "dynamic-tool"
  text?: string; // For text and reasoning parts
  reasoning?: string; // Alternative field for reasoning content
  toolCallId?: string; // For tool parts
  toolName?: string; // For tool parts
  input?: unknown; // Tool input/arguments (named 'input' for AI SDK v6 compat, was 'args')
  output?: unknown; // Tool result (named 'output' for AI SDK v6 compat, was 'result')
  state?: string; // Tool state: "input-streaming", "input-available", "output-streaming", "output-available", "error"
}

/**
 * Usage history entry for tracking token consumption per turn
 * Useful for metered billing and cost analysis
 */
export interface IUsageHistoryEntry {
  messageIndex: number; // Index of the assistant message this usage corresponds to
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string; // Model used for this turn (for cost calculation)
  timestamp: Date;
}

/**
 * Chat usage tracking for token consumption
 */
export interface IChatUsage {
  promptTokens: number; // Total prompt tokens across all turns
  completionTokens: number; // Total completion tokens across all turns
  totalTokens: number; // Total tokens (prompt + completion)
  history?: IUsageHistoryEntry[]; // Per-turn usage for detailed analytics
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
  systemPrompt?: string; // System prompt used for this conversation
  workspacePrompt?: string; // Workspace custom prompt appended to system prompt
  usage?: IChatUsage; // Token usage tracking for billing
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
 * Table destination configuration for writing to SQL tables
 */
export interface ITableDestination {
  connectionId: Types.ObjectId;
  database?: string; // Database name within the connection
  schema?: string; // Schema name (PostgreSQL) or dataset (BigQuery)
  tableName: string; // Target table name
  createIfNotExists?: boolean; // Auto-create table if it doesn't exist
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

  // Incremental and conflict config (for database sources)
  incrementalConfig?: IIncrementalConfig;
  conflictConfig?: IConflictConfig;
  paginationConfig?: IPaginationConfig; // Pagination mode for database syncs
  typeCoercions?: ITypeCoercion[]; // Type coercion rules for column mapping
  batchSize?: number; // Batch size for processing (default: 2000)

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
  source: "console_ui" | "api" | "agent" | "flow";
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
    code: {
      type: String,
      required: true,
    },
    language: {
      type: String,
      enum: ["sql", "javascript", "mongodb"],
      required: true,
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
    owner_id: {
      type: String,
      ref: "User",
    },
    lastExecutedAt: {
      type: Date,
    },
    executionCount: {
      type: Number,
      default: 0,
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
SavedConsoleSchema.index({ workspaceId: 1, createdBy: 1, isPrivate: 1 });
SavedConsoleSchema.index({ workspaceId: 1, isSaved: 1 }); // For filtering saved vs draft consoles
SavedConsoleSchema.index({ connectionId: 1 }, { sparse: true }); // Sparse index since connectionId is optional
SavedConsoleSchema.index({ workspaceId: 1, access: 1, owner_id: 1 }); // Console access model queries

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
            toolCallId: String,
            toolName: String,
            input: Schema.Types.Mixed,
            output: Schema.Types.Mixed,
            state: String,
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
    },
    schedule: {
      enabled: {
        type: Boolean,
        default: true,
      },
      cron: {
        type: String,
        required: function () {
          return this.type === "scheduled" && this.schedule?.enabled;
        },
        validate: {
          validator: function (v: string) {
            // Skip validation for webhook flows
            if (this.type === "webhook") return true;
            if (!this.schedule?.enabled) return true;
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
  },
  {
    timestamps: false,
  },
);

// Indexes
WebhookEventSchema.index({ flowId: 1, eventId: 1 }, { unique: true });
WebhookEventSchema.index({ flowId: 1, status: 1, receivedAt: 1 });
WebhookEventSchema.index({ workspaceId: 1, receivedAt: -1 });

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
      enum: ["console_ui", "api", "agent", "flow"],
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
export const ConsoleFolder = mongoose.model<IConsoleFolder>(
  "ConsoleFolder",
  ConsoleFolderSchema,
);
export const SavedConsole = mongoose.model<ISavedConsole>(
  "SavedConsole",
  SavedConsoleSchema,
);
export const Chat = mongoose.model<IChat>("Chat", ChatSchema);
export const Flow = mongoose.model<IFlow>("Flow", FlowSchema);
export const FlowExecution = mongoose.model<IFlowExecution>(
  "FlowExecution",
  FlowExecutionSchema,
);
export const WebhookEvent = mongoose.model<IWebhookEvent>(
  "WebhookEvent",
  WebhookEventSchema,
);
export const QueryExecution = mongoose.model<IQueryExecution>(
  "QueryExecution",
  QueryExecutionSchema,
);
