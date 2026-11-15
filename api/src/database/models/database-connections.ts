import mongoose, { Schema, Document, Types } from "mongoose";
import { loggers } from "../../logging";
import {
  encrypt,
  decrypt,
  type IConnectionWriter,
  ConnectionWriterSchema,
} from "./shared";

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
  /**
   * Opt-in: scoped agent credentials (MCP query:write keys) may run write
   * statements against this connection. Off by default; read-only agent
   * access is unaffected. Set it on connections created for agent writes.
   */
  allowAgentWrites?: boolean;
  /**
   * Who may write through this connection (access/connection-writes.ts).
   * Absent or empty: no one. Everyone
   * may always read; system jobs (syncs, flows, dbt) are not concerned.
   */
  writers?: IConnectionWriter[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt?: Date;
}

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
    allowAgentWrites: {
      type: Boolean,
      default: false,
    },
    writers: {
      type: [ConnectionWriterSchema],
      default: undefined,
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

export const DatabaseConnection = mongoose.model<IDatabaseConnection>(
  "DatabaseConnection",
  DatabaseConnectionSchema,
);

export interface IConnectionVerification extends Document {
  _id: Types.ObjectId;
  verifiedAt: Date;

  // Who triggered the test (absent for unauthenticated/system paths)
  userId?: string;
  workspaceId?: Types.ObjectId;

  // Saved connection under test; absent for pre-save tests of unsaved configs
  connectionId?: Types.ObjectId;
  databaseType: string;

  // Where in the product the test ran
  trigger: "standalone_test" | "create_verify" | "update_verify" | "saved_test";

  // Outcome
  success: boolean;
  durationMs: number;
  errorClass?: string; // auth_failed, host_not_found, timeout, tls, ...
  errorMessage?: string; // Truncated driver error, for drill-down
}

/**
 * ConnectionVerification Schema
 * One row per connection test, kept 90 days for reliability analytics
 */
const ConnectionVerificationSchema = new Schema<IConnectionVerification>(
  {
    verifiedAt: { type: Date, required: true, default: Date.now },
    userId: { type: String, ref: "User", required: false },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
    },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: false,
    },
    databaseType: { type: String, required: true },
    trigger: {
      type: String,
      enum: ["standalone_test", "create_verify", "update_verify", "saved_test"],
      required: true,
    },
    success: { type: Boolean, required: true },
    durationMs: { type: Number, required: true },
    errorClass: { type: String, required: false },
    errorMessage: { type: String, required: false },
  },
  {
    collection: "connection_verifications",
    timestamps: false,
  },
);

ConnectionVerificationSchema.index({ workspaceId: 1, verifiedAt: -1 });
ConnectionVerificationSchema.index({ userId: 1, verifiedAt: -1 });
ConnectionVerificationSchema.index({
  success: 1,
  errorClass: 1,
  verifiedAt: -1,
}); // Failure-mode rollups
ConnectionVerificationSchema.index(
  { verifiedAt: 1 },
  { expireAfterSeconds: 7776000 },
); // TTL: 90 days

export const ConnectionVerification = mongoose.model<IConnectionVerification>(
  "ConnectionVerification",
  ConnectionVerificationSchema,
);
