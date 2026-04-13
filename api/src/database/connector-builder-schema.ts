import mongoose, { Document, Schema, Types } from "mongoose";
import * as crypto from "crypto";

let encryptionKeyCache: string | null = null;

function getEncryptionKey(): string {
  if (!encryptionKeyCache) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }
    encryptionKeyCache = key;
  }

  return encryptionKeyCache;
}

function encryptValue(value: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    iv,
  );

  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptValue(value: string): string {
  const [ivHex, ...rest] = value.split(":");
  if (!ivHex || rest.length === 0) {
    throw new Error("Invalid encrypted text format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    Buffer.from(ivHex, "hex"),
  );

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(rest.join(":"), "hex")),
    decipher.final(),
  ]);

  return decrypted.toString();
}

function encryptMixedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => encryptMixedObject(item));
  }

  if (value && typeof value === "object") {
    const encrypted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      encrypted[key] = encryptMixedObject(nestedValue);
    }
    return encrypted;
  }

  if (typeof value === "string" && value.length > 0) {
    return encryptValue(value);
  }

  return value;
}

function decryptMixedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => decryptMixedObject(item));
  }

  if (value && typeof value === "object") {
    const decrypted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      decrypted[key] = decryptMixedObject(nestedValue);
    }
    return decrypted;
  }

  if (
    typeof value === "string" &&
    /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(value)
  ) {
    try {
      return decryptValue(value);
    } catch {
      return value;
    }
  }

  return value;
}

export interface IUserConnectorVersionSnapshot {
  version: number;
  code: string;
  bundleJs?: string;
  bundleSourceMap?: string;
  buildHash?: string;
  builtAt?: Date;
  createdAt: Date;
  createdBy: string;
  resolvedDependencies: string[];
}

export interface IUserConnectorBuildError {
  message: string;
  line?: number;
  column?: number;
  raw?: string;
  severity?: "error" | "warning";
}

export interface IUserConnector extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  source: {
    code: string;
    resolvedDependencies: string[];
  };
  bundle: {
    js?: string;
    sourceMap?: string;
    buildHash?: string;
    buildLog?: string;
    errors: IUserConnectorBuildError[];
    builtAt?: Date;
    runtime?: "e2b" | "local-fallback";
  };
  metadata: {
    language: "typescript";
    entrypoint: string;
    runtime: "nodejs";
    tags: string[];
  };
  version: number;
  versions: IUserConnectorVersionSnapshot[];
  visibility: "private" | "workspace" | "public";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IConnectorInstance extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  connectorId: Types.ObjectId;
  name: string;
  secrets: Record<string, unknown>;
  config: Record<string, unknown>;
  output: {
    destinationDatabaseId?: Types.ObjectId;
    destinationSchema?: string;
    destinationTablePrefix?: string;
    evolutionMode?: "strict" | "append" | "variant" | "relaxed";
  };
  triggers: Array<{
    type: "manual" | "schedule" | "webhook";
    enabled: boolean;
    cron?: string;
    path?: string;
    timezone?: string;
  }>;
  state: Record<string, unknown>;
  status: "idle" | "active" | "running" | "error" | "disabled";
  lastRunAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserConnectorWebhookEvent extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  instanceId: Types.ObjectId;
  eventId: string;
  eventType: string;
  receivedAt: Date;
  status: "pending" | "processed" | "failed";
  rawPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface IConnectorExecution extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  connectorId: Types.ObjectId;
  instanceId: Types.ObjectId;
  triggerType: "manual" | "schedule" | "webhook";
  status: "running" | "completed" | "failed" | "cancelled";
  runtime?: "e2b" | "local-fallback";
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  rowCount?: number;
  error?: {
    message: string;
    stack?: string;
  };
  logs: Array<{
    level: string;
    message: string;
    timestamp?: Date;
  }>;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const UserConnectorBuildErrorSchema = new Schema<IUserConnectorBuildError>(
  {
    message: { type: String, required: true },
    line: { type: Number },
    column: { type: Number },
    raw: { type: String },
    severity: {
      type: String,
      enum: ["error", "warning"],
      default: "error",
    },
  },
  { _id: false },
);

const UserConnectorVersionSchema = new Schema<IUserConnectorVersionSnapshot>(
  {
    version: { type: Number, required: true },
    code: { type: String, required: true },
    bundleJs: { type: String },
    bundleSourceMap: { type: String },
    buildHash: { type: String },
    builtAt: { type: Date },
    createdAt: { type: Date, default: Date.now, required: true },
    createdBy: { type: String, required: true },
    resolvedDependencies: { type: [String], default: [] },
  },
  { _id: false },
);

const UserConnectorSchema = new Schema<IUserConnector>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    source: {
      code: { type: String, required: true },
      resolvedDependencies: { type: [String], default: [] },
    },
    bundle: {
      js: { type: String },
      sourceMap: { type: String },
      buildHash: { type: String },
      buildLog: { type: String },
      errors: { type: [UserConnectorBuildErrorSchema], default: [] },
      builtAt: { type: Date },
      runtime: {
        type: String,
        enum: ["e2b", "local-fallback"],
      },
    },
    metadata: {
      language: {
        type: String,
        enum: ["typescript"],
        default: "typescript",
      },
      entrypoint: { type: String, default: "pull" },
      runtime: {
        type: String,
        enum: ["nodejs"],
        default: "nodejs",
      },
      tags: { type: [String], default: [] },
    },
    version: { type: Number, default: 1 },
    versions: { type: [UserConnectorVersionSchema], default: [] },
    visibility: {
      type: String,
      enum: ["private", "workspace", "public"],
      default: "private",
    },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "userconnectors",
  },
);

UserConnectorSchema.index({ workspaceId: 1 });
UserConnectorSchema.index({ workspaceId: 1, name: 1 });

const ConnectorInstanceSchema = new Schema<IConnectorInstance>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    connectorId: {
      type: Schema.Types.ObjectId,
      ref: "UserConnector",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    secrets: {
      type: Schema.Types.Mixed,
      default: {},
      set: encryptMixedObject,
      get: decryptMixedObject,
    },
    config: {
      type: Schema.Types.Mixed,
      default: {},
    },
    output: {
      destinationDatabaseId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      destinationSchema: { type: String },
      destinationTablePrefix: { type: String },
      evolutionMode: {
        type: String,
        enum: ["strict", "append", "variant", "relaxed"],
        default: "append",
      },
    },
    triggers: {
      type: [
        new Schema(
          {
            type: {
              type: String,
              enum: ["manual", "schedule", "webhook"],
              required: true,
            },
            enabled: { type: Boolean, default: true },
            cron: { type: String },
            path: { type: String },
            timezone: { type: String, default: "UTC" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    state: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["idle", "active", "running", "error", "disabled"],
      default: "idle",
    },
    lastRunAt: { type: Date },
    lastSuccessAt: { type: Date },
    lastError: { type: String },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "connectorinstances",
  },
);

ConnectorInstanceSchema.index({ workspaceId: 1 });
ConnectorInstanceSchema.index({ workspaceId: 1, connectorId: 1 });

const ConnectorExecutionSchema = new Schema<IConnectorExecution>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    connectorId: {
      type: Schema.Types.ObjectId,
      ref: "UserConnector",
      required: true,
    },
    instanceId: {
      type: Schema.Types.ObjectId,
      ref: "ConnectorInstance",
      required: true,
    },
    triggerType: {
      type: String,
      enum: ["manual", "schedule", "webhook"],
      required: true,
    },
    status: {
      type: String,
      enum: ["running", "completed", "failed", "cancelled"],
      required: true,
      default: "running",
    },
    runtime: {
      type: String,
      enum: ["e2b", "local-fallback"],
    },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    durationMs: { type: Number },
    rowCount: { type: Number },
    error: {
      message: { type: String },
      stack: { type: String },
    },
    logs: {
      type: [
        new Schema(
          {
            level: { type: String, required: true },
            message: { type: String, required: true },
            timestamp: { type: Date },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "connectorexecutions",
  },
);

ConnectorExecutionSchema.index({
  workspaceId: 1,
  instanceId: 1,
  startedAt: -1,
});
ConnectorExecutionSchema.index({
  workspaceId: 1,
  connectorId: 1,
  startedAt: -1,
});

const UserConnectorWebhookEventSchema = new Schema<IUserConnectorWebhookEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    instanceId: {
      type: Schema.Types.ObjectId,
      ref: "ConnectorInstance",
      required: true,
    },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "processed", "failed"],
      default: "pending",
    },
    rawPayload: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "userconnectorwebhookevents",
  },
);

UserConnectorWebhookEventSchema.index(
  { instanceId: 1, eventId: 1 },
  { unique: true },
);
UserConnectorWebhookEventSchema.index({ workspaceId: 1, receivedAt: -1 });

export const UserConnector =
  (mongoose.models.UserConnector as mongoose.Model<IUserConnector>) ||
  mongoose.model<IUserConnector>("UserConnector", UserConnectorSchema);

export const ConnectorInstance =
  (mongoose.models.ConnectorInstance as mongoose.Model<IConnectorInstance>) ||
  mongoose.model<IConnectorInstance>(
    "ConnectorInstance",
    ConnectorInstanceSchema,
  );

export const ConnectorExecution =
  (mongoose.models.ConnectorExecution as mongoose.Model<IConnectorExecution>) ||
  mongoose.model<IConnectorExecution>(
    "ConnectorExecution",
    ConnectorExecutionSchema,
  );

export const UserConnectorWebhookEvent =
  (mongoose.models
    .UserConnectorWebhookEvent as mongoose.Model<IUserConnectorWebhookEvent>) ||
  mongoose.model<IUserConnectorWebhookEvent>(
    "UserConnectorWebhookEvent",
    UserConnectorWebhookEventSchema,
  );
