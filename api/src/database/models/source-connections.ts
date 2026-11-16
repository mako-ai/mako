import mongoose, { Schema, Document, Types } from "mongoose";
import { type IConnectionWriter, ConnectionWriterSchema } from "./shared";

// Pass-through for source-connection config — encryption is applied at the
// route using the connector's schema, not by this getter/setter.
function encryptSourceConnectionConfig<T>(config: T): T {
  return config;
}

function decryptSourceConnectionConfig<T>(config: T): T {
  return config;
}

/**
 * Source connection: a credential a workspace configured with a connector
 * (Stripe key, Close account, …). Stored in collection `connectors`.
 */
export interface ISourceConnection extends Document {
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
      variables?: Record<string, unknown>;
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
  /**
   * Who may write through this connection's proxy (connections/proxy.service.ts):
   * the same list as on a database connection. Absent or empty: no one.
   * Reading live depends on `liveReads`; syncs are not concerned.
   */
  writers?: IConnectionWriter[];
  /**
   * On: workflows and agents may read the service live through the proxy.
   * Absent or false: off, so a connection made before the proxy existed
   * shows no more than its synced tables until a manager or the workspace
   * owner turns this on. Every new connection, a Custom API one too, starts
   * with it off.
   */
  liveReads?: boolean;
  /**
   * Who may read live, while `liveReads` is on. Absent: everyone in the
   * workspace. A list, even empty: only its principals, and the connection's
   * writers (a writer reads what it writes to). Same entries as `writers`.
   */
  liveReaders?: IConnectionWriter[];
  createdBy: string;
  /**
   * User ids that configure this connection (edit, reveal or replace its
   * key, delete it, change this list). Absent or empty: its creator.
   * See access/source-connection-access.ts.
   */
  managers?: string[];
  createdAt: Date;
  updatedAt: Date;
  lastSyncedAt?: Date;
  isActive: boolean;
  /**
   * Set while the connection waits for a person to paste its key in the app
   * (connectors/connection-key-request.service.ts). An agent creates the
   * connection without the secret and hands the user a one-time link; the
   * key never travels through the conversation. Unset once the key is set.
   */
  keyRequest?: ISourceConnectionKeyRequest;
}

export interface ISourceConnectionKeyRequest {
  /** SHA-256 of the link's token: the token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  /** Config fields the person fills in: the connector's secret fields. */
  fields: string[];
  requestedBy: string;
  createdAt: Date;
}

/**
 * Source-connection schema. Collection name `connectors` is historical and
 * must never change.
 */
const SourceConnectionSchema = new Schema<ISourceConnection>(
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
      set: encryptSourceConnectionConfig,
      get: decryptSourceConnectionConfig,
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
    writers: {
      type: [ConnectionWriterSchema],
      default: undefined,
    },
    liveReads: { type: Boolean },
    liveReaders: {
      type: [ConnectionWriterSchema],
      default: undefined,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    // No default: an absent list means "its creator", and a default would
    // write an empty array onto every connection that is saved.
    managers: {
      type: [String],
      default: undefined,
    },
    lastSyncedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    keyRequest: {
      type: new Schema<ISourceConnectionKeyRequest>(
        {
          tokenHash: { type: String, required: true },
          expiresAt: { type: Date, required: true },
          fields: { type: [String], required: true },
          requestedBy: { type: String, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
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
SourceConnectionSchema.index({ workspaceId: 1 });
SourceConnectionSchema.index({ workspaceId: 1, type: 1 });

export const SourceConnection = mongoose.model<ISourceConnection>(
  "Connector",
  SourceConnectionSchema,
);

/**
 * ConnectorDefinition — the derived index of `connectors/` in the workspace
 * repo, one row per folder on `main`.
 *
 * The repo is the truth and this is the index, exactly as skills and flows
 * are: nothing here is authored through an API, and a row that disagrees with
 * `main` is wrong by definition and is rewritten on the next push. It exists
 * so that listing a workspace's connectors, rendering a credential form, and
 * refusing to run a broken connector are Mongo reads rather than git reads
 * plus a sandbox boot.
 *
 * `status` is the whole point of the row:
 *   indexed  — `spec` ran, its shape is valid. Enough to offer the connector
 *              in the picker so a credential can be entered, and no more: a
 *              push carries no credential, so `check` has nothing to run
 *              against and the connector is unproven.
 *   verified — a real `check` succeeded against a real data source. Only ever
 *              set from the data-source path, never from a push.
 *   blocked  — `spec` failed, or its shape is invalid, or (with connector
 *              bundles on) its dependencies failed to build. `blockedReason`
 *              is shown to whoever pushed it, and the connector cannot back
 *              a flow.
 *
 * `build` sits next to `status` for a folder that carries a `package.json`
 * while CONNECTOR_BUNDLES_ENABLED is on: the source hash of the last build
 * and whether it produced a bundle. Absent for every other connector.
 */
export interface IConnectorDefinition extends Document {
  workspaceId: mongoose.Types.ObjectId;
  slug: string;
  runtime: string;
  /**
   * The file to run, from `connector.yaml`. Indexed here because every
   * command after the push — check, discover, read — has to run the same file
   * the push ran, and only this row remembers which one that was.
   */
  entry: string;
  /** The commit this folder was read at, so a stale row is recognisable. */
  sha: string;
  /** Blob sha of connector.yaml plus the entry file: the idempotence check. */
  sourceSha: string;
  spec?: Record<string, unknown>;
  status: "indexed" | "verified" | "blocked";
  blockedReason?: string;
  entities: string[];
  hasIcon: boolean;
  lastCheckedAt?: Date;
  /**
   * Why the last real connection test failed. Distinct from `blockedReason`
   * on purpose: a bad credential is not a broken connector, and conflating
   * them would grey out a connector in the picker that only needs a new key.
   */
  lastCheckError?: string;
  /** The last bundle build for this folder (RFC connector-runtime §5). */
  build?: {
    status: "built" | "failed";
    /** The source hash the bundle is stored under. */
    hash: string;
    /** npm's or esbuild's own words when the build failed. */
    error?: string;
    bytes?: number;
    builtAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ConnectorBuildSchema = new Schema(
  {
    status: { type: String, enum: ["built", "failed"], required: true },
    hash: { type: String, required: true },
    error: { type: String, maxlength: 4000 },
    bytes: { type: Number },
    builtAt: { type: Date },
  },
  { _id: false },
);

const ConnectorDefinitionSchema = new Schema<IConnectorDefinition>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    slug: { type: String, required: true, trim: true },
    runtime: { type: String, required: true, default: "node" },
    entry: { type: String, required: true, default: "connector.ts" },
    sha: { type: String, required: true },
    sourceSha: { type: String, required: true },
    spec: { type: Schema.Types.Mixed },
    status: {
      type: String,
      enum: ["indexed", "verified", "blocked"],
      default: "indexed",
      required: true,
    },
    blockedReason: { type: String, maxlength: 4000 },
    entities: { type: [String], default: [] },
    hasIcon: { type: Boolean, default: false },
    lastCheckedAt: { type: Date },
    lastCheckError: { type: String, maxlength: 4000 },
    build: { type: ConnectorBuildSchema },
  },
  { collection: "connectordefinitions", timestamps: true },
);

ConnectorDefinitionSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });

export const ConnectorDefinition = mongoose.model<IConnectorDefinition>(
  "ConnectorDefinition",
  ConnectorDefinitionSchema,
);
