/**
 * What a screen or an agent sees of a workspace's workflows: what is deployed
 * (the deploy state on the workspace, kept by on-push.ts and the worker's
 * reports) and the workflows, schedules and runs, read from Hatchet as the
 * workspace's tenant and trimmed. Shared by routes/workflows.ts and
 * agent-lib/tools/workflow-tools.ts, so both show the same thing.
 */
import {
  type IWorkflowSlot,
  type IWorkspaceWorkflows,
  Workspace,
} from "../database/workspace-schema";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import {
  HatchetError,
  hasInstanceHatchet,
  isHatchetId,
  tenantJson,
  tenantOfToken,
  type WorkspaceTenant,
} from "./hatchet";
import { webhookUrls } from "./webhook";

export const RECENT_RUNS_DAYS = 30;

/**
 * How much of a run is shown. By default a summary a model can read in one
 * go: the start of each text and a step's last log lines. `full` is the run
 * as it was kept: each text up to a megabyte, every log line.
 */
type Limits = { chars: number; lines: number; stackLines: number };
const SUMMARY: Limits = { chars: 2000, lines: 20, stackLines: 3 };
export const FULL_TEXT_CHARS = 1_000_000;
const FULL: Limits = {
  chars: FULL_TEXT_CHARS,
  lines: Number.POSITIVE_INFINITY,
  stackLines: Number.POSITIVE_INFINITY,
};
export type ShapeOptions = { full?: boolean };
/** The most log lines read of one step. */
const MAX_LOG_LINES = 10_000;
const limitsOf = (options: ShapeOptions = {}) =>
  options.full ? FULL : SUMMARY;

type Row = Record<string, unknown>;
type Rows = { rows?: Row[] };

/** A value as text, cut at `max` characters with a note of its length. */
export const cap = (
  value: unknown,
  max = SUMMARY.chars,
): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max
    ? `${text.slice(0, max)}… (${text.length} chars)`
    : text;
};

/**
 * A log line's time. Parsed, not compared as text: Hatchet writes fractions
 * of a second at varying lengths (`45.96` and `45.960647`).
 */
const timeOf = (row: Row) => Date.parse(String(row.createdAt ?? "")) || 0;

const idOf = (row: Row): string | undefined =>
  (row.metadata as { id?: string } | undefined)?.id;

/**
 * Hatchet reports a step's error as JSON, `{ message, stack }`. The message
 * is what an agent needs; the stack's first lines say where.
 */
function errorOf(value: unknown, limits: Limits = SUMMARY): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as { message?: string; stack?: string };
    if (parsed.message) {
      const where = (parsed.stack ?? "")
        .split("\n")
        .slice(1, 1 + limits.stackLines)
        .join("\n");
      return cap(
        `${parsed.message.trim()}${where ? `\n${where}` : ""}`,
        limits.chars,
      );
    }
  } catch {
    // Not JSON: use it as it is.
  }
  return cap(value, limits.chars);
}

/** A one-step run reports Hatchet's envelope around the input; unwrap it. */
function inputOf(value: unknown): unknown {
  const envelope = value as { input?: unknown; triggered_by?: unknown } | null;
  return envelope && "triggered_by" in envelope ? envelope.input : value;
}

const metadataOf = (run: Row) =>
  (run.additionalMetadata ?? {}) as { trigger?: string };

const runSummary = (
  run: Row,
  workflowName: unknown = run.workflowName,
  limits: Limits = SUMMARY,
) => ({
  runId: idOf(run),
  workflowId: String(workflowName ?? ""),
  status: run.status,
  startedAt: run.startedAt ?? run.createdAt,
  durationMs: run.duration,
  error: errorOf(run.errorMessage, limits),
  // Set by Mako when a person or an agent starts the run; a scheduled run
  // has neither.
  trigger: metadataOf(run).trigger,
});

/** What a screen shows of one slot. */
export function deployment(slot?: IWorkflowSlot) {
  return {
    /** The commit the worker reports running. Null before the first good deploy. */
    liveSha: slot?.running?.sha ?? null,
    /** The commit the worker should run. Differs from live until it switches. */
    targetSha: slot?.sha ?? null,
    /** The build output when the wanted commit could not be started. */
    buildError:
      slot && slot.failed?.sha === slot.sha ? slot.failed.error : null,
  };
}

function statusOf(state: IWorkspaceWorkflows | undefined, repoLinked: boolean) {
  return {
    // Workflows are files in the workspace's repository; without one linked
    // there is nowhere to write them, and the screen says so.
    repoLinked,
    // False when no Hatchet token exists for this workspace and the
    // installation has none to share: the UI hides Workflows.
    configured: Boolean(state?.hatchetToken) || hasInstanceHatchet(),
    deployment: deployment(state?.live),
    dashboardUrl: process.env.HATCHET_DASHBOARD_URL ?? null,
  };
}

export async function loadState(workspaceId: string) {
  const [workspace, repo] = await Promise.all([
    Workspace.findById(workspaceId).select("workflows").lean(),
    getWorkspaceRepo(workspaceId),
  ]);
  return { state: workspace?.workflows, repoLinked: Boolean(repo) };
}

/**
 * Everything a screen or an agent shows first: what is deployed, the
 * workflows and schedules, and the last `limit` runs.
 */
export async function readWorkflowsOverview(
  workspaceId: string,
  limit: number,
  /** For an admin: the switches, and each workflow's webhook URL (null when off). */
  asAdmin = false,
) {
  const { state, repoLinked } = await loadState(workspaceId);
  const status = { ...statusOf(state, repoLinked), mayChange: asAdmin };
  const tenant = tenantOfToken(state?.hatchetToken);
  if (!tenant) return status;
  const webhooks = asAdmin ? webhookUrls(workspaceId, state?.webhooks) : null;
  const base = `/api/v1/tenants/${tenant.tenantId}`;
  const since = new Date(Date.now() - RECENT_RUNS_DAYS * 864e5).toISOString();
  const [crons, runs] = await Promise.all([
    tenantJson<Rows>(tenant, `${base}/workflows/crons`),
    tenantJson<Rows>(
      tenant,
      `/api/v1/stable/tenants/${tenant.tenantId}/workflow-runs`,
      {
        query: new URLSearchParams({
          since,
          only_tasks: "false",
          limit: String(limit),
        }),
      },
    ),
  ]);
  const active = new Set(state?.active ?? []);
  // What is deployed is what the repository held at the deploy: a workflow
  // Hatchet still knows from an earlier commit is not one.
  const deployed = state?.live?.names ?? [];
  return {
    ...status,
    workflows: deployed.map(workflowId => ({
      workflowId,
      active: active.has(workflowId),
      ...(webhooks ? { webhookUrl: webhooks[workflowId] ?? null } : {}),
    })),
    schedules: (crons.rows ?? []).map(c => ({
      workflowId: c.workflowName,
      cron: c.cron,
    })),
    recentRuns: (runs.rows ?? []).map(run => runSummary(run)),
  };
}

/** What Hatchet returns for one run, and its tasks' log lines by task id. */
export type RunDetail = { run?: Row; tasks?: Row[] };

/**
 * One run as a screen or an agent reads it: its steps in order, each with
 * status, output, error and its last log lines. Pure, so the same shape comes
 * from the workspace's Hatchet and from a sandbox's own engine (sandbox.ts).
 */
export function shapeRun(
  detail: RunDetail,
  logs: Record<string, Row[]>,
  options: ShapeOptions = {},
) {
  const limits = limitsOf(options);
  // A step's `actionId` is `<workflow>:<step>`; Hatchet lists steps in no order.
  const tasks = [...(detail.tasks ?? [])].sort((a, b) =>
    String(a.taskInsertedAt ?? "").localeCompare(
      String(b.taskInsertedAt ?? ""),
    ),
  );
  const nameOf = (task: Row | undefined, part: 0 | 1) =>
    String(task?.actionId ?? "").split(":")[part];
  return {
    ...runSummary(detail.run ?? {}, nameOf(tasks[0], 0), limits),
    input: cap(inputOf(detail.run?.input), limits.chars),
    output: cap(detail.run?.output, limits.chars),
    steps: tasks.map(task => {
      // Hatchet lists log lines in no order; by time, oldest first.
      const lines = [...(logs[idOf(task) ?? ""] ?? [])].sort(
        (a, b) => timeOf(a) - timeOf(b),
      );
      const shown = Number.isFinite(limits.lines)
        ? lines.slice(-limits.lines)
        : lines;
      return {
        step: nameOf(task, 1) || task.displayName,
        status: task.status,
        attempt: task.attempt,
        durationMs: task.duration,
        output: cap(task.output, limits.chars),
        error: errorOf(task.errorMessage, limits),
        logs: shown.map(line => cap(line.message, limits.chars)),
        // Said when lines were left out, so a reader knows to ask for them.
        ...(shown.length < lines.length
          ? { logLinesOmitted: lines.length - shown.length }
          : {}),
      };
    }),
  };
}

/** One run of the workspace's Hatchet. */
export async function readRun(
  tenant: WorkspaceTenant,
  runId: string,
  options: ShapeOptions = {},
) {
  if (!isHatchetId(runId)) throw new HatchetError("Invalid run id", 400);
  const detail = await tenantJson<RunDetail>(
    tenant,
    `/api/v1/stable/workflow-runs/${runId}`,
  );
  const logs: Record<string, Row[]> = {};
  await Promise.all(
    (detail.tasks ?? []).map(async task => {
      const taskId = idOf(task);
      if (!taskId) return;
      // Hatchet answers 50 lines unless asked for more, in no order: all of
      // them, so the last ones are the last.
      logs[taskId] = await tenantJson<Rows>(
        tenant,
        `/api/v1/stable/tasks/${taskId}/logs`,
        { query: new URLSearchParams({ limit: String(MAX_LOG_LINES) }) },
      )
        .then(l => l.rows ?? [])
        .catch(() => []);
    }),
  );
  return shapeRun(detail, logs, options);
}

/** A run's status when it has not ended yet. */
export const ACTIVE_STATUSES: readonly unknown[] = [
  "QUEUED",
  "RUNNING",
  "PENDING",
];
export const isRunActive = (run: { status?: unknown }) =>
  ACTIVE_STATUSES.includes(run.status);
