/**
 * dbt run history: one paged, filtered read of a project's runs, shared by
 * the `dbt_list_runs` agent tool (compact summaries) and the REST run list
 * (full run rows for the Runs view).
 *
 * Paging is a `createdAt` cursor on the two existing indexes
 * (`{workspaceId, projectId, createdAt}` and `{jobId, createdAt}`), so a page
 * costs the same at any depth. Retention bounds the history
 * (`DBT_RUN_RETENTION_DAYS`).
 */
import { Types, type QueryFilter } from "mongoose";
import {
  DbtJob,
  DbtRun,
  type DbtRunLane,
  type DbtRunStatus,
  type IDbtRun,
  type IDbtRunOverrides,
} from "../database/workspace-schema";
import { reconcileStaleQueuedRuns } from "./dbt-run.service";

export const DBT_RUN_LIST_DEFAULT_LIMIT = 20;
export const DBT_RUN_LIST_MAX_LIMIT = 100;
/** Characters of `run.error` a summary carries. */
export const DBT_RUN_ERROR_SUMMARY_CHARS = 300;

export const DBT_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "error",
  "cancelled",
] as const satisfies readonly DbtRunStatus[];

export const DBT_RUN_TRIGGERS = [
  "schedule",
  "manual",
  "agent",
  "ci",
] as const satisfies readonly IDbtRun["trigger"][];

export interface ListDbtRunsParams {
  workspaceId: string;
  projectId: string;
  jobId?: string;
  status?: DbtRunStatus;
  trigger?: IDbtRun["trigger"];
  /** Default 20, max 100. */
  limit?: number;
  /** Cursor: only runs created strictly before this instant. */
  before?: Date;
}

export interface DbtRunSummary {
  runId: string;
  jobId?: string;
  jobName?: string;
  status: DbtRunStatus;
  trigger: IDbtRun["trigger"];
  environment: string;
  commands: string[];
  overrides?: IDbtRunOverrides;
  sourceSha?: string;
  /** Commit the job yml was read from; unset when the job row was used. */
  definitionSha?: string;
  /** Set on validation runs ("interactive"); unset means the job lane. */
  lane?: DbtRunLane;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  queuedMs?: number;
  /** First 300 characters. */
  error?: string;
  /** Step count per dbt status, e.g. { success: 40, error: 1 }. */
  stepCounts: Record<string, number>;
}

export interface DbtRunSkippedTicks {
  count: number;
  lastAt?: string;
  /** Why the last tick was skipped (`DbtSkippedTickReason`). */
  lastReason?: string;
}

export interface DbtRunHistoryPage {
  runs: DbtRunSummary[];
  /** `createdAt` of the last row, or null on the last page. */
  nextBefore: string | null;
  /** Present when `jobId` is set: scheduled ticks that started no run. */
  skipped?: DbtRunSkippedTicks;
}

/** Clamp a caller-supplied page size to 1..max; junk falls back. */
export function clampDbtRunListLimit(
  limit: number | undefined,
  fallback: number = DBT_RUN_LIST_DEFAULT_LIMIT,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), DBT_RUN_LIST_MAX_LIMIT);
}

/** The run fields a page row needs, whichever projection loaded it. */
type RunRow = Pick<
  IDbtRun,
  | "_id"
  | "projectId"
  | "jobId"
  | "environment"
  | "commands"
  | "status"
  | "trigger"
  | "overrides"
  | "sourceSha"
  | "definitionSha"
  | "lane"
  | "startedAt"
  | "completedAt"
  | "durationMs"
  | "error"
> & {
  createdAt: Date;
  stepResults?: Array<{ status?: string }>;
};

function objectId(value: string, label: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw new Error(`Invalid ${label}`);
  return new Types.ObjectId(value);
}

function buildFilter(params: ListDbtRunsParams): QueryFilter<IDbtRun> {
  const filter: QueryFilter<IDbtRun> = {
    workspaceId: objectId(params.workspaceId, "workspace id"),
    projectId: objectId(params.projectId, "dbt project id"),
  };
  if (params.jobId) filter.jobId = objectId(params.jobId, "job id");
  if (params.status) filter.status = params.status;
  if (params.trigger) filter.trigger = params.trigger;
  if (params.before) {
    if (Number.isNaN(params.before.getTime())) {
      throw new Error("Invalid before cursor");
    }
    filter.createdAt = { $lt: params.before };
  }
  return filter;
}

/**
 * One page, newest first. Reads one row past the page to learn whether an
 * older page exists, so `nextBefore` is null exactly on the last page.
 */
async function findRunPage(
  params: ListDbtRunsParams,
  projection: string,
  defaultLimit: number,
): Promise<{ rows: RunRow[]; nextBefore: string | null }> {
  const limit = clampDbtRunListLimit(params.limit, defaultLimit);
  const found = (await DbtRun.find(buildFilter(params))
    .select(projection)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .lean()) as unknown as RunRow[];
  const rows = found.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextBefore =
    found.length > limit && last ? toIso(last.createdAt) : null;
  // A run stuck in "queued" past the pickup deadline reads as errored, the
  // same as the run detail. Read-only: the cron sweeper is the single writer.
  const reconciled = await reconcileStaleQueuedRuns(rows, { persist: false });
  return { rows: reconciled, nextBefore };
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** Scheduled ticks of this job that started no run, and the last reason. */
async function readSkippedTicks(
  params: ListDbtRunsParams,
): Promise<DbtRunSkippedTicks | undefined> {
  if (!params.jobId) return undefined;
  const job = await DbtJob.findOne({
    _id: objectId(params.jobId, "job id"),
    workspaceId: objectId(params.workspaceId, "workspace id"),
    projectId: objectId(params.projectId, "dbt project id"),
  })
    .select(
      "scheduledRun.skippedCount scheduledRun.lastSkippedAt scheduledRun.lastSkippedReason",
    )
    .lean();
  const lastAt = job?.scheduledRun?.lastSkippedAt;
  const lastReason = job?.scheduledRun?.lastSkippedReason;
  return {
    count: job?.scheduledRun?.skippedCount ?? 0,
    ...(lastAt ? { lastAt: toIso(lastAt) } : {}),
    ...(lastReason ? { lastReason } : {}),
  };
}

async function loadJobNames(
  workspaceId: string,
  rows: RunRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap(row => row.jobId?.toString() ?? []))];
  if (ids.length === 0) return new Map();
  const jobs = await DbtJob.find({
    workspaceId: objectId(workspaceId, "workspace id"),
    _id: { $in: ids.map(id => new Types.ObjectId(id)) },
  })
    .select("name")
    .lean();
  return new Map(jobs.map(job => [job._id.toString(), job.name]));
}

function countSteps(row: RunRow): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of row.stepResults ?? []) {
    const status = step.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function summarize(row: RunRow, jobNames: Map<string, string>): DbtRunSummary {
  const jobId = row.jobId?.toString();
  const jobName = jobId ? jobNames.get(jobId) : undefined;
  const queuedMs = row.startedAt
    ? Math.max(
        new Date(row.startedAt).getTime() - new Date(row.createdAt).getTime(),
        0,
      )
    : undefined;
  return {
    runId: row._id.toString(),
    ...(jobId ? { jobId } : {}),
    ...(jobName ? { jobName } : {}),
    status: row.status,
    trigger: row.trigger,
    environment: row.environment,
    commands: row.commands,
    ...(row.overrides ? { overrides: row.overrides } : {}),
    ...(row.sourceSha ? { sourceSha: row.sourceSha } : {}),
    ...(row.definitionSha ? { definitionSha: row.definitionSha } : {}),
    ...(row.lane ? { lane: row.lane } : {}),
    createdAt: toIso(row.createdAt),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    ...(queuedMs !== undefined ? { queuedMs } : {}),
    ...(row.error
      ? { error: row.error.slice(0, DBT_RUN_ERROR_SUMMARY_CHARS) }
      : {}),
    stepCounts: countSteps(row),
  };
}

const SUMMARY_PROJECTION = [
  "projectId",
  "jobId",
  "environment",
  "commands",
  "status",
  "trigger",
  "overrides",
  "sourceSha",
  "definitionSha",
  "lane",
  "createdAt",
  "startedAt",
  "completedAt",
  "durationMs",
  "error",
  // Statuses only: enough for the counts, never the step bodies.
  "stepResults.status",
].join(" ");

/** Newest first. Never loads `logs` or `stepResults` bodies. */
export async function listDbtRuns(
  params: ListDbtRunsParams,
): Promise<DbtRunHistoryPage> {
  const [{ rows, nextBefore }, skipped] = await Promise.all([
    findRunPage(params, SUMMARY_PROJECTION, DBT_RUN_LIST_DEFAULT_LIMIT),
    readSkippedTicks(params),
  ]);
  const jobNames = await loadJobNames(params.workspaceId, rows);
  return {
    runs: rows.map(row => summarize(row, jobNames)),
    nextBefore,
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * The REST run list: the same filters and cursor, but whole run rows (minus
 * `logs`) because the Runs view renders step results from the list.
 */
export async function listDbtRunRows(
  params: ListDbtRunsParams,
  options: { defaultLimit?: number } = {},
): Promise<{
  runs: unknown[];
  nextBefore: string | null;
  skipped?: DbtRunSkippedTicks;
}> {
  const [{ rows, nextBefore }, skipped] = await Promise.all([
    findRunPage(
      params,
      "-logs",
      options.defaultLimit ?? DBT_RUN_LIST_DEFAULT_LIMIT,
    ),
    readSkippedTicks(params),
  ]);
  return { runs: rows, nextBefore, ...(skipped ? { skipped } : {}) };
}
