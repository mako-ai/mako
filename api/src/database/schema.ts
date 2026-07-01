import mongoose, { type ConnectOptions, Schema, Document } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { loggers } from "../logging";

const mongooseLogger = loggers.db("mongodb");

// Keep the main app connection fail-fast and allow the driver to recycle stale
// sockets after topology changes such as Atlas/cluster migrations.
const mongooseConnectOptions: ConnectOptions = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  retryReads: true,
  serverMonitoringMode: "poll",
};

// Startup connection retry/backoff.
//
// The initial `connectDatabase()` runs before the server starts listening, so
// a single failed attempt aborts the whole boot. A brief, transient Atlas
// condition — most commonly `ReplicaSetNoPrimary` during a failover/maintenance
// window — would otherwise kill the process and fail a Cloud Run rollout even
// though the cluster recovers seconds later. Retrying with bounded exponential
// backoff rides through those blips. Kept modest so the port still opens within
// Cloud Run's startup-probe window; a genuinely-unreachable DB (bad URI, not
// whitelisted) still fails fast after the attempts are exhausted. All knobs are
// env-tunable so ops can widen the window without a code change (pair with a
// longer Cloud Run startup-probe timeout if a failover routinely runs long).
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DB_CONNECT_MAX_ATTEMPTS = positiveIntEnv("DB_CONNECT_MAX_ATTEMPTS", 5);
const DB_CONNECT_BASE_DELAY_MS = positiveIntEnv(
  "DB_CONNECT_BASE_DELAY_MS",
  1000,
);
const DB_CONNECT_MAX_DELAY_MS = positiveIntEnv("DB_CONNECT_MAX_DELAY_MS", 5000);

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

let mongooseListenersRegistered = false;

function registerMongooseConnectionListeners(): void {
  if (mongooseListenersRegistered) {
    return;
  }

  mongoose.connection.on("connected", () => {
    mongooseLogger.info("Mongoose connected to MongoDB", {
      readyState: mongoose.connection.readyState,
    });
  });

  mongoose.connection.on("reconnected", () => {
    mongooseLogger.warn("Mongoose reconnected to MongoDB", {
      readyState: mongoose.connection.readyState,
    });
  });

  mongoose.connection.on("disconnected", () => {
    mongooseLogger.warn("Mongoose disconnected from MongoDB", {
      readyState: mongoose.connection.readyState,
    });
  });

  mongoose.connection.on("close", () => {
    mongooseLogger.warn("Mongoose MongoDB connection closed", {
      readyState: mongoose.connection.readyState,
    });
  });

  mongoose.connection.on("error", error => {
    mongooseLogger.error("Mongoose MongoDB connection error", { error });
  });

  mongooseListenersRegistered = true;
}

/**
 * Onboarding data interface
 */
export interface IUserOnboarding {
  completedAt?: Date;
  companySize?: "hobby" | "startup" | "growth" | "enterprise";
  role?: string;
  primaryDatabase?: string; // User's primary database (postgresql, mysql, etc.) - "none" if no database
  dataWarehouse?: string; // User's data warehouse (snowflake, bigquery, etc.)
}

/**
 * User model interface
 */
export interface IUser extends Document {
  _id: string;
  email: string;
  hashedPassword?: string;
  emailVerified: boolean;
  onboarding?: IUserOnboarding;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Email verification model interface
 */
export interface IEmailVerification extends Document {
  _id: string;
  email: string;
  code: string;
  type: "registration" | "link_password" | "password_reset";
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Desktop auth code model interface.
 *
 * One-time, short-lived codes used to hand a session from the user's system
 * browser to the Mako Desktop app via a `mako://auth?code=...` deep link.
 * The raw code is never stored — `_id` is its SHA-256 hash (base64url).
 * `challenge` is the PKCE-style S256 hash of a verifier held only by the
 * desktop app instance that initiated the flow.
 */
export interface IDesktopAuthCode extends Document {
  _id: string; // SHA-256 hash (base64url) of the raw code
  userId: string;
  challenge: string; // base64url(SHA-256(verifier))
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Session model interface for Lucia
 */
export interface ISession extends Document {
  _id: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
}

/**
 * OAuth Account model interface
 */
export interface IOAuthAccount extends Document {
  userId: string;
  provider: "google" | "github";
  providerUserId: string;
  email?: string;
  createdAt: Date;
}

/**
 * User Schema
 */
const UserSchema = new Schema<IUser>(
  {
    _id: {
      type: String,
      default: () => uuidv4(),
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    hashedPassword: {
      type: String,
      required: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    onboarding: {
      completedAt: {
        type: Date,
        required: false,
      },
      companySize: {
        type: String,
        enum: ["hobby", "startup", "growth", "enterprise"],
        required: false,
      },
      role: {
        type: String,
        required: false,
      },
      primaryDatabase: {
        type: String,
        required: false,
      },
      dataWarehouse: {
        type: String,
        required: false,
      },
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Email Verification Schema
 */
const EmailVerificationSchema = new Schema<IEmailVerification>(
  {
    _id: {
      type: String,
      default: () => uuidv4(),
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["registration", "link_password", "password_reset"],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Indexes for email verification
EmailVerificationSchema.index({ email: 1, type: 1 });
EmailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Desktop Auth Code Schema (browser → desktop app session handoff)
 */
const DesktopAuthCodeSchema = new Schema<IDesktopAuthCode>(
  {
    _id: {
      type: String, // SHA-256 hash (base64url) of the raw code
      required: true,
    },
    userId: {
      type: String,
      required: true,
      ref: "User",
    },
    challenge: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// TTL cleanup for unredeemed codes
DesktopAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Session Schema for Lucia
 */
const SessionSchema = new Schema<ISession>({
  _id: {
    type: String,
    default: () => uuidv4(),
  },
  userId: {
    type: String,
    required: true,
    ref: "User",
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  activeWorkspaceId: {
    type: String,
    required: false,
    ref: "Workspace",
  },
});

// Index for session cleanup
SessionSchema.index({ expiresAt: 1 });

/**
 * OAuth Account Schema
 */
const OAuthAccountSchema = new Schema<IOAuthAccount>(
  {
    userId: {
      type: String,
      required: true,
      ref: "User",
    },
    provider: {
      type: String,
      required: true,
      enum: ["google", "github"],
    },
    providerUserId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Compound index to ensure unique provider accounts
OAuthAccountSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
OAuthAccountSchema.index({ userId: 1 });

// Models - use existing model if already compiled (prevents hot reload issues)
export const User =
  (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>("User", UserSchema);

export const Session =
  (mongoose.models.Session as mongoose.Model<ISession>) ||
  mongoose.model<ISession>("Session", SessionSchema);

export const OAuthAccount =
  (mongoose.models.OAuthAccount as mongoose.Model<IOAuthAccount>) ||
  mongoose.model<IOAuthAccount>("OAuthAccount", OAuthAccountSchema);

export const EmailVerification =
  (mongoose.models.EmailVerification as mongoose.Model<IEmailVerification>) ||
  mongoose.model<IEmailVerification>(
    "EmailVerification",
    EmailVerificationSchema,
  );

export const DesktopAuthCode =
  (mongoose.models.DesktopAuthCode as mongoose.Model<IDesktopAuthCode>) ||
  mongoose.model<IDesktopAuthCode>("DesktopAuthCode", DesktopAuthCodeSchema);

// ---------------------------------------------------------------------------
// LLM Usage — per-invocation tracking for cost analytics
// ---------------------------------------------------------------------------

export interface ILlmUsageStep {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface ILlmUsage extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: string;
  chatId?: mongoose.Types.ObjectId;
  invocationType:
    | "chat"
    | "title_generation"
    | "description_generation"
    | "embedding"
    | "version_comment";
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  steps?: ILlmUsageStep[];
  agentId?: string;
  tags?: string[];
  durationMs?: number;
  createdAt: Date;
}

const LlmUsageStepSchema = new Schema<ILlmUsageStep>(
  {
    modelId: { type: String, required: true },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cacheReadTokens: { type: Number, required: true, default: 0 },
    cacheWriteTokens: { type: Number, required: true, default: 0 },
    reasoningTokens: { type: Number, required: true, default: 0 },
    costUsd: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const LlmUsageSchema = new Schema<ILlmUsage>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    userId: { type: String, required: true },
    chatId: { type: Schema.Types.ObjectId, default: null },
    invocationType: {
      type: String,
      required: true,
      enum: [
        "chat",
        "title_generation",
        "description_generation",
        "embedding",
        "version_comment",
      ],
    },
    modelId: { type: String, required: true },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cacheReadTokens: { type: Number, required: true, default: 0 },
    cacheWriteTokens: { type: Number, required: true, default: 0 },
    reasoningTokens: { type: Number, required: true, default: 0 },
    totalTokens: { type: Number, required: true, default: 0 },
    costUsd: { type: Number, required: true, default: 0 },
    steps: { type: [LlmUsageStepSchema], default: undefined },
    agentId: { type: String },
    tags: { type: [String], default: undefined },
    durationMs: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

LlmUsageSchema.index({ workspaceId: 1, createdAt: -1 });
LlmUsageSchema.index({ userId: 1, createdAt: -1 });
LlmUsageSchema.index({ chatId: 1 });
LlmUsageSchema.index({ workspaceId: 1, userId: 1, createdAt: -1 });

export const LlmUsage =
  (mongoose.models.LlmUsage as mongoose.Model<ILlmUsage>) ||
  mongoose.model<ILlmUsage>("LlmUsage", LlmUsageSchema);

// ---------------------------------------------------------------------------
// Model Catalog Snapshot — raw upstream API responses persisted per source
// ---------------------------------------------------------------------------

export interface IModelCatalogSnapshot extends Document {
  _id: "gateway" | "arena" | "pricing" | "curation" | "capabilities";
  /**
   * Free-form payload keyed by snapshot id:
   *  - gateway / pricing → array of normalized upstream records
   *  - curation          → `{ models, defaultChatModelId, defaultFreeChatModelId, lastRefreshError }`
   *  - capabilities      → `{ thinkingModes: { [modelId]: "adaptive" | "manual" } }`
   *                        probed overrides for Anthropic extended thinking,
   *                        written by the catalog-refresh probe and the
   *                        runtime self-heal (see anthropic-thinking.ts)
   *  - arena             → legacy, removed by the 2026-04-23 migration
   */
  data: any;
  fetchedAt: Date;
  itemCount: number;
}

const ModelCatalogSnapshotSchema = new Schema(
  {
    // Note: we keep `arena` in the enum so legacy documents validate until
    // the seed migration deletes them.
    _id: {
      type: String,
      enum: ["gateway", "arena", "pricing", "curation", "capabilities"],
    },
    data: { type: Schema.Types.Mixed, default: [] },
    fetchedAt: { type: Date, required: true },
    itemCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

export const ModelCatalogSnapshot =
  (mongoose.models
    .ModelCatalogSnapshot as mongoose.Model<IModelCatalogSnapshot>) ||
  mongoose.model<IModelCatalogSnapshot>(
    "ModelCatalogSnapshot",
    ModelCatalogSnapshotSchema,
  );

/**
 * Database connection helper
 */
export async function connectDatabase(): Promise<void> {
  const mongoUri = process.env.DATABASE_URL;
  if (!mongoUri) {
    throw new Error("DATABASE_URL is not set");
  }

  registerMongooseConnectionListeners();

  if (mongoose.connection.readyState === 1) {
    mongooseLogger.info("MongoDB already connected", {
      readyState: mongoose.connection.readyState,
    });
    return;
  }

  if (mongoose.connection.readyState === 2) {
    mongooseLogger.info("MongoDB connection already in progress", {
      readyState: mongoose.connection.readyState,
    });
    await mongoose.connection.asPromise();
    return;
  }

  for (let attempt = 1; attempt <= DB_CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(mongoUri, mongooseConnectOptions);
      mongooseLogger.info("Connected to MongoDB", {
        attempt,
        readyState: mongoose.connection.readyState,
        maxPoolSize: mongooseConnectOptions.maxPoolSize,
        maxIdleTimeMS: mongooseConnectOptions.maxIdleTimeMS,
        serverSelectionTimeoutMS:
          mongooseConnectOptions.serverSelectionTimeoutMS,
        serverMonitoringMode: mongooseConnectOptions.serverMonitoringMode,
      });
      return;
    } catch (error) {
      const isLastAttempt = attempt >= DB_CONNECT_MAX_ATTEMPTS;
      if (isLastAttempt) {
        mongooseLogger.error("MongoDB connection error", {
          error,
          attempt,
          maxAttempts: DB_CONNECT_MAX_ATTEMPTS,
          readyState: mongoose.connection.readyState,
        });
        throw error;
      }
      // Exponential backoff, capped. Transient (e.g. ReplicaSetNoPrimary during
      // an Atlas failover) — retry rather than aborting the whole boot.
      const delayMs = Math.min(
        DB_CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        DB_CONNECT_MAX_DELAY_MS,
      );
      mongooseLogger.warn("MongoDB connection attempt failed, retrying", {
        error: error instanceof Error ? error.message : String(error),
        attempt,
        maxAttempts: DB_CONNECT_MAX_ATTEMPTS,
        retryInMs: delayMs,
        readyState: mongoose.connection.readyState,
      });
      await sleep(delayMs);
    }
  }
}
