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
  type JobHistoryRegion,
  type JobHistoryRegionSource,
} from "../databases/driver";
import { databaseRegistry } from "../databases/registry";
import { resolveProdLikeEnvironmentName } from "../dbt/dbt-environments.service";
import { loggers } from "../logging";
import { sanitizeBigQueryLabelValue, withQueryLabels } from "./bigquery-labels";
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
  /** Stops the warehouse work when the caller goes away. */
  signal?: AbortSignal;
}

export interface JobHistoryMeta {
  /** "user" = fell back to jobs of the connection's own account. */
  scope: "project" | "user";
  days: number;
  /**
   * Set when the answer is partial: the missing permission and the grant
   * command on fallback, or a region that was guessed.
   */
  warning?: string;
  /** Limits of the answer that hold whatever the scope. */
  notes?: string[];
  /** The region whose job history was read, when the engine has regions. */
  region?: string;
  /**
   * Where `region` came from. "default" is a guess: the dataset's location
   * could not be read and the connection sets none, so an empty answer
   * proves nothing.
   */
  regionSource?: JobHistoryRegionSource;
}

/** Sums over the whole window, before the row cap. */
export interface ModelCostTotals {
  jobs: number;
  bytesBilled: number;
  slotMs: number;
}

export interface ModelCostResult extends JobHistoryMeta {
  /** Most expensive first: bytes billed, then slot milliseconds. */
  rows: ModelCostRow[];
  /** Model-day groups in the window. `rows` holds at most `limit` of them. */
  totalRows: number;
  totals: ModelCostTotals;
  /** True when `rows` is cut by `limit`. `totals` still cover everything. */
  truncated: boolean;
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
  /** The schema (dataset) the environment builds into. */
  targetSchema?: string;
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
  getDriver(type: string): DatabaseDriver | undefined;
  runQuery(
    connection: IDatabaseConnection,
    sql: string,
    signal?: AbortSignal,
  ): Promise<QueryOutcome>;
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
    targetSchema: environment.targetSchema,
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
  getDriver: type => databaseRegistry.getDriver(type),
  runQuery: (connection, sql, signal) =>
    // Labelled "metadata" so these lookups never count as readers themselves.
    withQueryLabels({ mako_source: "metadata" }, () =>
      databaseConnectionService.executeQuery(connection, sql, {
        readOnly: true,
        ...(signal ? { signal } : {}),
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

/**
 * Ids as the label values the writer stored (`dbtRunLabelEnv` sanitizes
 * with the same function), deduplicated. `dropped` counts the ids past the
 * most one query filters on.
 */
function uniqueLabelValues(values: string[]): {
  values: string[];
  dropped: number;
} {
  const unique = [...new Set(values.map(sanitizeBigQueryLabelValue))].filter(
    value => LABEL_VALUE.test(value),
  );
  return {
    values: unique.slice(0, JOB_HISTORY_MAX_IDS),
    dropped: Math.max(0, unique.length - JOB_HISTORY_MAX_IDS),
  };
}

/**
 * The region to read job history from, and what to say when it is a guess.
 * `datasets` are the datasets the question is about, most telling first.
 */
async function resolveRegion(
  driver: DatabaseDriver,
  connection: IDatabaseConnection,
  datasets: Array<{ database?: string; schema: string }>,
  signal?: AbortSignal,
): Promise<(JobHistoryRegion & { warning?: string }) | undefined> {
  if (!driver.resolveJobHistoryRegion) return undefined;
  const resolved = await driver.resolveJobHistoryRegion(connection, datasets, {
    signal,
  });
  if (resolved.source !== "default") return resolved;
  const asked = datasets
    .map(dataset =>
      dataset.database
        ? `${dataset.database}.${dataset.schema}`
        : dataset.schema,
    )
    .join(", ");
  return {
    ...resolved,
    warning:
      `The region of the job history is a guess (${resolved.region}): ` +
      (asked
        ? `the location of ${asked} could not be read`
        : "no dataset was given") +
      " and the connection sets no location. Jobs of another region are " +
      "invisible, so an empty answer proves nothing. Set the location on " +
      "the connection.",
  };
}

/** Both warnings in one string, the region one first. */
function joinWarnings(
  ...warnings: Array<string | undefined>
): string | undefined {
  const present = warnings.filter((warning): warning is string => !!warning);
  return present.length > 0 ? present.join(" ") : undefined;
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
  signal?: AbortSignal,
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
  const projectWide = await deps.runQuery(connection, projectSql, signal);
  // A stopped caller is not a denial: never start the second query.
  signal?.throwIfAborted();
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
  const own = await deps.runQuery(connection, userSql, signal);
  signal?.throwIfAborted();
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
 * Cost per model per day for Mako dbt runs of one environment. A warehouse
 * job counts when it carries the invocation id or the run id of one of that
 * environment's runs: both ids are unique across projects and workspaces,
 * so no other job, project or environment can add to the sum. `runId`
 * narrows to one run, `jobId` to one job. Throws on a failed warehouse
 * query.
 */
export async function modelCost(
  params: JobHistoryTarget & {
    jobId?: string;
    runId?: string;
    /** One model: a dbt unique_id (`model.project.name`) or a bare name. */
    model?: string;
  },
  deps: JobHistoryDeps = defaultJobHistoryDeps,
): Promise<WarehouseIntrospection<ModelCostResult>> {
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
  if (invocationIds.dropped > 0) {
    notes.push(
      `${invocationIds.dropped} invocation ids are past the ` +
        `${JOB_HISTORY_MAX_IDS} one query matches. Their jobs count only ` +
        "when the project's query comment sets the mako_dbt_run label.",
    );
  }
  const empty = {
    rows: [],
    totalRows: 0,
    totals: zeroTotals(),
    truncated: false,
  };
  if (makoRunIds.values.length === 0) {
    return {
      supported: true,
      scope: "project",
      days,
      ...empty,
      notes: [
        `No Mako dbt run in environment "${target.environment}" in the last ${days} days.`,
      ],
    };
  }

  // dbt runs its jobs where the environment's dataset lives.
  const region = await resolveRegion(
    driver,
    target.connection,
    target.targetSchema ? [{ schema: target.targetSchema }] : [],
    params.signal,
  );
  const result = await runWithScopeFallback(
    deps,
    driver,
    target.connection,
    "model_cost",
    {
      days,
      limit,
      ...(region ? { region: region.region } : {}),
      invocationIds: invocationIds.values,
      makoRunIds: makoRunIds.values,
      model: params.model,
    },
    params.signal,
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
  // Every row repeats the window totals, computed before the row cap.
  const first = result.rows[0];
  const totalRows = first ? count(first.total_rows) : 0;
  const warning = joinWarnings(region?.warning, result.warning);
  return {
    supported: true,
    scope: result.scope,
    days,
    ...(region ? { region: region.region, regionSource: region.source } : {}),
    ...(warning ? { warning } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    rows,
    totalRows,
    totals: first
      ? {
          jobs: count(first.total_jobs),
          bytesBilled: count(first.total_bytes_billed),
          slotMs: count(first.total_slot_ms),
        }
      : zeroTotals(),
    truncated: totalRows > rows.length,
  };
}

function zeroTotals(): ModelCostTotals {
  return { jobs: 0, bytesBilled: 0, slotMs: 0 };
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
  // A job that reads the relation runs where the relation's dataset lives.
  // Only that dataset is asked: the region of another one would be a guess
  // presented as a fact.
  const region = await resolveRegion(
    driver,
    target.connection,
    [{ database: params.relation.database, schema: params.relation.schema }],
    params.signal,
  );
  const result = await runWithScopeFallback(
    deps,
    driver,
    target.connection,
    "table_readers",
    {
      days,
      limit,
      ...(region ? { region: region.region } : {}),
      relation: params.relation,
    },
    params.signal,
  );
  if (result === null) return unsupported(target.connection);
  const warning = joinWarnings(region?.warning, result.warning);

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
    ...(region ? { region: region.region, regionSource: region.source } : {}),
    ...(warning ? { warning } : {}),
    notes: [
      "If this relation is a view, a read through another view is " +
        "invisible: the job names that other view. Check the readers of " +
        "every view built on this one.",
      "Jobs that write the relation and metadata queries are left out.",
    ],
    rows,
  };
}
