/**
 * Phase 2B (`apps_metadata` domain) platform Postgres Drizzle schema.
 *
 * Covers the 10 Apps control-plane, git-derived index, lifecycle, worktree,
 * and binding tables:
 *   1. `app_projects`               (Mongo `app_projects`; ACLs, flattened publicShare, encrypted env[])
 *   2. `app_index`                  (Mongo `app_index`; disposable git-derived sidebar/search/scheduler index)
 *   3. `app_index_heads`            (Mongo `app_index_heads`; 1 row per workspace)
 *   4. `app_embeddings`             (Mongo `app_embeddings`; 1536-dim pgvector vectors)
 *   5. `app_lifecycle`              (Mongo `app_lifecycle`; verification, stale/paused schedules, archive receipt)
 *   6. `app_deploy_commit_statuses` (Mongo `app_deploy_commit_statuses`; GitHub commit status CAS)
 *   7. `app_worktrees`              (Mongo `app_worktrees`; per-(workspace, actor) sandbox branch & idle policy)
 *   8. `app_binding_state`          (Mongo `app_v2_binding_state`; parquet run history & public refresh claim)
 *   9. `app_binding_drafts`         (Mongo `app_binding_drafts`; dev-build parquet cache & failure backoff; app-pruned!)
 *  10. `app_binding_jobs`           (Mongo `app_binding_jobs`; async Inngest binding build status; app-pruned!)
 *
 * Conventions (Decisions #2 & #3, #12 Sub-Domain 2, #34 §2.1):
 *   - ObjectId PKs/FKs (incl. SHA-1 `derivedAppId` & string-stored 24-hex refs) use bijective UUIDv8.
 *   - `app_id` / `project_id` on derived/lifecycle/binding tables are soft UUID refs (no FK to `app_projects`),
 *     because most apps are git folders with no `app_projects` row.
 *   - All user columns are native `uuid` referencing `users(id)`:
 *       * `app_projects.{owner_id,created_by,public_share_created_by}`, `app_index.owner_id`,
 *         `app_lifecycle.{verified_by,restored_by}`, `app_binding_jobs.user_id` -> nullable `ON DELETE SET NULL`.
 *       * `app_worktrees` holds `actor_id text NOT NULL` (canonical UUID for persons OR system sentinel
 *         like `"publish"` / `"api-key"`) alongside `user_id uuid REFERENCES users(id) ON DELETE CASCADE`
 *         so user deletion cascades personal sandboxes while system actors work cleanly without UUID errors.
 *       * `app_binding_jobs.actor_id` stays `text NOT NULL` (stores raw caller actor ID verbatim —
 *         system sentinels or session user ID — while `user_id` holds the resolved PG user UUID FK).
 *       * `app_lifecycle.stale_notified_to` holds emails (`text[]`), not user IDs.
 *   - Encrypted fields (`app_projects.env[].valueEncrypted`, `app_projects.public_share_password_encrypted`)
 *     and bcrypt `public_share_password_hash` are copied verbatim and redacted in `shadow-compare`.
 *   - `app_binding_drafts` and `app_binding_jobs` are NEVER registered in blind `migration-pg-ttl-reaper`
 *     because app-side `pruneExpiredDrafts` / `pruneExpiredJobs` purge GCS/artifact parquet blobs first.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

export const APP_ACCESS_SCOPES = ["private", "workspace"] as const;
export type AppAccessScope = (typeof APP_ACCESS_SCOPES)[number];

export const APP_RESOURCE_ROLES = ["viewer", "editor"] as const;
export type AppResourceRole = (typeof APP_RESOURCE_ROLES)[number];

export const APP_DEPLOY_COMMIT_STATES = [
  "pending",
  "success",
  "failure",
  "superseded",
] as const;
export type AppDeployCommitStatePg = (typeof APP_DEPLOY_COMMIT_STATES)[number];

export const APP_BINDING_DRAFT_KINDS = ["build", "failure"] as const;
export type AppBindingDraftKind = (typeof APP_BINDING_DRAFT_KINDS)[number];

export const APP_BINDING_JOB_KINDS = ["materialize", "dev-build"] as const;
export type AppBindingJobKindPg = (typeof APP_BINDING_JOB_KINDS)[number];

export const APP_BINDING_JOB_STATUSES = [
  "queued",
  "running",
  "ready",
  "error",
] as const;
export type AppBindingJobStatusPg = (typeof APP_BINDING_JOB_STATUSES)[number];

export interface AppShareEntryJson {
  userId: string;
  role: AppResourceRole;
  addedAt: string;
  addedBy?: string;
}

export interface AppEnvVarJson {
  key: string;
  valueEncrypted: string;
  secret: boolean;
}

export interface AppLastDeployErrorJson {
  sha: string;
  stage: "bindings" | "build" | "publish";
  message: string;
  at: string;
}

export interface AppBindingRefreshErrorJson {
  sha: string;
  message: string;
  attempts: number;
  at: string;
}

export interface AppDeployProgressJson {
  sha: string;
  stage: "queued" | "bindings" | "build" | "publishing";
  startedAt: string;
  stageStartedAt: string;
  updatedAt: string;
  bindings?: { total: number; prepared: number; current?: string };
}

export interface AppIndexScheduleJson {
  binding: string;
  cron: string;
  timezone?: string;
}

export interface AppIndexBindingTablesJson {
  binding: string;
  tables: string[];
}

export interface AppIndexAssetRefJson {
  file: string;
  oid: string;
}

export interface AppBindingRunJson {
  at: string;
  status: "ready" | "error";
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
  artifactKey?: string | null;
  byteSize?: number | null;
  compression?: string | null;
}

export interface AppBindingJobRequestJson {
  source?: string;
  dbtEnvironment?: string;
  dbtDefer?: boolean;
  refresh?: boolean;
}

export interface AppBindingJobResultJson {
  artifactKey: string;
  build: string;
  rowCount?: number;
  byteSize?: number;
  materializedAt?: string;
}

export interface AppBindingJobProgressJson {
  phase: string;
  rowsWritten?: number;
  bytes?: number;
  at: string;
}

export const appProjects = pgTable(
  "app_projects",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug"),
    path: text("path"),
    description: text("description"),
    access: text("access").$type<AppAccessScope>().notNull().default("private"),
    workspaceRole: text("workspace_role").$type<AppResourceRole>(),
    sharedWith: jsonb("shared_with").$type<AppShareEntryJson[]>(),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Nullable UUIDv7 FK: NULL when materialized by system actor (Mongo `""` / `"system"`). */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    defaultBranch: text("default_branch").notNull().default("main"),
    cloudRepoOwner: text("cloud_repo_owner"),
    cloudRepoName: text("cloud_repo_name"),
    publishedSha: text("published_sha"),
    chatEnabled: boolean("chat_enabled"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastDeployError: jsonb("last_deploy_error").$type<AppLastDeployErrorJson>(),
    bindingRefreshErrors: jsonb("binding_refresh_errors").$type<
      Record<string, AppBindingRefreshErrorJson>
    >(),
    deployProgress: jsonb("deploy_progress").$type<AppDeployProgressJson>(),
    // Flattened publicShare (password hash & encrypted copy MUST be redacted in shadow-compare)
    publicShareEnabled: boolean("public_share_enabled")
      .notNull()
      .default(false),
    publicShareToken: text("public_share_token"),
    publicSharePasswordHash: text("public_share_password_hash"),
    publicSharePasswordEncrypted: text("public_share_password_encrypted"),
    publicShareCreatedAt: timestamp("public_share_created_at", {
      withTimezone: true,
    }),
    publicShareCreatedBy: uuid("public_share_created_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    publicShareAllowLiveQueries: boolean("public_share_allow_live_queries")
      .notNull()
      .default(false),
    /** Encrypted per-app env vars (`[{ key, valueEncrypted, secret }]`). Redact in shadow-compare! */
    env: jsonb("env").$type<AppEnvVarJson[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_projects_access_check",
      sql`${table.access} IN ('private', 'workspace')`,
    ),
    check(
      "app_projects_workspace_role_check",
      sql`${table.workspaceRole} IS NULL OR ${table.workspaceRole} IN ('viewer', 'editor')`,
    ),
    check(
      "app_projects_shared_with_array_check",
      sql`${table.sharedWith} IS NULL OR jsonb_typeof(${table.sharedWith}) = 'array'`,
    ),
    check(
      "app_projects_env_array_check",
      sql`${table.env} IS NULL OR jsonb_typeof(${table.env}) = 'array'`,
    ),
    index("idx_app_projects_ws_updated").on(
      table.workspaceId,
      sql`${table.updatedAt} DESC`,
    ),
    index("idx_app_projects_owner")
      .on(table.ownerId)
      .where(sql`${table.ownerId} IS NOT NULL`),
    index("idx_app_projects_ws_slug")
      .on(table.workspaceId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
    index("idx_app_projects_shared_with_gin")
      .using("gin", sql`${table.sharedWith} jsonb_path_ops`)
      .where(sql`${table.sharedWith} IS NOT NULL`),
    uniqueIndex("idx_app_projects_share_tok")
      .on(table.publicShareToken)
      .where(sql`${table.publicShareToken} IS NOT NULL`),
    uniqueIndex("idx_app_projects_ws_path")
      .on(table.workspaceId, table.path)
      .where(sql`${table.path} IS NOT NULL`),
    index("idx_app_projects_published")
      .on(table.workspaceId)
      .where(sql`${table.publishedSha} IS NOT NULL`),
  ],
);

export const appIndex = pgTable(
  "app_index",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref; globally unique). */
    appId: uuid("app_id").notNull(),
    path: text("path").notNull(),
    slug: text("slug").notNull(),
    scope: text("scope").$type<AppAccessScope>().notNull(),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    treeOid: text("tree_oid").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    hasManifestId: boolean("has_manifest_id").notNull().default(false),
    /** Bijective UUIDv8 of original appId when a copied manifest collided. */
    duplicateOf: uuid("duplicate_of"),
    schedules: jsonb("schedules")
      .$type<AppIndexScheduleJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tables: text("tables").array(),
    bindingTables: jsonb("binding_tables").$type<AppIndexBindingTablesJson[]>(),
    bindings: text("bindings").array(),
    authorEmail: text("author_email"),
    firstCommitAt: timestamp("first_commit_at", { withTimezone: true }),
    thumbnail: jsonb("thumbnail").$type<AppIndexAssetRefJson>(),
    icon: jsonb("icon").$type<AppIndexAssetRefJson>(),
    indexedSha: text("indexed_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_index_scope_check",
      sql`${table.scope} IN ('workspace', 'private')`,
    ),
    check(
      "app_index_schedules_array_check",
      sql`jsonb_typeof(${table.schedules}) = 'array'`,
    ),
    check(
      "app_index_binding_tables_array_check",
      sql`${table.bindingTables} IS NULL OR jsonb_typeof(${table.bindingTables}) = 'array'`,
    ),
    uniqueIndex("uq_app_index_app_id").on(table.appId),
    uniqueIndex("uq_app_index_ws_path").on(table.workspaceId, table.path),
    index("idx_app_index_ws_app").on(table.workspaceId, table.appId),
    index("idx_app_index_ws_slug").on(table.workspaceId, table.slug),
    index("idx_app_index_slug_scope").on(table.slug, table.scope),
  ],
);

export const appIndexHeads = pgTable(
  "app_index_heads",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    schemaVersion: integer("schema_version"),
    folders: text("folders")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [uniqueIndex("uq_app_index_heads_ws").on(table.workspaceId)],
);

export const appEmbeddings = pgTable(
  "app_embeddings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref). */
    appId: uuid("app_id").notNull(),
    path: text("path").notNull(),
    treeOid: text("tree_oid").notNull(),
    docHash: text("doc_hash").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    vector: vector("vector", { dimensions: 1536 }).notNull(),
    terms: text("terms").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("uq_app_embeddings_ws_app").on(table.workspaceId, table.appId),
  ],
);

export const appLifecycle = pgTable(
  "app_lifecycle",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref). */
    appId: uuid("app_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    staleSince: timestamp("stale_since", { withTimezone: true }),
    /** Recipient email addresses (NOT user IDs). */
    staleNotifiedTo: text("stale_notified_to").array(),
    schedulesPausedAt: timestamp("schedules_paused_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedFrom: text("archived_from"),
    archivedTo: text("archived_to"),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    restoredBy: uuid("restored_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("uq_app_lifecycle_ws_app").on(table.workspaceId, table.appId),
    index("idx_app_lifecycle_paused")
      .on(table.schedulesPausedAt)
      .where(sql`${table.schedulesPausedAt} IS NOT NULL`),
  ],
);

export const appDeployCommitStatuses = pgTable(
  "app_deploy_commit_statuses",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref). */
    appId: uuid("app_id").notNull(),
    sha: text("sha").notNull(),
    state: text("state").$type<AppDeployCommitStatePg>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_deploy_commit_statuses_state_check",
      sql`${table.state} IN ('pending', 'success', 'failure', 'superseded')`,
    ),
    uniqueIndex("uq_app_deploy_commit_statuses_ws_app_sha").on(
      table.workspaceId,
      table.appId,
      table.sha,
    ),
    index("idx_app_deploy_commit_statuses_ws_app_state").on(
      table.workspaceId,
      table.appId,
      table.state,
    ),
  ],
);

export const appWorktrees = pgTable(
  "app_worktrees",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** @deprecated soft ref. */
    projectId: uuid("project_id"),
    /**
     * Canonical sandbox actor key: lowercase user UUID for real people, or a
     * system actor sentinel (`"publish"`, `"api-key"`).
     */
    actorId: text("actor_id").notNull(),
    /**
     * Nullable UUIDv7 FK (`ON DELETE CASCADE`): populated for real users so
     * user deletion removes their personal sandbox row; NULL for system actors.
     */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    branch: text("branch").notNull().default("main"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    activeUntil: timestamp("active_until", { withTimezone: true }),
    idlePausedAt: timestamp("idle_paused_at", { withTimezone: true }).array(),
    idlePauseHoldUntil: timestamp("idle_pause_hold_until", {
      withTimezone: true,
    }),
    idlePauseHoldSetAt: timestamp("idle_pause_hold_set_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_worktrees_user_actor_check",
      sql`${table.userId} IS NULL OR ${table.actorId} = ${table.userId}::text`,
    ),
    uniqueIndex("uq_app_worktrees_ws_actor").on(
      table.workspaceId,
      table.actorId,
    ),
    index("idx_app_worktrees_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_app_worktrees_updated").on(sql`${table.updatedAt} DESC`),
  ],
);

export const appBindingState = pgTable(
  "app_binding_state",
  {
    id: uuid("id").primaryKey(),
    /** Bijective UUIDv8 of appId (soft ref). */
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    lastMaterializedAt: timestamp("last_materialized_at", {
      withTimezone: true,
    }),
    lastRowCount: bigint("last_row_count", { mode: "number" }),
    publicRefreshAt: timestamp("public_refresh_at", { withTimezone: true }),
    /** Newest-first, capped to 20 entries in SQL/app. */
    history: jsonb("history").$type<AppBindingRunJson[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_binding_state_history_array_check",
      sql`${table.history} IS NULL OR jsonb_typeof(${table.history}) = 'array'`,
    ),
    uniqueIndex("uq_app_binding_state_project_name").on(
      table.projectId,
      table.name,
    ),
  ],
);

export const appBindingDrafts = pgTable(
  "app_binding_drafts",
  {
    id: uuid("id").primaryKey(),
    /** Bijective UUIDv8 of appId (soft ref). */
    projectId: uuid("project_id").notNull(),
    hash: text("hash").notNull(),
    kind: text("kind").$type<AppBindingDraftKind>().notNull(),
    name: text("name").notNull(),
    /** Artifact store parquet key (`apps/drafts/...`). Cleaned up by app-side pruner! */
    key: text("key"),
    builtAt: timestamp("built_at", { withTimezone: true }),
    rowCount: bigint("row_count", { mode: "number" }),
    byteSize: bigint("byte_size", { mode: "number" }),
    failures: integer("failures"),
    until: timestamp("until", { withTimezone: true }),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_binding_drafts_kind_check",
      sql`${table.kind} IN ('build', 'failure')`,
    ),
    index("idx_app_binding_drafts_lookup").on(
      table.projectId,
      table.hash,
      table.kind,
      sql`${table.expiresAt} DESC`,
    ),
    index("idx_app_binding_drafts_expires").on(
      table.projectId,
      table.expiresAt,
    ),
  ],
);

export const appBindingJobs = pgTable(
  "app_binding_jobs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of appId (soft ref). */
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<AppBindingJobKindPg>(),
    /** Stays `text NOT NULL`: holds system sentinels (`publish`, `api-key`, `""`) alongside user UUIDs. */
    actorId: text("actor_id").notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    canWrite: boolean("can_write").notNull().default(false),
    unregistered: boolean("unregistered"),
    request: jsonb("request")
      .$type<AppBindingJobRequestJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status")
      .$type<AppBindingJobStatusPg>()
      .notNull()
      .default("queued"),
    result: jsonb("result").$type<AppBindingJobResultJson>(),
    error: text("error"),
    errorStatus: integer("error_status"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    progress: jsonb("progress").$type<AppBindingJobProgressJson>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "app_binding_jobs_kind_check",
      sql`${table.kind} IS NULL OR ${table.kind} IN ('materialize', 'dev-build')`,
    ),
    check(
      "app_binding_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'ready', 'error')`,
    ),
    index("idx_app_binding_jobs_proj_exp").on(table.projectId, table.expiresAt),
    index("idx_app_binding_jobs_status").on(table.status, table.heartbeatAt),
  ],
);

export type AppProjectRow = typeof appProjects.$inferSelect;
export type NewAppProjectRow = typeof appProjects.$inferInsert;
export type AppIndexRowPg = typeof appIndex.$inferSelect;
export type NewAppIndexRowPg = typeof appIndex.$inferInsert;
export type AppIndexHeadRow = typeof appIndexHeads.$inferSelect;
export type NewAppIndexHeadRow = typeof appIndexHeads.$inferInsert;
export type AppEmbeddingRow = typeof appEmbeddings.$inferSelect;
export type NewAppEmbeddingRow = typeof appEmbeddings.$inferInsert;
export type AppLifecycleRow = typeof appLifecycle.$inferSelect;
export type NewAppLifecycleRow = typeof appLifecycle.$inferInsert;
export type AppDeployCommitStatusRow =
  typeof appDeployCommitStatuses.$inferSelect;
export type NewAppDeployCommitStatusRow =
  typeof appDeployCommitStatuses.$inferInsert;
export type AppWorktreeRow = typeof appWorktrees.$inferSelect;
export type NewAppWorktreeRow = typeof appWorktrees.$inferInsert;
export type AppBindingStateRowPg = typeof appBindingState.$inferSelect;
export type NewAppBindingStateRowPg = typeof appBindingState.$inferInsert;
export type AppBindingDraftRow = typeof appBindingDrafts.$inferSelect;
export type NewAppBindingDraftRow = typeof appBindingDrafts.$inferInsert;
export type AppBindingJobRow = typeof appBindingJobs.$inferSelect;
export type NewAppBindingJobRow = typeof appBindingJobs.$inferInsert;
