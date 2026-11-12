// Owner: WP4 (MCP and REST surface). Stub: the signatures are the contract.
import type {
  DbtRunStatus,
  IDbtRun,
  IDbtRunOverrides,
} from "../database/workspace-schema";

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

export interface DbtRunHistoryPage {
  runs: DbtRunSummary[];
  /** `createdAt` of the last row, or null on the last page. */
  nextBefore: string | null;
  /** Present when `jobId` is set: scheduled ticks dropped for that job. */
  skipped?: { count: number; lastAt?: string };
}

/** Newest first. Never loads `logs` or `stepResults` bodies. */
export async function listDbtRuns(
  params: ListDbtRunsParams,
): Promise<DbtRunHistoryPage> {
  void params;
  throw new Error("not implemented");
}
