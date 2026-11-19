import mongoose, { Schema, Document, Types } from "mongoose";
import {
  type ResourceShareRole,
  type IResourceShareEntry,
  ResourceShareEntrySchema,
} from "./shared";

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

export const ConsoleFolder = mongoose.model<IConsoleFolder>(
  "ConsoleFolder",
  ConsoleFolderSchema,
);

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
  /**
   * Git is the source of truth for saved consoles (apps.md §16); this row is
   * the derived index. `path` is the file in the workspace repo,
   * `sourceBlobSha` the git blob id of that file as last projected — the
   * push-driven sync skips rows whose blob has not moved.
   */
  path?: string;
  sourceBlobSha?: string;
  /**
   * The blob the current description/embedding was derived from. Generation
   * runs only while this differs from `sourceBlobSha` (§16.4).
   */
  descriptionSourceSha?: string;
  /** "authored" = written in the file's front-matter; "generated" = LLM. */
  descriptionSource?: "authored" | "generated";
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
    /**
     * Consecutive failures with one permanent cause (a write refusal):
     * `lastError` names the cause. Reaching the pause threshold pauses the
     * schedule (services/consoles/schedule-pause.ts).
     */
    permanentFailures?: number;
    /** Set when Mako paused the schedule; `nextAt` is unset meanwhile. */
    pausedAt?: Date;
    /** Why the schedule is paused and how to fix it. */
    pausedReason?: string;
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
  /**
   * Last time this console was used via an external surface (REST API key
   * execute, or MCP read/run). Distinct from lastExecutedAt, which also
   * includes in-app UI / agent runs.
   */
  lastExternalUsedAt?: Date;
  /** Number of external executions (API key / MCP run_console). Reads do not increment. */
  externalUseCount: number;
  /** Which external surface last touched this console. */
  lastExternalSource?: "api" | "mcp";
}

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
    path: { type: String },
    sourceBlobSha: { type: String },
    descriptionSourceSha: { type: String },
    descriptionSource: { type: String, enum: ["authored", "generated"] },
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
      permanentFailures: {
        type: Number,
      },
      pausedAt: {
        type: Date,
      },
      pausedReason: {
        type: String,
      },
    },
    lastExecutedAt: {
      type: Date,
    },
    executionCount: {
      type: Number,
      default: 0,
    },
    lastExternalUsedAt: {
      type: Date,
    },
    externalUseCount: {
      type: Number,
      default: 0,
    },
    lastExternalSource: {
      type: String,
      enum: ["api", "mcp"],
      required: false,
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
// Repo path → row, for the push-driven index sync (apps.md §16.3).
SavedConsoleSchema.index({ workspaceId: 1, path: 1 }, { sparse: true });
SavedConsoleSchema.index({ workspaceId: 1, "sharedWith.userId": 1 });
SavedConsoleSchema.index({ workspaceId: 1, createdBy: 1, isPrivate: 1 });
SavedConsoleSchema.index({ workspaceId: 1, isSaved: 1 }); // For filtering saved vs draft consoles
SavedConsoleSchema.index({ connectionId: 1 }, { sparse: true }); // Sparse index since connectionId is optional
SavedConsoleSchema.index({ workspaceId: 1, access: 1, owner_id: 1 }); // Console access model queries
SavedConsoleSchema.index(
  { workspaceId: 1, "scheduledRun.nextAt": 1 },
  { sparse: true },
);
// The every-minute scheduler scan (services/scheduled-run-claim.ts) filters
// `scheduledRun.nextAt <= now` across ALL workspaces, so the workspace-led
// index above cannot serve it.
SavedConsoleSchema.index({ "scheduledRun.nextAt": 1 }, { sparse: true });
SavedConsoleSchema.index(
  { workspaceId: 1, lastExternalUsedAt: 1 },
  { sparse: true, name: "savedconsoles_workspace_last_external_used" },
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

export const SavedConsole = mongoose.model<ISavedConsole>(
  "SavedConsole",
  SavedConsoleSchema,
);
/**
 * EntityVersion — immutable append-only version snapshots for consoles.
 * (The collection also still holds rows from the removed dashboards feature,
 * `entityType: "dashboard"`; nothing reads them.)
 * Every explicit save creates a new version record; history is never rewritten.
 */
export type VersionableEntityType = "console";

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
      enum: ["console"],
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
