/**
 * `dbt` domain platform Postgres Drizzle schema (`0013_dbt_tables.sql`).
 *
 *   - `dbt_projects`        workspace dbt Core projects (environments as JSONB)
 *   - `dbt_env_preferences` per-user development environment choice
 *   - `dbt_jobs`            command lists + cron schedules (scheduler claim)
 *   - `dbt_runs`            one row per execution, WITHOUT log lines
 *   - `dbt_run_logs`        append-only log chunks (last 5,000 lines per run)
 *
 * Logs live in a sidecar so the 2 s executor flushes append a small row
 * instead of rewriting a growing JSONB array on the hot `dbt_runs` row that
 * queue scans and run lists read.
 *
 * Ids: rows minted by the API use `newDualId()` (UUIDv8 in the ObjectId
 * subspace, so routes keep handing out 24-hex ids). Jobs synced from git use
 * `objectIdToUuid(derivedJobId(workspaceId, slug))`. `DEFAULT uuidv7()` covers
 * rows inserted by SQL.
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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DbtRunActor } from "../../../dbt/run-actor";
import { users } from "./auth";
import { workspaces } from "./workspaces";

/** Stored JSON shape of one environment (ids as wire strings). */
export interface DbtEnvironmentJson {
  name: string;
  connectionId: string;
  readConnectionId?: string;
  targetSchema: string;
  threads: number;
  vars?: Record<string, unknown>;
  ownerUserId?: string;
}

/** Stored JSON shape of `dbt_jobs.scheduled_run` (nextAt has its own column). */
export interface DbtJobScheduledRunJson {
  lastAt?: string;
  lastStatus?: "success" | "error";
  lastError?: string;
  lastDurationMs?: number;
  runCount?: number;
  consecutiveFailures?: number;
}

export interface DbtRunDeploysAfterRunJson {
  workspaceId: string;
  appIds: string[];
  sha: string;
  releasedAt?: string;
  releasedEarly?: boolean;
  rereleasedAt?: string;
}

export interface DbtRunLogLineJson {
  ts: string;
  level: string;
  line: string;
}

const timestamps = {
  /** Digest of the last imported row and log window. Runtime writes leave it intact. */
  backfillHash: text("backfill_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const dbtProjects = pgTable(
  "dbt_projects",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dbtVersion: text("dbt_version").notNull().default("1.12"),
    environments: jsonb("environments")
      .$type<DbtEnvironmentJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultEnvironment: text("default_environment").notNull().default("dev"),
    prodEnvironment: text("prod_environment"),
    lastProdManifestKey: text("last_prod_manifest_key"),
    lastProdManifestCommittedAt: timestamp("last_prod_manifest_committed_at", {
      withTimezone: true,
    }),
    lastProdManifestSha: text("last_prod_manifest_sha"),
    environmentsInvalid: jsonb("environments_invalid").$type<{
      reason: string;
      at: string;
    }>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Verbatim creator (user id or a sentinel such as "agent"). */
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  table => [
    unique("dbt_projects_ws_name_unique").on(table.workspaceId, table.name),
    index("idx_dbt_projects_ws_updated").on(
      table.workspaceId,
      table.updatedAt.desc(),
    ),
    check(
      "dbt_projects_environments_check",
      sql`jsonb_typeof(${table.environments}) = 'array'`,
    ),
  ],
);

export const dbtEnvPreferences = pgTable(
  "dbt_env_preferences",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => dbtProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    environment: text("environment").notNull(),
    ...timestamps,
  },
  table => [
    unique("dbt_env_preferences_project_user_unique").on(
      table.projectId,
      table.userId,
    ),
    index("idx_dbt_env_preferences_user").on(table.userId),
  ],
);

export const dbtJobs = pgTable(
  "dbt_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => dbtProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug"),
    sourceBlobSha: text("source_blob_sha"),
    definitionInvalid: jsonb("definition_invalid").$type<{
      reason: string;
      at: string;
      path?: string;
    }>(),
    environment: text("environment").notNull(),
    commands: text("commands")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    schedule: jsonb("schedule").$type<{ cron: string; timezone: string }>(),
    /** Run stats (lastAt, lastStatus, ..., runCount, consecutiveFailures). */
    scheduledRun: jsonb("scheduled_run").$type<DbtJobScheduledRunJson>(),
    /** `scheduledRun.nextAt` as a column: the scheduler's indexed scan + CAS. */
    scheduledRunNextAt: timestamp("scheduled_run_next_at", {
      withTimezone: true,
    }),
    enabled: boolean("enabled").notNull().default(true),
    deferToProduction: boolean("defer_to_production").notNull().default(false),
    lane: text("lane").$type<"default" | "fast">(),
    laneEvaluatedAt: timestamp("lane_evaluated_at", { withTimezone: true }),
    laneMedianMs: bigint("lane_median_ms", { mode: "number" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Verbatim creator (user id, or "sync" / "agent"). */
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  table => [
    index("idx_dbt_jobs_ws_project").on(table.workspaceId, table.projectId),
    uniqueIndex("dbt_jobs_project_slug_unique")
      .on(table.projectId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
    index("idx_dbt_jobs_due")
      .on(table.scheduledRunNextAt)
      .where(
        sql`${table.enabled} = true AND ${table.scheduledRunNextAt} IS NOT NULL`,
      ),
    check(
      "dbt_jobs_lane_check",
      sql`${table.lane} IS NULL OR ${table.lane} IN ('default', 'fast')`,
    ),
  ],
);

export const dbtRuns = pgTable(
  "dbt_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => dbtProjects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => dbtJobs.id, {
      onDelete: "set null",
    }),
    environment: text("environment").notNull(),
    commands: text("commands")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status")
      .$type<"queued" | "running" | "success" | "error" | "cancelled">()
      .notNull()
      .default("queued"),
    trigger: text("trigger")
      .$type<"schedule" | "manual" | "agent" | "ci">()
      .notNull(),
    triggeredBy: text("triggered_by").notNull(),
    actor: jsonb("actor").$type<DbtRunActor>(),
    lane: text("lane").$type<"default" | "fast">(),
    gitBranch: text("git_branch"),
    workingTreeUserId: text("working_tree_user_id"),
    sourceBranch: text("source_branch"),
    sourceSha: text("source_sha"),
    deferToProduction: boolean("defer_to_production"),
    localOverlay: jsonb("local_overlay").$type<{
      key: string;
      baseSha?: string;
      files: number;
      deletes: number;
    }>(),
    ci: jsonb("ci").$type<{
      prNumber: number;
      headSha: string;
      headRef: string;
      baseRef: string;
      owner: string;
      repo: string;
      installationId?: number;
    }>(),
    deploysAfterRun:
      jsonb("deploys_after_run").$type<DbtRunDeploysAfterRunJson>(),
    /** `deploysAfterRun.workspaceId` / `.sha` as columns for the per-push lookup. */
    deploysAfterWorkspaceId: uuid("deploys_after_workspace_id"),
    deploysAfterSha: text("deploys_after_sha"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    /** Log lines EVER written (rows in `dbt_run_logs` keep the last 5,000). */
    logTotal: integer("log_total").notNull().default(0),
    stepResults: jsonb("step_results")
      .$type<
        Array<{
          uniqueId: string;
          name: string;
          resourceType: string;
          status: string;
          executionTimeMs: number;
          rowsAffected?: number;
          message?: string;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    output: jsonb("output").$type<{ kind: "show-preview"; text: string }>(),
    artifactKeys: jsonb("artifact_keys")
      .$type<{
        manifest?: string;
        semanticManifest?: string;
        runResults?: string;
        catalog?: string;
        sources?: string;
      }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    retryOfRunId: uuid("retry_of_run_id"),
    restoreArtifactKeys: jsonb("restore_artifact_keys").$type<{
      runResults?: string;
      manifest?: string;
    }>(),
    error: text("error"),
    warnings: text("warnings").array(),
    inngestRunId: text("inngest_run_id"),
    ...timestamps,
  },
  table => [
    index("idx_dbt_runs_ws_project_created").on(
      table.workspaceId,
      table.projectId,
      table.createdAt.desc(),
    ),
    index("idx_dbt_runs_ws_created").on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    index("idx_dbt_runs_job_created")
      .on(table.jobId, table.createdAt.desc())
      .where(sql`${table.jobId} IS NOT NULL`),
    index("idx_dbt_runs_active_lane")
      .on(table.projectId, table.lane, table.status)
      .where(sql`${table.status} IN ('queued', 'running')`),
    index("idx_dbt_runs_deploys_after")
      .on(table.deploysAfterWorkspaceId, table.deploysAfterSha)
      .where(sql`${table.deploysAfterSha} IS NOT NULL`),
    index("idx_dbt_runs_completed")
      .on(table.completedAt)
      .where(sql`${table.completedAt} IS NOT NULL`),
    check(
      "dbt_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'success', 'error', 'cancelled')`,
    ),
    check(
      "dbt_runs_trigger_check",
      sql`${table.trigger} IN ('schedule', 'manual', 'agent', 'ci')`,
    ),
    check(
      "dbt_runs_lane_check",
      sql`${table.lane} IS NULL OR ${table.lane} IN ('default', 'fast')`,
    ),
    check(
      "dbt_runs_step_results_check",
      sql`jsonb_typeof(${table.stepResults}) = 'array'`,
    ),
  ],
);

export const dbtRunLogs = pgTable(
  "dbt_run_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    runId: uuid("run_id")
      .notNull()
      .references(() => dbtRuns.id, { onDelete: "cascade" }),
    /** Absolute line number of `lines[0]` (0-based). */
    seqStart: integer("seq_start").notNull(),
    /** Exclusive end: `seqStart + lines.length`. */
    seqEnd: integer("seq_end").notNull(),
    lines: jsonb("lines").$type<DbtRunLogLineJson[]>().notNull(),
  },
  table => [
    index("idx_dbt_run_logs_run_seq").on(table.runId, table.seqEnd),
    check(
      "dbt_run_logs_seq_check",
      sql`${table.seqStart} >= 0 AND ${table.seqEnd} > ${table.seqStart}`,
    ),
  ],
);

export type DbtProjectRow = typeof dbtProjects.$inferSelect;
export type NewDbtProjectRow = typeof dbtProjects.$inferInsert;
export type DbtEnvPreferenceRow = typeof dbtEnvPreferences.$inferSelect;
export type NewDbtEnvPreferenceRow = typeof dbtEnvPreferences.$inferInsert;
export type DbtJobRow = typeof dbtJobs.$inferSelect;
export type NewDbtJobRow = typeof dbtJobs.$inferInsert;
export type DbtRunRow = typeof dbtRuns.$inferSelect;
export type NewDbtRunRow = typeof dbtRuns.$inferInsert;
export type DbtRunLogRow = typeof dbtRunLogs.$inferSelect;
