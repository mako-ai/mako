import mongoose, { Schema, Document, Types } from "mongoose";
import * as crypto from "crypto";

function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  return key;
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
  if (!obj || typeof obj !== "object") return obj;
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
  if (!obj || typeof obj !== "object") return obj;
  const decrypted: any = {};
  for (const key in obj) {
    if (typeof obj[key] === "string" && obj[key] && obj[key].includes(":")) {
      try {
        decrypted[key] = decrypt(obj[key]);
      } catch {
        decrypted[key] = obj[key];
      }
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      try {
        decrypted[key] = decryptObject(obj[key]);
      } catch {
        decrypted[key] = obj[key];
      }
    } else {
      decrypted[key] = obj[key];
    }
  }
  return decrypted;
}

// ── UserConnector: the reusable code artifact ──

export interface IUserConnectorVersion {
  version: number;
  code: string;
  bundleJs?: string;
  bundleSourceMap?: string;
  buildHash?: string;
  createdAt: Date;
  createdBy: string;
}

export interface IUserConnector extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  source: {
    code: string;
    resolvedDependencies?: Record<string, string>;
  };
  bundle?: {
    js?: string;
    sourceMap?: string;
    buildHash?: string;
    buildLog?: string;
    builtAt?: Date;
    errors?: Array<{
      line?: number;
      column?: number;
      message: string;
      severity: "error" | "warning";
    }>;
  };
  metadata: {
    entities?: string[];
    configSchema?: Record<string, unknown>;
    secretKeys?: string[];
  };
  version: number;
  versions: IUserConnectorVersion[];
  visibility: "private" | "workspace" | "public";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserConnectorSchema = new Schema<IUserConnector>(
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
    description: {
      type: String,
      trim: true,
    },
    source: {
      code: { type: String, required: true, default: "" },
      resolvedDependencies: { type: Schema.Types.Mixed },
    },
    bundle: {
      js: { type: String },
      sourceMap: { type: String },
      buildHash: { type: String },
      buildLog: { type: String },
      builtAt: { type: Date },
      errors: [
        {
          line: { type: Number },
          column: { type: Number },
          message: { type: String, required: true },
          severity: {
            type: String,
            enum: ["error", "warning"],
            required: true,
          },
        },
      ],
    },
    metadata: {
      entities: [{ type: String }],
      configSchema: { type: Schema.Types.Mixed },
      secretKeys: [{ type: String }],
    },
    version: { type: Number, default: 1 },
    versions: [
      {
        version: { type: Number, required: true },
        code: { type: String, required: true },
        bundleJs: { type: String },
        bundleSourceMap: { type: String },
        buildHash: { type: String },
        createdAt: { type: Date, default: Date.now },
        createdBy: { type: String, required: true },
      },
    ],
    visibility: {
      type: String,
      enum: ["private", "workspace", "public"],
      default: "private",
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "user_connectors",
  },
);

UserConnectorSchema.index({ workspaceId: 1 });
UserConnectorSchema.index({ workspaceId: 1, name: 1 });
UserConnectorSchema.index({ visibility: 1 });

// ── ConnectorInstance: the deployment config ──

export interface IConnectorTrigger {
  type: "cron" | "webhook";
  cron?: string;
  timezone?: string;
  syncMode?: "full" | "incremental";
  webhookPath?: string;
}

export interface IConnectorInstance extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  connectorId: Types.ObjectId;
  name: string;
  secrets: Record<string, string>;
  config: Record<string, unknown>;
  output: {
    destinationConnectionId?: Types.ObjectId;
    destinationDatabase?: string;
    schema?: string;
    tablePrefix?: string;
    schemaEvolutionMode: "additive" | "strict" | "permissive" | "locked";
  };
  triggers: IConnectorTrigger[];
  state: Record<string, unknown>;
  status: {
    enabled: boolean;
    lastRunAt?: Date;
    lastSuccessAt?: Date;
    lastError?: string;
    runCount: number;
    consecutiveFailures: number;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

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
    name: {
      type: String,
      required: true,
      trim: true,
    },
    secrets: {
      type: Schema.Types.Mixed,
      default: {},
      set: encryptObject,
      get: decryptObject,
    },
    config: {
      type: Schema.Types.Mixed,
      default: {},
    },
    output: {
      destinationConnectionId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      destinationDatabase: { type: String },
      schema: { type: String },
      tablePrefix: { type: String },
      schemaEvolutionMode: {
        type: String,
        enum: ["additive", "strict", "permissive", "locked"],
        default: "additive",
      },
    },
    triggers: [
      {
        type: {
          type: String,
          enum: ["cron", "webhook"],
          required: true,
        },
        cron: { type: String },
        timezone: { type: String, default: "UTC" },
        syncMode: {
          type: String,
          enum: ["full", "incremental"],
          default: "incremental",
        },
        webhookPath: { type: String },
      },
    ],
    state: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      enabled: { type: Boolean, default: false },
      lastRunAt: { type: Date },
      lastSuccessAt: { type: Date },
      lastError: { type: String },
      runCount: { type: Number, default: 0 },
      consecutiveFailures: { type: Number, default: 0 },
    },
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
    collection: "connector_instances",
  },
);

ConnectorInstanceSchema.index({ workspaceId: 1 });
ConnectorInstanceSchema.index({ workspaceId: 1, connectorId: 1 });
ConnectorInstanceSchema.index({ "status.enabled": 1 });

// ── Webhook event storage for user connectors ──

export interface IUserConnectorWebhookEvent extends Document {
  _id: Types.ObjectId;
  instanceId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  eventId: string;
  eventType: string;
  receivedAt: Date;
  processedAt?: Date;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  error?: {
    message: string;
    stack?: string;
  };
  rawPayload: unknown;
  processingDurationMs?: number;
}

const UserConnectorWebhookEventSchema = new Schema<IUserConnectorWebhookEvent>(
  {
    instanceId: {
      type: Schema.Types.ObjectId,
      ref: "ConnectorInstance",
      required: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: { type: Date },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0 },
    error: {
      message: { type: String },
      stack: { type: String },
    },
    rawPayload: { type: Schema.Types.Mixed, required: true },
    processingDurationMs: { type: Number },
  },
  {
    timestamps: false,
    collection: "user_connector_webhook_events",
  },
);

UserConnectorWebhookEventSchema.index(
  { instanceId: 1, eventId: 1 },
  { unique: true },
);
UserConnectorWebhookEventSchema.index({
  instanceId: 1,
  status: 1,
  receivedAt: 1,
});
UserConnectorWebhookEventSchema.index({ workspaceId: 1, receivedAt: -1 });

// ── Models ──

export const UserConnector =
  mongoose.models.UserConnector ||
  mongoose.model<IUserConnector>("UserConnector", UserConnectorSchema);

export const ConnectorInstance =
  mongoose.models.ConnectorInstance ||
  mongoose.model<IConnectorInstance>(
    "ConnectorInstance",
    ConnectorInstanceSchema,
  );

export const UserConnectorWebhookEvent =
  mongoose.models.UserConnectorWebhookEvent ||
  mongoose.model<IUserConnectorWebhookEvent>(
    "UserConnectorWebhookEvent",
    UserConnectorWebhookEventSchema,
  );
