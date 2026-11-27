/**
 * Repository types for the `dbt` domain (Neon Postgres `pg_only`):
 *   - `dbt_projects`
 *   - `dbt_env_preferences`
 *   - `dbt_jobs`
 *   - `dbt_runs` (+ `dbt_run_logs` append-only chunk sidecar)
 *
 * Records keep the field names of the former Mongoose lean documents so the
 * JSON the routes return (`_id`, `workspaceId`, `scheduledRun`, ...) is
 * unchanged for the frontend. Every id is a wire string: a 24-hex ObjectId
 * for rows minted with `newDualId()` / backfilled from Mongo, or a canonical
 * UUID for native UUIDv7 rows (`toWireId`).
 *
 * Optional fields are `undefined` when unset (never `null`), like a lean doc.
 * In update inputs, `undefined` leaves a field alone and `null` clears it.
 */
import type { DbtRunActor } from "../../dbt/run-actor";

export type DbtRunStatus =
  "queued" | "running" | "success" | "error" | "cancelled";
export type DbtRunTrigger = "schedule" | "manual" | "agent" | "ci";
/**
 * Executor lane of a dbt run. Each project runs one invocation at a time per
 * lane. Short scheduled jobs use "fast"; everything else uses "default".
 */
export type DbtRunLane = "default" | "fast";

export const ACTIVE_DBT_RUN_STATUSES: readonly DbtRunStatus[] = [
  "queued",
  "running",
];
export const TERMINAL_DBT_RUN_STATUSES: readonly DbtRunStatus[] = [
  "success",
  "error",
  "cancelled",
];

/** Retained log lines per run (oldest dropped first). */
export const DBT_RUN_MAX_LOG_LINES = 5000;
/** Per-line cap applied when logs are written. */
export const DBT_RUN_MAX_LOG_LINE_CHARS = 2000;

// ── Projects ────────────────────────────────────────────────────────────────

export interface DbtEnvironmentRecord {
  /** Environment name, e.g. "dev" or "prod". Unique within the project. */
  name: string;
  /** DatabaseConnection id used as the warehouse target (wire id). */
  connectionId: string;
  /** Optional read-only connection to the same warehouse (wire id). */
  readConnectionId?: string;
  /** Target schema (dataset for BigQuery) dbt builds into. */
  targetSchema: string;
  /** dbt threads (1..16, default 4). */
  threads: number;
  /** dbt vars passed as --vars for every command in this environment. */
  vars?: Record<string, unknown>;
  /** Owning user id of a personal (per-developer) environment. */
  ownerUserId?: string;
}

export interface DbtProjectRecord {
  _id: string;
  workspaceId: string;
  name: string;
  dbtVersion: string;
  environments: DbtEnvironmentRecord[];
  defaultEnvironment: string;
  prodEnvironment?: string;
  lastProdManifestKey?: string;
  lastProdManifestCommittedAt?: Date;
  lastProdManifestSha?: string;
  environmentsInvalid?: { reason: string; at: Date };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDbtProjectInput {
  /** Optional explicit wire id; minted with `newDualId()` when omitted. */
  _id?: string;
  workspaceId: string;
  name: string;
  dbtVersion?: string;
  environments?: DbtEnvironmentRecord[];
  defaultEnvironment?: string;
  prodEnvironment?: string;
  createdBy: string;
}

/** `undefined` = leave alone, `null` = clear. Every update bumps `updatedAt`. */
export interface DbtProjectUpdate {
  name?: string;
  dbtVersion?: string;
  environments?: DbtEnvironmentRecord[];
  defaultEnvironment?: string;
  prodEnvironment?: string | null;
  lastProdManifestKey?: string | null;
  lastProdManifestCommittedAt?: Date | null;
  lastProdManifestSha?: string | null;
  environmentsInvalid?: { reason: string; at: Date } | null;
}

export class DbtDuplicateProjectNameError extends Error {
  readonly code = "DBT_DUPLICATE_PROJECT_NAME" as const;
  constructor(name: string) {
    super(`A dbt project named "${name}" already exists in this workspace`);
    this.name = "DbtDuplicateProjectNameError";
  }
}

export interface ListDbtProjectsOptions {
  /** Default `updatedAtDesc`. */
  sort?: "updatedAtDesc" | "nameAsc";
  limit?: number;
  /** Restrict to one project id (wire id). */
  projectId?: string;
}

// ── Env preferences ─────────────────────────────────────────────────────────

export interface DbtEnvPreferenceRecord {
  _id: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  environment: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertDbtEnvPreferenceInput {
  workspaceId: string;
  projectId: string;
  userId: string;
  environment: string;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export interface DbtJobSchedule {
  cron: string;
  timezone: string;
}

export interface DbtJobScheduledRun {
  nextAt?: Date;
  lastAt?: Date;
  lastStatus?: "success" | "error";
  lastError?: string;
  lastDurationMs?: number;
  runCount: number;
  consecutiveFailures: number;
}

export interface DbtJobDefinitionInvalid {
  reason: string;
  at: Date;
  path?: string;
}

export interface DbtJobRecord {
  _id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  /** Filename identity in dbt/jobs/<slug>.yml. */
  slug?: string;
  sourceBlobSha?: string;
  definitionInvalid?: DbtJobDefinitionInvalid;
  environment: string;
  commands: string[];
  schedule?: DbtJobSchedule;
  /** Always present (runCount / consecutiveFailures default to 0). */
  scheduledRun: DbtJobScheduledRun;
  enabled: boolean;
  deferToProduction: boolean;
  lane?: DbtRunLane;
  laneEvaluatedAt?: Date;
  laneMedianMs?: number;
  /** User id, or a sentinel such as "sync" / "agent". */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDbtJobInput {
  /** Explicit wire id (e.g. `derivedJobId(workspaceId, slug)`); minted when omitted. */
  _id?: string;
  workspaceId: string;
  projectId: string;
  name: string;
  slug?: string;
  sourceBlobSha?: string;
  definitionInvalid?: DbtJobDefinitionInvalid;
  environment: string;
  commands?: string[];
  schedule?: DbtJobSchedule;
  enabled?: boolean;
  deferToProduction?: boolean;
  createdBy: string;
}

/**
 * `undefined` = leave alone, `null` = clear. `scheduledRun` MERGES into the
 * stored sub-object key by key (a `null` key removes it); it never replaces
 * the whole object. Every update bumps `updatedAt`.
 */
export interface DbtJobUpdate {
  name?: string;
  slug?: string | null;
  sourceBlobSha?: string | null;
  definitionInvalid?: DbtJobDefinitionInvalid | null;
  environment?: string;
  commands?: string[];
  schedule?: DbtJobSchedule | null;
  enabled?: boolean;
  deferToProduction?: boolean;
  lane?: DbtRunLane | null;
  laneEvaluatedAt?: Date | null;
  laneMedianMs?: number | null;
  scheduledRun?: {
    nextAt?: Date | null;
    lastAt?: Date | null;
    lastStatus?: "success" | "error" | null;
    lastError?: string | null;
    lastDurationMs?: number | null;
    runCount?: number;
    consecutiveFailures?: number;
  };
}

export interface DbtJobScope {
  workspaceId?: string;
  projectId?: string;
}

/** Outcome of one finished run of a job, folded into `scheduledRun`. */
export interface DbtJobRunOutcome {
  completedAt: Date;
  status: "success" | "error";
  /** Stored as `lastError` on failures; cleared otherwise. */
  error?: string;
  durationMs?: number;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export interface DbtRunLogLine {
  ts: Date;
  level: string;
  line: string;
}

export interface DbtRunStepResult {
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

export interface DbtRunLocalOverlay {
  key: string;
  baseSha?: string;
  files: number;
  deletes: number;
}

export interface DbtRunCi {
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  owner: string;
  repo: string;
  installationId?: number;
}

export interface DbtRunDeploysAfterRun {
  workspaceId: string;
  appIds: string[];
  /** The commit of main the push deployed. */
  sha: string;
  releasedAt?: Date;
  releasedEarly?: boolean;
  rereleasedAt?: Date;
}

export interface DbtRunArtifactKeys {
  manifest?: string;
  semanticManifest?: string;
  runResults?: string;
  catalog?: string;
  sources?: string;
}

export interface DbtRunRestoreArtifactKeys {
  runResults?: string;
  manifest?: string;
}

/** A run WITHOUT its log lines (those live in `dbt_run_logs`). */
export interface DbtRunRecord {
  _id: string;
  workspaceId: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  status: DbtRunStatus;
  trigger: DbtRunTrigger;
  triggeredBy: string;
  actor?: DbtRunActor;
  lane?: DbtRunLane;
  gitBranch?: string;
  workingTreeUserId?: string;
  sourceBranch?: string;
  sourceSha?: string;
  deferToProduction?: boolean;
  localOverlay?: DbtRunLocalOverlay;
  ci?: DbtRunCi;
  deploysAfterRun?: DbtRunDeploysAfterRun;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  cancelledAt?: Date;
  cancelledBy?: string;
  /** Log lines EVER written (the retained window is the last 5,000). */
  logTotal: number;
  stepResults: DbtRunStepResult[];
  output?: { kind: "show-preview"; text: string };
  artifactKeys: DbtRunArtifactKeys;
  retryOfRunId?: string;
  restoreArtifactKeys?: DbtRunRestoreArtifactKeys;
  error?: string;
  warnings?: string[];
  inngestRunId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A run with its retained log window (last <= 5,000 lines, oldest first). */
export interface DbtRunWithLogs extends DbtRunRecord {
  logs: DbtRunLogLine[];
}

export interface CreateDbtRunInput {
  _id?: string;
  workspaceId: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  status?: DbtRunStatus;
  trigger: DbtRunTrigger;
  triggeredBy: string;
  actor?: DbtRunActor;
  lane?: DbtRunLane;
  gitBranch?: string;
  workingTreeUserId?: string;
  sourceBranch?: string;
  sourceSha?: string;
  deferToProduction?: boolean;
  localOverlay?: DbtRunLocalOverlay;
  ci?: DbtRunCi;
  deploysAfterRun?: DbtRunDeploysAfterRun;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  stepResults?: DbtRunStepResult[];
  retryOfRunId?: string;
  restoreArtifactKeys?: DbtRunRestoreArtifactKeys;
  error?: string;
  warnings?: string[];
  /** Initial log lines (completed ad-hoc runs). Capped to the last 5,000. */
  logs?: DbtRunLogLine[];
}

/** `undefined` = leave alone, `null` = clear. Every update bumps `updatedAt`. */
export interface DbtRunUpdate {
  status?: DbtRunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  cancelledAt?: Date | null;
  cancelledBy?: string | null;
  error?: string | null;
  output?: { kind: "show-preview"; text: string } | null;
  /** MERGED key by key into the stored artifact keys. */
  artifactKeys?: DbtRunArtifactKeys;
  inngestRunId?: string | null;
  sourceSha?: string | null;
  /** Appended (`$push` / `||`). */
  pushStepResults?: DbtRunStepResult[];
  /** Added when not already present (`$addToSet`). */
  addWarnings?: string[];
}

/** Optimistic guard on an update: the row must currently match. */
export interface DbtRunGuard {
  status?: DbtRunStatus | readonly DbtRunStatus[];
}

/**
 * Read filter over runs. Every given field must match (AND).
 * `lane: "default"` also matches runs that predate lanes (no lane).
 */
export interface DbtRunQuery {
  workspaceId?: string;
  projectId?: string;
  jobId?: string;
  status?: DbtRunStatus | readonly DbtRunStatus[];
  environment?: string;
  triggeredBy?: string;
  lane?: DbtRunLane;
  /** Exclude this run id. */
  excludeRunId?: string;
  createdBefore?: Date;
  /** Only runs with `durationMs > value`. */
  durationMsGreaterThan?: number;
  /** Only runs with a manifest artifact (any key). */
  hasManifest?: boolean;
  /** Only runs with a semantic manifest artifact (any key). */
  hasSemanticManifest?: boolean;
  /** Only runs whose `artifactKeys.manifest` equals this key. */
  manifestKey?: string;
  /** Only laptop (`mako dbt run`) runs. */
  hasLocalOverlay?: boolean;
  /** Only pre-deploy builds of this pushed commit. */
  deploysAfter?: { workspaceId: string; sha: string };
}

export interface ListDbtRunsOptions {
  /** Default `createdAtDesc`. */
  sort?: "createdAtDesc" | "createdAtAsc";
  limit?: number;
}

/** The run a slot check looks at (dbt-run-queue.ts). */
export interface DbtRunSlotSubject {
  _id: string;
  projectId: string;
  jobId?: string | null;
  lane?: DbtRunLane | null;
}

export type DbtRunSlotClaim =
  | { state: "claimed"; run: DbtRunRecord }
  | { state: "busy"; holderId: string }
  | { state: "gone" };

/** An active run plus the tail of its log window (the sweeper). */
export interface DbtActiveRunWithLogTail {
  run: Pick<
    DbtRunRecord,
    "_id" | "jobId" | "status" | "createdAt" | "startedAt"
  >;
  logs: DbtRunLogLine[];
}

export type DbtDeploysAfterClaim = "releasedAt" | "rereleasedAt";

// ── Scheduled-run claim (services/scheduled-run-claim.ts) ───────────────────

export interface DbtDueScheduledJob {
  id: string;
  workspaceId: string;
  nextAt: Date | string | null;
  schedule: { cron?: string | null; timezone?: string | null } | null;
}

// ── Repository ──────────────────────────────────────────────────────────────

export interface DbtRepository {
  // Projects
  findProjectById(
    projectId: string,
    workspaceId?: string,
  ): Promise<DbtProjectRecord | null>;
  listProjectsByWorkspace(
    workspaceId: string,
    options?: ListDbtProjectsOptions,
  ): Promise<DbtProjectRecord[]>;
  workspaceHasProject(workspaceId: string): Promise<boolean>;
  /** Throws `DbtDuplicateProjectNameError` on `(workspace_id, name)` clash. */
  createProject(input: CreateDbtProjectInput): Promise<DbtProjectRecord>;
  /** Returns the updated row, or null when it does not exist. */
  updateProject(
    projectId: string,
    update: DbtProjectUpdate,
  ): Promise<DbtProjectRecord | null>;
  /**
   * Compare-and-set promotion of the prod manifest: applies only when the
   * stored `lastProdManifestCommittedAt` is unset or `<= committedAt`.
   * Without `sourceSha`, clears `lastProdManifestSha`. Returns whether it applied.
   */
  promoteProdManifest(params: {
    projectId: string;
    manifestKey: string;
    committedAt: Date;
    sourceSha?: string;
  }): Promise<boolean>;
  /** Deletes the project with its env preferences, jobs, runs and logs. */
  deleteProject(projectId: string): Promise<boolean>;
  /** Deletes every project of a workspace (and everything under them). */
  deleteProjectsByWorkspace(workspaceId: string): Promise<number>;

  // Env preferences
  findEnvPreference(
    projectId: string,
    userId: string,
  ): Promise<DbtEnvPreferenceRecord | null>;
  listEnvPreferencesForUser(
    projectIds: readonly string[],
    userId: string,
  ): Promise<DbtEnvPreferenceRecord[]>;
  upsertEnvPreference(
    input: UpsertDbtEnvPreferenceInput,
  ): Promise<DbtEnvPreferenceRecord>;
  deleteEnvPreference(projectId: string, userId: string): Promise<boolean>;

  // Jobs
  findJobById(jobId: string, scope?: DbtJobScope): Promise<DbtJobRecord | null>;
  findJobBySlug(projectId: string, slug: string): Promise<DbtJobRecord | null>;
  listJobsByProject(projectId: string): Promise<DbtJobRecord[]>;
  listJobsByIds(jobIds: readonly string[]): Promise<DbtJobRecord[]>;
  jobSlugExists(projectId: string, slug: string): Promise<boolean>;
  createJob(input: CreateDbtJobInput): Promise<DbtJobRecord>;
  /** Returns the updated row, or null when it does not exist. */
  updateJob(jobId: string, update: DbtJobUpdate): Promise<DbtJobRecord | null>;
  /**
   * Fold one finished run into `scheduledRun` atomically: lastAt, lastStatus,
   * lastError (failures only), lastDurationMs, runCount + 1, and
   * consecutiveFailures + 1 on "error" / reset to 0 on "success".
   * Returns the updated job.
   */
  recordJobRunOutcome(
    jobId: string,
    outcome: DbtJobRunOutcome,
  ): Promise<DbtJobRecord | null>;
  /**
   * Reset `scheduledRun.consecutiveFailures` to 0 when the job is enabled and
   * the count already reached `threshold` (a job re-enabled after an
   * auto-disable). Returns whether it reset.
   */
  resetJobFailuresIfReenabled(
    jobId: string,
    threshold: number,
  ): Promise<boolean>;
  deleteJob(jobId: string, scope?: DbtJobScope): Promise<boolean>;
  /** Enabled jobs with a cron whose `scheduledRun.nextAt <= now`. */
  findDueScheduledJobs(now: Date): Promise<DbtDueScheduledJob[]>;
  /** CAS flip of `scheduledRun.nextAt` from `job.nextAt` to `nextAt`. */
  claimScheduledJob(
    job: DbtDueScheduledJob,
    nextAt: Date,
  ): Promise<{ modifiedCount: number }>;

  // Runs
  findRunById(runId: string, query?: DbtRunQuery): Promise<DbtRunRecord | null>;
  /** The run plus its retained log window. */
  findRunWithLogs(
    runId: string,
    query?: DbtRunQuery,
    logsSince?: number,
  ): Promise<DbtRunWithLogs | null>;
  findLatestArtifactRun(
    query: DbtRunQuery,
    includeSteps?: boolean,
  ): Promise<
    | (Pick<DbtRunRecord, "environment" | "artifactKeys" | "createdAt"> & {
        stepResults?: DbtRunStepResult[];
      })
    | null
  >;
  findLatestRun(query: DbtRunQuery): Promise<DbtRunRecord | null>;
  listRuns(
    query: DbtRunQuery,
    options?: ListDbtRunsOptions,
  ): Promise<DbtRunRecord[]>;
  runExists(query: DbtRunQuery): Promise<boolean>;
  createRun(input: CreateDbtRunInput): Promise<DbtRunRecord>;
  /**
   * Patch a run. With a guard, applies only when the row matches it.
   * Returns the updated row, or null when nothing matched.
   */
  updateRun(
    runId: string,
    update: DbtRunUpdate,
    guard?: DbtRunGuard,
  ): Promise<DbtRunRecord | null>;
  /** Claim a terminal outcome and update the owning job's counters once. */
  finishRun(
    runId: string,
    outcome: DbtJobRunOutcome,
    expectedStatus: DbtRunStatus,
  ): Promise<{ run: DbtRunRecord; job: DbtJobRecord | null } | null>;
  /**
   * Flip a queued/running run to "cancelled" in one atomic write, keeping an
   * already-staged cancelledAt/cancelledBy/error and computing durationMs
   * from startedAt. No-op on a terminal run.
   */
  finalizeCancelledRun(
    runId: string,
    fallbackCancelledBy?: string,
  ): Promise<void>;
  /**
   * A running run holding `run`'s slot: a running run of its project lane, or
   * a running run of its own job in the other lane. Oldest `startedAt` first.
   */
  findRunSlotHolder(run: DbtRunSlotSubject): Promise<DbtRunRecord | null>;
  /** Move a queued run to "running" only when no other run holds its slot. */
  claimRunSlot(runId: string, now?: Date): Promise<DbtRunSlotClaim>;
  /** Append log lines; keeps the last 5,000 and bumps `logTotal`. */
  appendRunLogs(runId: string, lines: readonly DbtRunLogLine[]): Promise<void>;
  /** Active (queued/running) runs with the last `tail` log lines each. */
  listActiveRunsWithLogTail(tail: number): Promise<DbtActiveRunWithLogTail[]>;
  /**
   * Delete terminal runs that completed before `cutoff` (falling back to
   * `createdAt` when `completedAt` is unset). Their logs go with them.
   */
  pruneTerminalRuns(cutoff: Date): Promise<number>;

  // Held app deploys (apps/dbt-before-deploy.ts)
  /**
   * Add apps to an ACTIVE, unreleased pre-deploy build. Returns whether the
   * run matched (queued/running, `deploysAfterRun` set, `releasedAt` unset).
   */
  joinDeploysAfterRun(
    runId: string,
    appIds: readonly string[],
  ): Promise<boolean>;
  /**
   * Claim `deploysAfterRun.releasedAt = now` once. Without `anyStatus` the run
   * must be terminal; with it, `releasedEarly` records whether the run was
   * still active at that instant. Returns the run after the claim, or null.
   */
  claimDeploysAfterRelease(
    runId: string,
    opts?: { anyStatus?: boolean },
  ): Promise<DbtRunRecord | null>;
  /**
   * Claim `deploysAfterRun.rereleasedAt = now` once for a successful run that
   * the cap released early. Returns the run after the claim, or null.
   */
  claimDeploysAfterRerelease(runId: string): Promise<DbtRunRecord | null>;
  /** Undo a claim (and `releasedEarly` with `releasedAt`) after a failed request. */
  unclaimDeploysAfterRun(
    runId: string,
    claim: DbtDeploysAfterClaim,
  ): Promise<void>;
}
