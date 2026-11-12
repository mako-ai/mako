// Owner: WP5 (warehouse introspection).
//
// Who read a relation and what a dbt model costs, from the warehouse's own
// job history. The SQL lives behind `DatabaseDriver.buildJobHistoryQuery`;
// this file picks the dbt environment's connection, bounds the inputs, runs
// the query and falls back from project-wide history to the connection's own
// jobs when the warehouse denies the project-wide view.
import { Types } from "mongoose";
import {
  DatabaseConnection,
  DbtJob,
  DbtProject,
  DbtRun,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import {
  JOB_HISTORY_DEFAULT_LIMIT,
  JOB_HISTORY_MAX_DAYS,
  JOB_HISTORY_MAX_IDS,
  JOB_HISTORY_MAX_LIMIT,
  type DatabaseDriver,
  type JobHistoryQueryKind,
  type JobHistoryQueryParams,
} from "../databases/driver";
import { databaseRegistry } from "../databases/registry";
import { resolveProdLikeEnvironmentName } from "../dbt/dbt-environments.service";
import { loggers } from "../logging";
import { withQueryLabels } from "./bigquery-labels";
import { databaseConnectionService } from "./database-connection.service";

const logger = loggers.api("warehouse-job-history");

/** Shared by the three WP5 tools: unsupported engines answer, never throw. */
export type WarehouseIntrospection<T> =
  ({ supported: true } & T) | { supported: false; reason: string };

interface JobHistoryTarget {
  workspaceId: string;
  projectId: string;
  /** Default: the project's production environment. */
  environment?: string;
  /** Look-back window. Default 7, max 30. */
  days?: number;
  /** Default 100, max 500. */
  limit?: number;
}

export interface JobHistoryMeta {
  /** "user" = fell back to jobs of the connection's own account. */
  scope: "project" | "user";
  days: number;
  /** Set on fallback: the missing permission and the grant command. */
  warning?: string;
  /** Limits of the answer that hold whatever the scope. */
  notes?: string[];
}

export interface ModelCostRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  nodeId?: string;
  relation?: string;
  jobs: number;
  bytesBilled: number;
  slotMs: number;
  /** dbt invocations (commands) that ran the node that day. */
  invocations?: number;
  /** Mean wall-clock time of one warehouse job, milliseconds. */
  avgDurationMs?: number;
}

export interface TableReaderRow {
  makoSource?: string;
  makoApp?: string;
  userEmail: string;
  jobs: number;
  bytesBilled: number;
  lastReadAt: string;
  /**
   * Jobs matched on the relation's name in the query text only (how a view
   * is found). A subset of `jobs`.
   */
  jobsByTextOnly?: number;
}

/** The warehouse a dbt environment builds into. */
export interface DbtWarehouseTarget {
  connection: IDatabaseConnection;
  /** The resolved environment name. */
  environment: string;
  /** True when it is the project's production-like environment. */
  prodLike: boolean;
  lastProdManifestKey?: string;
}

type QueryOutcome = { success: boolean; data?: unknown; error?: string };

/** Seams for the offline tests; production uses `defaultJobHistoryDeps`. */
export interface JobHistoryDeps {
  resolveTarget(params: {
    workspaceId: string;
    projectId: string;
    environment?: string;
  }): Promise<DbtWarehouseTarget>;
  /** Newest first. Runs of one environment created since `since`. */
  listRuns(params: {
    workspaceId: string;
    projectId: string;
    environment: string;
    since: Date;
    jobId?: string;
    runId?: string;
    limit: number;
  }): Promise<Array<{ id: string; invocationIds: string[] }>>;
  /** Values the `mako_dbt_job` label may hold for this job. */
  jobLabelValues(params: {
    workspaceId: string;
    projectId: string;
    jobId: string;
  }): Promise<string[]>;
  getDriver(type: string): DatabaseDriver | undefined;
  runQuery(connection: IDatabaseConnection, sql: string): Promise<QueryOutcome>;
  now(): Date;
}

const DEFAULT_DAYS = 7;
/** Most runs whose ids one model_cost query filters on. */
const MAX_RUNS = 1000;
const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;

function objectId(value: string, name: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw new Error(`Invalid ${name}`);
  return new Types.ObjectId(value);
}

/**
 * The connection behind a dbt environment, scoped to the workspace. Throws
 * when the project, the environment or its connection does not exist.
 */
export async function resolveDbtWarehouseTarget(params: {
  workspaceId: string;
  projectId: string;
  environment?: string;
}): Promise<DbtWarehouseTarget> {
  const workspaceId = objectId(params.workspaceId, "workspaceId");
  const project = await DbtProject.findOne({
    _id: objectId(params.projectId, "projectId"),
    workspaceId,
  })
    .select(
      "environments defaultEnvironment prodEnvironment lastProdManifestKey",
    )
    .lean();
  if (!project) throw new Error("dbt project not found");
  const prodLikeName = resolveProdLikeEnvironmentName(project);
  const name = params.environment ?? prodLikeName;
  const environment = project.environments.find(env => env.name === name);
  if (!environment) {
    throw new Error(`dbt environment "${name}" not found in this project`);
  }
  const connection = await DatabaseConnection.findOne({
    _id: environment.connectionId,
    workspaceId,
  });
  if (!connection) {
    throw new Error(`The connection of environment "${name}" was not found`);
  }
  return {
    connection,
    environment: name,
    prodLike: name === prodLikeName,
    lastProdManifestKey: project.lastProdManifestKey,
  };
}

export const defaultJobHistoryDeps: JobHistoryDeps = {
  resolveTarget: resolveDbtWarehouseTarget,
  async listRuns(params) {
    const filter: Record<string, unknown> = {
      workspaceId: objectId(params.workspaceId, "workspaceId"),
      projectId: objectId(params.projectId, "projectId"),
      environment: params.environment,
      createdAt: { $gte: params.since },
    };
    if (params.jobId) filter.jobId = objectId(params.jobId, "jobId");
    if (params.runId) filter._id = objectId(params.runId, "runId");
    const runs = await DbtRun.find(filter)
      .sort({ createdAt: -1 })
      .limit(params.limit)
      .select("invocationIds")
      .lean();
    return runs.map(run => ({
      id: String(run._id),
      invocationIds: run.invocationIds ?? [],
    }));
  },
  async jobLabelValues(params) {
    const job = await DbtJob.findOne({
      _id: objectId(params.jobId, "jobId"),
      workspaceId: objectId(params.workspaceId, "workspaceId"),
      projectId: objectId(params.projectId, "projectId"),
    })
      .select("slug")
      .lean();
    if (!job) throw new Error("dbt job not found");
    return [job.slug, String(job._id)].filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
  },
  getDriver: type => databaseRegistry.getDriver(type),
  runQuery: (connection, sql) =>
    // Labelled "metadata" so these lookups never count as readers themselves.
    withQueryLabels({ mako_source: "metadata" }, () =>
      databaseConnectionService.executeQuery(connection, sql, {
        readOnly: true,
      }),
    ),
  now: () => new Date(),
};

function clampInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/** A BigQuery label value, the form dbt and Mako both write. */
function asLabelValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 63);
}

function uniqueLabelValues(values: string[]): string[] {
  return [...new Set(values.map(asLabelValue))]
    .filter(value => LABEL_VALUE.test(value))
    .slice(0, JOB_HISTORY_MAX_IDS);
}

function unsupported(connection: IDatabaseConnection): {
  supported: false;
  reason: string;
} {
  return {
    supported: false,
    reason: `Job history is not available on ${connection.type} connections.`,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Run one job-history query project-wide; when the warehouse denies that
 * view, run it again over the connection's own jobs and say so.
 */
async function runWithScopeFallback(
  deps: JobHistoryDeps,
  driver: DatabaseDriver,
  connection: IDatabaseConnection,
  kind: JobHistoryQueryKind,
  params: Omit<JobHistoryQueryParams, "scope">,
): Promise<{
  scope: "project" | "user";
  warning?: string;
  rows: Record<string, unknown>[];
} | null> {
  const build = (scope: "project" | "user") =>
    driver.buildJobHistoryQuery?.(connection, kind, { ...params, scope }) ??
    null;
  const rowsOf = (outcome: QueryOutcome) =>
    (Array.isArray(outcome.data) ? outcome.data : []) as Record<
      string,
      unknown
    >[];

  const projectSql = build("project");
  if (projectSql === null) return null;
  const projectWide = await deps.runQuery(connection, projectSql);
  if (projectWide.success) {
    return { scope: "project", rows: rowsOf(projectWide) };
  }
  const denied =
    driver.isJobHistoryAccessDenied?.(projectWide.error ?? "") ?? false;
  if (!denied) {
    throw new Error(projectWide.error ?? "Job history query failed");
  }

  const userSql = build("user");
  if (userSql === null) {
    throw new Error(projectWide.error ?? "Job history query failed");
  }
  const own = await deps.runQuery(connection, userSql);
  if (!own.success) throw new Error(own.error ?? "Job history query failed");
  logger.info("Job history fell back to the connection's own jobs", {
    kind,
    connectionId: String(connection._id),
  });
  const hint = driver.describeJobHistoryGrant?.(connection);
  return {
    scope: "user",
    rows: rowsOf(own),
    warning:
      "Only jobs started by this connection's own account are listed. " +
      "Jobs run with other credentials (BI tools, analysts, other service " +
      "accounts) are invisible here." +
      (hint ? ` ${hint}` : ""),
  };
}

/**
 * Cost per model per day for Mako dbt runs, matched through the runs'
 * `invocationIds`. `runId` narrows to one run, `jobId` to one job. Throws on
 * a failed warehouse query.
 */
export async function modelCost(
  params: JobHistoryTarget & {
    jobId?: string;
    runId?: string;
    /** One model: a dbt unique_id (`model.project.name`) or a bare name. */
    model?: string;
  },
  deps: JobHistoryDeps = defaultJobHistoryDeps,
): Promise<WarehouseIntrospection<JobHistoryMeta & { rows: ModelCostRow[] }>> {
  const target = await deps.resolveTarget(params);
  const driver = deps.getDriver(target.connection.type);
  if (!driver?.buildJobHistoryQuery) return unsupported(target.connection);

  const days = clampInteger(params.days, DEFAULT_DAYS, JOB_HISTORY_MAX_DAYS);
  const limit = clampInteger(
    params.limit,
    JOB_HISTORY_DEFAULT_LIMIT,
    JOB_HISTORY_MAX_LIMIT,
  );
  const since = new Date(deps.now().getTime() - days * 24 * 60 * 60 * 1000);
  const runs = await deps.listRuns({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    environment: target.environment,
    since,
    jobId: params.jobId,
    runId: params.runId,
    limit: MAX_RUNS,
  });
  // A job's label also finds the runs past the cap. Not with `runId`: the
  // job label would widen one run to every run of its job.
  const makoJobLabels =
    params.jobId && !params.runId
      ? uniqueLabelValues(
          await deps.jobLabelValues({
            workspaceId: params.workspaceId,
            projectId: params.projectId,
            jobId: params.jobId,
          }),
        )
      : [];
  const makoRunIds = uniqueLabelValues(runs.map(run => run.id));
  const invocationIds = uniqueLabelValues(
    runs.flatMap(run => run.invocationIds),
  );

  const notes: string[] = [];
  if (runs.length === MAX_RUNS) {
    notes.push(
      `Only the ${MAX_RUNS} most recent runs of the window are matched.`,
    );
  }
  if (makoRunIds.length === 0 && makoJobLabels.length === 0) {
    return {
      supported: true,
      scope: "project",
      days,
      rows: [],
      notes: [
        `No Mako dbt run in environment "${target.environment}" in the last ${days} days.`,
      ],
    };
  }

  const result = await runWithScopeFallback(
    deps,
    driver,
    target.connection,
    "model_cost",
    {
      days,
      limit,
      invocationIds,
      makoRunIds,
      makoJobLabels,
      model: params.model,
    },
  );
  if (result === null) return unsupported(target.connection);

  const rows: ModelCostRow[] = result.rows.map(row => ({
    day: String(row.day ?? ""),
    nodeId: text(row.node_id),
    relation: text(row.relation),
    jobs: count(row.jobs),
    bytesBilled: count(row.bytes_billed),
    slotMs: count(row.slot_ms),
    invocations: optionalCount(row.invocations),
    avgDurationMs: optionalCount(row.avg_duration_ms),
  }));
  return {
    supported: true,
    scope: result.scope,
    days,
    ...(result.warning ? { warning: result.warning } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    rows,
  };
}

/** Who read one relation. Throws on a failed warehouse query. */
export async function tableReaders(
  params: JobHistoryTarget & {
    relation: { database?: string; schema: string; name: string };
  },
  deps: JobHistoryDeps = defaultJobHistoryDeps,
): Promise<
  WarehouseIntrospection<JobHistoryMeta & { rows: TableReaderRow[] }>
> {
  const target = await deps.resolveTarget(params);
  const driver = deps.getDriver(target.connection.type);
  if (!driver?.buildJobHistoryQuery) return unsupported(target.connection);

  const days = clampInteger(params.days, DEFAULT_DAYS, JOB_HISTORY_MAX_DAYS);
  const limit = clampInteger(
    params.limit,
    JOB_HISTORY_DEFAULT_LIMIT,
    JOB_HISTORY_MAX_LIMIT,
  );
  const result = await runWithScopeFallback(
    deps,
    driver,
    target.connection,
    "table_readers",
    { days, limit, relation: params.relation },
  );
  if (result === null) return unsupported(target.connection);

  const rows: TableReaderRow[] = result.rows.map(row => ({
    makoSource: text(row.mako_source),
    makoApp: text(row.mako_app),
    userEmail: String(row.user_email ?? ""),
    jobs: count(row.jobs),
    bytesBilled: count(row.bytes_billed),
    lastReadAt: String(row.last_read_at ?? ""),
    jobsByTextOnly: optionalCount(row.jobs_by_text_only),
  }));
  return {
    supported: true,
    scope: result.scope,
    days,
    ...(result.warning ? { warning: result.warning } : {}),
    notes: [
      "If this relation is a view, a read through another view is " +
        "invisible: the job names that other view. Check the readers of " +
        "every view built on this one.",
      "Jobs that write the relation and metadata queries are left out.",
    ],
    rows,
  };
}
