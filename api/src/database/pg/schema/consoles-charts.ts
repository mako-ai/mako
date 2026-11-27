/**
 * Phase 2A-2 (`consoles_charts` domain) platform Postgres Drizzle schema.
 *
 * Covers 7 workspace-scoped tables:
 *   - `console_folders`      (Mongo `consolefolders`, self-FK deferrable)
 *   - `saved_consoles`       (Mongo `savedconsoles`: charts, pgvector 1536 HNSW, tsvector FTS, trigram, schedules)
 *   - `entity_versions`      (Mongo `entity_versions`: immutable console snapshots; legacy `"dashboard"` rows skipped)
 *   - `notebook_folders`     (Mongo `notebookfolders`, self-FK deferrable)
 *   - `notebook_indexes`     (Mongo `notebookindexes`: metadata/ACL sidecar for GCS/git .deepnote files)
 *   - `favourites`           (Mongo `favourites`: self-FK deferrable per-user bookmark tree)
 *   - `scheduled_query_runs` (Mongo `scheduled_query_runs`: 90d sparse TTL on `completed_at`)
 *
 * Conventions (Decisions #1, #2, #3):
 *   - All ObjectId PKs/FKs are bijective RFC 9562 UUIDv8 (`objectIdToUuid` / `toWireId`).
 *   - All user columns are native `uuid` referencing `users(id)` (UUIDv7):
 *       * Audit/creator/owner columns are nullable `ON DELETE SET NULL` so legacy `"system"`/deleted
 *         actors backfill cleanly and workspace consoles/notebooks survive user deletion.
 *       * `favourites.user_id` is `NOT NULL ON DELETE CASCADE` (strictly personal bookmarks).
 *   - `saved_consoles.connection_id` is nullable `uuid` in `0005`; the hard FK to
 *     `database_connections(id) ON DELETE SET NULL` is deferred to
 *     `post-backfill/0005a_consoles_connection_fk.sql`.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const CONSOLE_ACCESS_LEVELS = ["private", "workspace"] as const;
export type ConsoleAccessLevelPg = (typeof CONSOLE_ACCESS_LEVELS)[number];

export const CONSOLE_LANGUAGES = ["sql", "javascript", "mongodb"] as const;
export type ConsoleLanguagePg = (typeof CONSOLE_LANGUAGES)[number];

export const CONSOLE_RESULTS_VIEW_MODES = ["table", "json", "chart"] as const;
export type ConsoleResultsViewModePg =
  (typeof CONSOLE_RESULTS_VIEW_MODES)[number];

export const CONSOLE_DESCRIPTION_SOURCES = ["authored", "generated"] as const;
export type ConsoleDescriptionSourcePg =
  (typeof CONSOLE_DESCRIPTION_SOURCES)[number];

export const RESOURCE_SHARE_ROLES = ["viewer", "editor"] as const;
export type ResourceShareRolePg = (typeof RESOURCE_SHARE_ROLES)[number];

export const SCHEDULED_RUN_LAST_STATUSES = ["success", "error"] as const;
export type ScheduledRunLastStatusPg =
  (typeof SCHEDULED_RUN_LAST_STATUSES)[number];

export const DRAFT_ORIGINS = ["user", "agent"] as const;
export type DraftOriginPg = (typeof DRAFT_ORIGINS)[number];

export const EXTERNAL_SOURCES = ["api", "mcp"] as const;
export type ExternalSourcePg = (typeof EXTERNAL_SOURCES)[number];

export const FAVOURITE_TYPES = ["folder", "item"] as const;
export type FavouriteTypePg = (typeof FAVOURITE_TYPES)[number];

export const FAVOURITE_KINDS_PG = ["app", "console", "notebook"] as const;
export type FavouriteKindPg = (typeof FAVOURITE_KINDS_PG)[number];

export const SCHEDULED_QUERY_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "error",
] as const;
export type ScheduledQueryRunStatusPg =
  (typeof SCHEDULED_QUERY_RUN_STATUSES)[number];

export const SCHEDULED_QUERY_TRIGGER_TYPES = ["schedule", "manual"] as const;
export type ScheduledQueryTriggerTypePg =
  (typeof SCHEDULED_QUERY_TRIGGER_TYPES)[number];

/** Shared collaborator JSONB entry (dates serialized as ISO-8601 strings). */
export interface ResourceShareEntryJson {
  userId: string;
  role: ResourceShareRolePg;
  addedAt: string;
  addedBy?: string;
}

export interface ConsoleMongoOptionsJson {
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
}

export interface ConsoleLastRunJson {
  at: string;
  status: "running" | "success" | "error" | "cancelled";
  rowCount?: number;
  durationMs: number;
  error?: string;
  sampleRows?: unknown[];
  fields?: unknown;
  runBy: string;
  source: string;
  startedAt?: string;
  executionId?: string;
}

// ── 1. console_folders ──────────────────────────────────────────────────────

export const consoleFolders = pgTable(
  "console_folders",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => consoleFolders.id,
      {
        onDelete: "cascade",
      },
    ),
    isPrivate: boolean("is_private").notNull().default(false),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    access: text("access")
      .$type<ConsoleAccessLevelPg>()
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "console_folders_access_check",
      sql`${table.access} IN ('private', 'workspace')`,
    ),
    index("idx_console_folders_ws_parent").on(
      table.workspaceId,
      table.parentId,
    ),
    index("idx_console_folders_ws_owner").on(
      table.workspaceId,
      table.ownerId,
      table.isPrivate,
    ),
    index("idx_console_folders_ws_access").on(table.workspaceId, table.access),
  ],
);

// ── 2. saved_consoles ───────────────────────────────────────────────────────

export const savedConsoles = pgTable(
  "saved_consoles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => consoleFolders.id, {
      onDelete: "set null",
    }),
    /** Soft ref in 0005; hard FK attached post-backfill via `0005a_consoles_connection_fk.sql`. */
    connectionId: uuid("connection_id"),
    databaseName: text("database_name"),
    databaseId: text("database_id"),
    name: text("name").notNull(),
    description: text("description"),
    descriptionEmbedding: vector("description_embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    descriptionGeneratedAt: timestamp("description_generated_at", {
      withTimezone: true,
    }),
    path: text("path"),
    sourceBlobSha: text("source_blob_sha"),
    descriptionSourceSha: text("description_source_sha"),
    descriptionSource:
      text("description_source").$type<ConsoleDescriptionSourcePg>(),
    code: text("code").notNull(),
    language: text("language").$type<ConsoleLanguagePg>().notNull(),
    chartSpec: jsonb("chart_spec").$type<Record<string, unknown>>(),
    resultsViewMode:
      text("results_view_mode").$type<ConsoleResultsViewModePg>(),
    mongoOptions: jsonb("mongo_options").$type<ConsoleMongoOptionsJson>(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isPrivate: boolean("is_private").notNull().default(false),
    isSaved: boolean("is_saved").notNull().default(false),
    access: text("access")
      .$type<ConsoleAccessLevelPg>()
      .notNull()
      .default("private"),
    workspaceRole: text("workspace_role")
      .$type<ResourceShareRolePg>()
      .notNull()
      .default("viewer"),
    sharedWith: jsonb("shared_with")
      .$type<ResourceShareEntryJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Flattened schedule & scheduledRun
    scheduleCron: text("schedule_cron"),
    scheduleTimezone: text("schedule_timezone"),
    scheduledRunNextAt: timestamp("scheduled_run_next_at", {
      withTimezone: true,
    }),
    scheduledRunLastAt: timestamp("scheduled_run_last_at", {
      withTimezone: true,
    }),
    scheduledRunLastStatus: text(
      "scheduled_run_last_status",
    ).$type<ScheduledRunLastStatusPg>(),
    scheduledRunLastError: text("scheduled_run_last_error"),
    scheduledRunLastDurationMs: integer("scheduled_run_last_duration_ms"),
    scheduledRunLastRowsAffected: bigint("scheduled_run_last_rows_affected", {
      mode: "number",
    }),
    scheduledRunLastRowCount: bigint("scheduled_run_last_row_count", {
      mode: "number",
    }),
    scheduledRunCount: integer("scheduled_run_count").notNull().default(0),
    scheduledRunConsecutiveFailures: integer(
      "scheduled_run_consecutive_failures",
    )
      .notNull()
      .default(0),
    scheduledRunPermanentFailures: integer("scheduled_run_permanent_failures"),
    scheduledRunPausedAt: timestamp("scheduled_run_paused_at", {
      withTimezone: true,
    }),
    scheduledRunPausedReason: text("scheduled_run_paused_reason"),

    // Concurrency, realtime diff & execution telemetry
    version: integer("version").notNull().default(1),
    draftRevision: integer("draft_revision").notNull().default(1),
    lastDraftOrigin: text("last_draft_origin").$type<DraftOriginPg>(),
    lastRun: jsonb("last_run").$type<ConsoleLastRunJson>(),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true }),
    executionCount: integer("execution_count").notNull().default(0),
    lastExternalUsedAt: timestamp("last_external_used_at", {
      withTimezone: true,
    }),
    externalUseCount: integer("external_use_count").notNull().default(0),
    lastExternalSource: text("last_external_source").$type<ExternalSourcePg>(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('english', coalesce(${savedConsoles.name}, '')), 'A') || setweight(to_tsvector('english', coalesce(${savedConsoles.description}, '')), 'B')`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "saved_consoles_description_source_check",
      sql`${table.descriptionSource} IS NULL OR ${table.descriptionSource} IN ('authored', 'generated')`,
    ),
    check(
      "saved_consoles_language_check",
      sql`${table.language} IN ('sql', 'javascript', 'mongodb')`,
    ),
    check(
      "saved_consoles_results_view_mode_check",
      sql`${table.resultsViewMode} IS NULL OR ${table.resultsViewMode} IN ('table', 'json', 'chart')`,
    ),
    check(
      "saved_consoles_access_check",
      sql`${table.access} IN ('private', 'workspace')`,
    ),
    check(
      "saved_consoles_workspace_role_check",
      sql`${table.workspaceRole} IN ('viewer', 'editor')`,
    ),
    check(
      "saved_consoles_shared_with_array_check",
      sql`jsonb_typeof(${table.sharedWith}) = 'array'`,
    ),
    check(
      "saved_consoles_scheduled_run_last_status_check",
      sql`${table.scheduledRunLastStatus} IS NULL OR ${table.scheduledRunLastStatus} IN ('success', 'error')`,
    ),
    check(
      "saved_consoles_last_draft_origin_check",
      sql`${table.lastDraftOrigin} IS NULL OR ${table.lastDraftOrigin} IN ('user', 'agent')`,
    ),
    check(
      "saved_consoles_last_external_source_check",
      sql`${table.lastExternalSource} IS NULL OR ${table.lastExternalSource} IN ('api', 'mcp')`,
    ),
    index("idx_saved_consoles_ws_folder").on(table.workspaceId, table.folderId),
    index("idx_saved_consoles_ws_path")
      .on(table.workspaceId, table.path)
      .where(sql`${table.path} IS NOT NULL`),
    index("idx_saved_consoles_shared_with_gin").using(
      "gin",
      sql`${table.sharedWith} jsonb_path_ops`,
    ),
    index("idx_saved_consoles_ws_saved")
      .on(table.workspaceId, table.isSaved)
      .where(sql`${table.isDeleted} = false`),
    index("idx_saved_consoles_ws_access_owner").on(
      table.workspaceId,
      table.access,
      table.ownerId,
    ),
    index("idx_saved_consoles_connection")
      .on(table.connectionId)
      .where(sql`${table.connectionId} IS NOT NULL`),
    index("idx_saved_consoles_ws_sched_next")
      .on(table.workspaceId, table.scheduledRunNextAt)
      .where(sql`${table.scheduledRunNextAt} IS NOT NULL`),
    index("idx_saved_consoles_sched_due")
      .on(table.scheduledRunNextAt)
      .where(
        sql`${table.scheduleCron} IS NOT NULL AND ${table.scheduleCron} <> '' AND ${table.scheduledRunNextAt} IS NOT NULL AND ${table.isDeleted} = false`,
      ),
    index("idx_saved_consoles_ws_ext_used")
      .on(table.workspaceId, table.lastExternalUsedAt)
      .where(sql`${table.lastExternalUsedAt} IS NOT NULL`),
    index("idx_saved_consoles_embedding_hnsw")
      .using("hnsw", table.descriptionEmbedding.op("vector_cosine_ops"))
      .where(
        sql`${table.descriptionEmbedding} IS NOT NULL AND ${table.isDeleted} = false`,
      ),
    index("idx_saved_consoles_search_tsv").using("gin", table.searchTsv),
    index("idx_saved_consoles_name_trgm")
      .using("gin", sql`${table.name} gin_trgm_ops`)
      .where(sql`${table.isDeleted} = false`),
  ],
);

// ── 3. entity_versions ──────────────────────────────────────────────────────

export const entityVersions = pgTable(
  "entity_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").$type<"console">().notNull(),
    /** Soft UUID ref -> `saved_consoles.id` (history survives hard-deleted consoles). */
    entityId: uuid("entity_id").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    savedBy: uuid("saved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    savedByName: text("saved_by_name").notNull(),
    comment: text("comment").notNull().default(""),
    restoredFrom: integer("restored_from"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "entity_versions_entity_type_check",
      sql`${table.entityType} = 'console'`,
    ),
    check("entity_versions_version_check", sql`${table.version} >= 1`),
    unique("entity_versions_entity_type_ver_unique").on(
      table.entityId,
      table.entityType,
      table.version,
    ),
    index("idx_entity_versions_entity_ver").on(
      table.entityId,
      sql`${table.version} DESC`,
    ),
    index("idx_entity_versions_ws_type_at").on(
      table.workspaceId,
      table.entityType,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

// ── 4. notebook_folders ─────────────────────────────────────────────────────

export const notebookFolders = pgTable(
  "notebook_folders",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => notebookFolders.id,
      {
        onDelete: "cascade",
      },
    ),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    access: text("access")
      .$type<ConsoleAccessLevelPg>()
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "notebook_folders_access_check",
      sql`${table.access} IN ('private', 'workspace')`,
    ),
    index("idx_notebook_folders_ws_parent").on(
      table.workspaceId,
      table.parentId,
    ),
    index("idx_notebook_folders_ws_access").on(table.workspaceId, table.access),
  ],
);

// ── 5. notebook_indexes ─────────────────────────────────────────────────────

export const notebookIndexes = pgTable(
  "notebook_indexes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    notebookId: text("notebook_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    folderId: uuid("folder_id").references(() => notebookFolders.id, {
      onDelete: "set null",
    }),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    access: text("access")
      .$type<ConsoleAccessLevelPg>()
      .notNull()
      .default("private"),
    path: text("path"),
    checkpointBlobSha: text("checkpoint_blob_sha"),
    workspaceRole: text("workspace_role")
      .$type<ResourceShareRolePg>()
      .notNull()
      .default("viewer"),
    sharedWith: jsonb("shared_with")
      .$type<ResourceShareEntryJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "notebook_indexes_access_check",
      sql`${table.access} IN ('private', 'workspace')`,
    ),
    check(
      "notebook_indexes_workspace_role_check",
      sql`${table.workspaceRole} IN ('viewer', 'editor')`,
    ),
    check(
      "notebook_indexes_shared_with_array_check",
      sql`jsonb_typeof(${table.sharedWith}) = 'array'`,
    ),
    unique("notebook_indexes_ws_nb_unique").on(
      table.workspaceId,
      table.notebookId,
    ),
    index("idx_notebook_indexes_ws_folder").on(
      table.workspaceId,
      table.folderId,
    ),
    index("idx_notebook_indexes_ws_access_owner").on(
      table.workspaceId,
      table.access,
      table.ownerId,
    ),
    index("idx_notebook_indexes_shared_with_gin").using(
      "gin",
      sql`${table.sharedWith} jsonb_path_ops`,
    ),
  ],
);

// ── 6. favourites ───────────────────────────────────────────────────────────

export const favourites = pgTable(
  "favourites",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => favourites.id, {
      onDelete: "cascade",
    }),
    type: text("type").$type<FavouriteTypePg>().notNull(),
    title: text("title"),
    kind: text("kind").$type<FavouriteKindPg>(),
    refId: text("ref_id"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check("favourites_type_check", sql`${table.type} IN ('folder', 'item')`),
    check(
      "favourites_kind_check",
      sql`${table.kind} IS NULL OR ${table.kind} IN ('app', 'console', 'notebook')`,
    ),
    check(
      "favourites_type_fields_check",
      sql`(${table.type} = 'folder' AND ${table.kind} IS NULL AND ${table.refId} IS NULL) OR (${table.type} = 'item' AND ${table.kind} IS NOT NULL AND ${table.refId} IS NOT NULL)`,
    ),
    index("idx_favourites_tree_order").on(
      table.workspaceId,
      table.userId,
      table.parentId,
      table.position,
      table.id,
    ),
    uniqueIndex("idx_favourites_item_unique")
      .on(table.workspaceId, table.userId, table.kind, table.refId)
      .where(sql`${table.type} = 'item'`),
  ],
);

// ── 7. scheduled_query_runs ─────────────────────────────────────────────────

export const scheduledQueryRuns = pgTable(
  "scheduled_query_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Soft ref (no FK cascade): preserves run history across workspace repo
    // disconnect/reconnect when saved_consoles rows are purged and re-created.
    consoleId: uuid("console_id").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").$type<ScheduledQueryRunStatusPg>().notNull(),
    triggerType: text("trigger_type")
      .$type<ScheduledQueryTriggerTypePg>()
      .notNull(),
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    durationMs: integer("duration_ms"),
    rowsAffected: bigint("rows_affected", { mode: "number" }),
    rowCount: bigint("row_count", { mode: "number" }),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    inngestRunId: text("inngest_run_id"),
  },
  table => [
    check(
      "scheduled_query_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'success', 'error')`,
    ),
    check(
      "scheduled_query_runs_trigger_type_check",
      sql`${table.triggerType} IN ('schedule', 'manual')`,
    ),
    index("idx_scheduled_query_runs_ws_console_triggered").on(
      table.workspaceId,
      table.consoleId,
      sql`${table.triggeredAt} DESC`,
    ),
    index("idx_scheduled_query_runs_completed_at")
      .on(table.completedAt)
      .where(sql`${table.completedAt} IS NOT NULL`),
  ],
);

export type ConsoleFolderRow = typeof consoleFolders.$inferSelect;
export type NewConsoleFolderRow = typeof consoleFolders.$inferInsert;

export type SavedConsoleRow = typeof savedConsoles.$inferSelect;
export type NewSavedConsoleRow = typeof savedConsoles.$inferInsert;

export type EntityVersionRow = typeof entityVersions.$inferSelect;
export type NewEntityVersionRow = typeof entityVersions.$inferInsert;

export type NotebookFolderRow = typeof notebookFolders.$inferSelect;
export type NewNotebookFolderRow = typeof notebookFolders.$inferInsert;

export type NotebookIndexRow = typeof notebookIndexes.$inferSelect;
export type NewNotebookIndexRow = typeof notebookIndexes.$inferInsert;

export type FavouriteRow = typeof favourites.$inferSelect;
export type NewFavouriteRow = typeof favourites.$inferInsert;

export type ScheduledQueryRunRow = typeof scheduledQueryRuns.$inferSelect;
export type NewScheduledQueryRunRow = typeof scheduledQueryRuns.$inferInsert;
