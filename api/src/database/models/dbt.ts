import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * dbt — workspace-scoped dbt Core projects ("dbt Cloud replica").
 *
 * A project is a virtual filesystem in Mongo (one DbtFile doc per file)
 * materialized to a temp dir at run time by api/src/dbt/runner.service.ts.
 * Jobs hold command lists + cron schedules (claim pattern mirrors
 * SavedConsole.scheduledRun); runs are the per-execution records with
 * capped logs and parsed run_results.json step results.
 */

export interface IDbtEnvironment {
  /** Environment name, e.g. "dev" or "prod". Unique within the project. */
  name: string;
  /** DatabaseConnection id used as the warehouse target. */
  connectionId: Types.ObjectId;
  /**
   * Optional read-only connection to the same warehouse. Metric queries
   * (query_metric) run on it instead of `connectionId`, whose credential
   * has to write because dbt builds with it. Unset: metric queries run on
   * `connectionId`, read-only by the query guard.
   */
  readConnectionId?: Types.ObjectId;
  /** Target schema (dataset for BigQuery) dbt builds into. */
  targetSchema: string;
  /** dbt threads; default low (4) — prod container is memory-constrained. */
  threads: number;
  /** dbt vars passed as --vars for every command in this environment. */
  vars?: Record<string, unknown>;
  /**
   * Personal (per-developer) environment: set to the owning user's id when
   * this environment was auto-provisioned as that user's private dev target
   * (dbt Cloud-style development credentials, e.g. schema `dbt_jonas`).
   * Unset for shared environments (dev/prod). Agent/user actions without an
   * explicit environment default to the caller's personal environment.
   */
  ownerUserId?: string;
}

export interface IDbtProject extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  /** Pinned dbt-core minor version, e.g. "1.12". Informational for now. */
  dbtVersion: string;
  environments: IDbtEnvironment[];
  defaultEnvironment: string;
  /**
   * Explicit PRODUCTION environment (the defer target). Drives which
   * environment's successful runs update `lastProdManifestKey` (what ad-hoc
   * `--defer` resolves against), what `{{ dbt_schema }}` resolves to for
   * published apps, and which environment refuses ad-hoc warehouse writes.
   * Unset → convention: the environment literally named "prod" when one
   * exists, else the project default.
   */
  prodEnvironment?: string;
  /**
   * Artifact-store key of the last successful prod manifest.json. This is
   * the state artifact for --defer / state:modified+ (Slim CI, later phase).
   */
  lastProdManifestKey?: string;
  /**
   * Set when `dbt/environments.yml` at main does not parse. The derived
   * environments array is left as last-good; the file is never overwritten
   * from Mongo.
   */
  environmentsInvalid?: {
    reason: string;
    at: Date;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtEnvironmentSchema = new Schema<IDbtEnvironment>(
  {
    name: { type: String, required: true, trim: true },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    readConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
    },
    targetSchema: { type: String, required: true, trim: true },
    threads: { type: Number, default: 4, min: 1, max: 16 },
    vars: { type: Schema.Types.Mixed },
    ownerUserId: { type: String },
  },
  { _id: false },
);

const DbtProjectSchema = new Schema<IDbtProject>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    dbtVersion: { type: String, default: "1.12" },
    environments: { type: [DbtEnvironmentSchema], default: [] },
    defaultEnvironment: { type: String, default: "dev" },
    prodEnvironment: { type: String },
    lastProdManifestKey: { type: String },
    environmentsInvalid: {
      reason: { type: String },
      at: { type: Date },
    },
    createdBy: { type: String, required: true },
  },
  { collection: "dbt_projects", timestamps: true },
);

DbtProjectSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
DbtProjectSchema.index({ workspaceId: 1, updatedAt: -1 });

export const DbtProject = mongoose.model<IDbtProject>(
  "DbtProject",
  DbtProjectSchema,
);

/**
 * Per-user DEVELOPMENT environment choice for a dbt project — which
 * environment this user's ad-hoc work (editor runs, agent builds, previews)
 * targets by default.
 *
 * The working model this encodes:
 *  - Single player: the shared dev environment IS your personal target —
 *    drafts and branch verification build against dev. No row needed.
 *  - Multiple players: each user points at their own personal environment
 *    (schema `dbt_<user>`), so nobody stomps a teammate's schema.
 *
 * Absent row → resolution falls back to the user's personal environment when
 * one exists, else the project default. Explicit requests always win.
 */
export interface IDbtEnvPreference extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: string;
  /** Environment name from the project's environments list. */
  environment: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtEnvPreferenceSchema = new Schema<IDbtEnvPreference>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    userId: { type: String, required: true },
    environment: { type: String, required: true, trim: true },
  },
  { collection: "dbt_env_preferences", timestamps: true },
);

DbtEnvPreferenceSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export const DbtEnvPreference = mongoose.model<IDbtEnvPreference>(
  "DbtEnvPreference",
  DbtEnvPreferenceSchema,
);

/**
 * GitHub App installation linked to a workspace. We never persist installation
 * access tokens (they expire hourly and are minted on demand from the App's
 * private key); this record just maps a workspace to the installation id and
 * the account it was installed on so we can list repos and sync dbt projects.
 */
export interface IGitHubInstallation extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** GitHub App installation id (from install callback / webhook). */
  installationId: number;
  /** Login of the org/user the app is installed on. */
  accountLogin: string;
  accountType: "Organization" | "User";
  /** Whether the app can access all repos or a selected subset. */
  repositorySelection: "all" | "selected";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const GitHubInstallationSchema = new Schema<IGitHubInstallation>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    installationId: { type: Number, required: true },
    accountLogin: { type: String, required: true, trim: true },
    accountType: {
      type: String,
      enum: ["Organization", "User"],
      default: "Organization",
    },
    repositorySelection: {
      type: String,
      enum: ["all", "selected"],
      default: "all",
    },
    createdBy: { type: String, required: true },
  },
  { collection: "github_installations", timestamps: true },
);

GitHubInstallationSchema.index(
  { workspaceId: 1, installationId: 1 },
  { unique: true },
);

export const GitHubInstallation = mongoose.model<IGitHubInstallation>(
  "GitHubInstallation",
  GitHubInstallationSchema,
);

/**
 * Executor lane of a dbt run. Each project runs one invocation at a time per
 * lane. Short scheduled jobs use "fast"; everything else uses "default".
 */
export type DbtRunLane = "default" | "fast";

export interface IDbtJob extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  /** Filename identity in dbt/jobs/<slug>.yml (apps.md §23). */
  slug?: string;
  sourceBlobSha?: string;
  /** Set when `dbt/jobs/<slug>.yml` is invalid; schedule is disabled. */
  definitionInvalid?: {
    reason: string;
    at: Date;
    path?: string;
  };
  /** Environment name from the project's environments list. */
  environment: string;
  /** Validated against the dbt command allowlist (api/src/dbt/commands.ts). */
  commands: string[];
  schedule?: {
    cron: string;
    timezone: string;
  };
  /** Mirrors SavedConsole.scheduledRun so the optimistic claim transfers. */
  scheduledRun?: {
    nextAt?: Date;
    lastAt?: Date;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    runCount: number;
    consecutiveFailures: number;
  };
  enabled: boolean;
  /** Reserved for Slim CI (--defer against the stored prod manifest). */
  deferToProduction: boolean;
  /**
   * Cached executor lane for this job's scheduled runs (dbt-run-queue.ts,
   * resolveJobLane): "fast" when its median successful run is under 5 min
   * over at least 5 of its last 20. Recomputed at trigger time after 24 h.
   */
  lane?: DbtRunLane;
  laneEvaluatedAt?: Date;
  /** Median of the sampled successful runs when `lane` was computed. */
  laneMedianMs?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtJobSchema = new Schema<IDbtJob>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    slug: { type: String },
    sourceBlobSha: { type: String },
    definitionInvalid: {
      reason: { type: String },
      at: { type: Date },
      path: { type: String },
    },
    environment: { type: String, required: true },
    commands: { type: [String], default: [] },
    schedule: {
      cron: { type: String },
      timezone: { type: String },
    },
    scheduledRun: {
      nextAt: { type: Date },
      lastAt: { type: Date },
      lastStatus: { type: String, enum: ["success", "error"] },
      lastError: { type: String },
      lastDurationMs: { type: Number },
      runCount: { type: Number, default: 0 },
      consecutiveFailures: { type: Number, default: 0 },
    },
    enabled: { type: Boolean, default: true },
    deferToProduction: { type: Boolean, default: false },
    lane: { type: String, enum: ["default", "fast"] },
    laneEvaluatedAt: { type: Date },
    laneMedianMs: { type: Number },
    createdBy: { type: String, required: true },
  },
  { collection: "dbt_jobs", timestamps: true },
);

DbtJobSchema.index({ workspaceId: 1, projectId: 1 });
DbtJobSchema.index(
  { projectId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: "string" } } },
);
DbtJobSchema.index({ "scheduledRun.nextAt": 1, enabled: 1 }, { sparse: true });

export const DbtJob = mongoose.model<IDbtJob>("DbtJob", DbtJobSchema);

export type DbtRunStatus =
  "queued" | "running" | "success" | "error" | "cancelled";

export interface IDbtRunLogLine {
  ts: Date;
  level: string;
  line: string;
}

export interface IDbtRunStepResult {
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

export interface IDbtRun extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  projectId: Types.ObjectId;
  jobId?: Types.ObjectId;
  environment: string;
  commands: string[];
  status: DbtRunStatus;
  trigger: "schedule" | "manual" | "agent" | "ci";
  /** User id for manual triggers, "scheduler" / "agent" / "ci-webhook". */
  triggeredBy: string;
  /**
   * Executor lane chosen at trigger time (dbt-run-queue.ts, chooseRunLane).
   * Absent on runs that predate lanes, which ran in the default lane.
   */
  lane?: DbtRunLane;
  /**
   * Branch whose committed base tree the run executes against (repo-bound
   * projects). Unset means the project default branch. CI runs set the PR
   * head branch so Slim CI builds the PR's code.
   */
  gitBranch?: string;
  /**
   * When set, the run builds this user's WORKING tree (their checkout branch
   * plus draft overlay) instead of a committed base tree — used by
   * agent-triggered verification builds of uncommitted work. Scheduled /
   * CI / deploy runs leave this unset.
   */
  workingTreeUserId?: string;
  /**
   * DISPLAY-ONLY: the git branch this run's source tree came from, stamped
   * at trigger time so the Runs UI can say what was built without re-deriving
   * it. Working-tree runs record the caller's checkout branch; job/deploy
   * runs record the tracked branch; CI runs record the PR head. The executor
   * never reads this — `gitBranch` / `workingTreeUserId` stay authoritative.
   */
  sourceBranch?: string;
  /**
   * The commit this run builds, resolved (after a freshen from the mirror)
   * when the run is triggered. Every command builds this one tree, whichever
   * API instance executes it. Unset on laptop runs (the overlay names its own
   * base) and on runs that predate it, which build their branch's tip.
   */
  sourceSha?: string;
  /**
   * Ad-hoc/agent runs only: run with `--defer --state <prod manifest>` so
   * unselected refs resolve to the last production build instead of
   * rebuilding the whole upstream DAG in the target schema. Job runs read
   * the flag from the job (`job.deferToProduction`) and CI runs from the
   * project CI config, so those leave this unset.
   */
  deferToProduction?: boolean;
  /**
   * `mako dbt run` from a laptop checkout: the run builds the tree at
   * `baseSha` (a commit of the workspace repo) with the developer's local
   * files laid over it — uncommitted edits included, never committed
   * anywhere. The overlay itself is a JSON blob in the artifact store at
   * `key`; without `baseSha` it is the whole dbt/ tree. Never set together
   * with `gitBranch` / `workingTreeUserId`.
   */
  localOverlay?: {
    key: string;
    baseSha?: string;
    files: number;
    deletes: number;
  };
  /**
   * Pull-request CI context (trigger === "ci"). Drives the GitHub commit
   * status posted back to the PR head on completion.
   */
  ci?: {
    prNumber: number;
    headSha: string;
    headRef: string;
    baseRef: string;
    owner: string;
    repo: string;
    installationId?: number;
  };
  /**
   * App deploys held back until this run finishes (apps/dbt-before-deploy.ts): a
   * push to main changed dbt models and these apps, whose bindings read dbt
   * models. Whatever the run's outcome, its end requests their deploys once
   * (`releasedAt` marks that), so the bindings run against a rebuilt prod.
   */
  deploysAfterRun?: {
    workspaceId: string;
    appIds: string[];
    /** The commit of main the push deployed. */
    sha: string;
    releasedAt?: Date;
    /** The 60-minute cap released them while the run was still going. */
    releasedEarly?: boolean;
    /** The run then succeeded: the deploys were requested once more. */
    rereleasedAt?: Date;
  };
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  /** When a cancel was requested / finalized (status === "cancelled"). */
  cancelledAt?: Date;
  /** User id that cancelled the run, or "agent" for automated cancels. */
  cancelledBy?: string;
  /** Capped, batch-written log lines (parsed from --log-format json). */
  logs: IDbtRunLogLine[];
  /**
   * Log lines EVER written, including those the cap has dropped from the
   * front of `logs`: `logs[0]` is line number `logTotal - logs.length`. A
   * follower's cursor is this absolute number, so it keeps working once the
   * cap starts slicing. Absent on runs that predate it (= logs.length).
   */
  logTotal?: number;
  /** Parsed from run_results.json after each command. */
  stepResults: IDbtRunStepResult[];
  /** Structured bounded output for commands whose result is not run_results. */
  output?: {
    kind: "show-preview";
    text: string;
  };
  artifactKeys: {
    manifest?: string;
    /** semantic_manifest.json of the same parse (MetricFlow metrics). */
    semanticManifest?: string;
    runResults?: string;
    catalog?: string;
    sources?: string;
  };
  /** Set on retry runs: the run this was retried from. */
  retryOfRunId?: Types.ObjectId;
  /**
   * Artifact keys restored into target/ before commands run (retry-from-
   * failure: run_results.json drives `dbt retry`).
   */
  restoreArtifactKeys?: {
    runResults?: string;
    manifest?: string;
  };
  error?: string;
  /**
   * Files of the dbt tree the run skipped (too large or binary) that dbt does
   * not read. Skipped files dbt reads fail the run through `error` instead.
   */
  warnings?: string[];
  inngestRunId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DbtRunSchema = new Schema<IDbtRun>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "DbtProject",
      required: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: "DbtJob" },
    environment: { type: String, required: true },
    commands: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["queued", "running", "success", "error", "cancelled"],
      default: "queued",
      required: true,
    },
    trigger: {
      type: String,
      enum: ["schedule", "manual", "agent", "ci"],
      required: true,
    },
    triggeredBy: { type: String, required: true },
    lane: { type: String, enum: ["default", "fast"] },
    gitBranch: { type: String },
    workingTreeUserId: { type: String },
    sourceBranch: { type: String },
    sourceSha: { type: String },
    deferToProduction: { type: Boolean },
    localOverlay: {
      type: new Schema(
        {
          key: { type: String, required: true },
          baseSha: { type: String },
          files: { type: Number, required: true },
          deletes: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
    ci: {
      type: new Schema(
        {
          prNumber: { type: Number, required: true },
          headSha: { type: String, required: true },
          headRef: { type: String, required: true },
          baseRef: { type: String, required: true },
          owner: { type: String, required: true },
          repo: { type: String, required: true },
          installationId: { type: Number },
        },
        { _id: false },
      ),
      required: false,
    },
    deploysAfterRun: {
      type: new Schema(
        {
          workspaceId: { type: String, required: true },
          appIds: { type: [String], default: [] },
          sha: { type: String, required: true },
          releasedAt: { type: Date },
          releasedEarly: { type: Boolean },
          rereleasedAt: { type: Date },
        },
        { _id: false },
      ),
      required: false,
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    durationMs: { type: Number },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },
    logs: {
      type: [
        new Schema<IDbtRunLogLine>(
          {
            ts: { type: Date, required: true },
            level: { type: String, default: "info" },
            line: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    logTotal: { type: Number },
    stepResults: {
      type: [
        new Schema<IDbtRunStepResult>(
          {
            uniqueId: { type: String, required: true },
            name: { type: String, required: true },
            resourceType: { type: String, default: "model" },
            status: { type: String, required: true },
            executionTimeMs: { type: Number, default: 0 },
            rowsAffected: { type: Number },
            message: { type: String },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    output: {
      kind: { type: String, enum: ["show-preview"] },
      text: { type: String },
    },
    artifactKeys: {
      manifest: { type: String },
      semanticManifest: { type: String },
      runResults: { type: String },
      catalog: { type: String },
      sources: { type: String },
    },
    retryOfRunId: { type: Schema.Types.ObjectId, ref: "DbtRun" },
    restoreArtifactKeys: {
      runResults: { type: String },
      manifest: { type: String },
    },
    error: { type: String },
    warnings: { type: [String], default: undefined },
    inngestRunId: { type: String },
  },
  { collection: "dbt_runs", timestamps: true },
);

DbtRunSchema.index({ workspaceId: 1, projectId: 1, createdAt: -1 });
DbtRunSchema.index({ jobId: 1, createdAt: -1 }, { sparse: true });
// One pre-deploy build per pushed commit (apps/dbt-before-deploy.ts).
DbtRunSchema.index(
  { "deploysAfterRun.workspaceId": 1, "deploysAfterRun.sha": 1 },
  { sparse: true },
);

export const DbtRun = mongoose.model<IDbtRun>("DbtRun", DbtRunSchema);
