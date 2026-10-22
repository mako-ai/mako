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

const RECENT_RUNS_DAYS = 30;
const LOG_LINES_PER_STEP = 20;
/** The screen's whole log: a step's newest lines, up to this many. */
const FULL_LOG_LINES = 5000;
const MAX_TEXT_CHARS = 2000;

type Row = Record<string, unknown>;
type Rows = { rows?: Row[] };

const cap = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}… (${text.length} chars)`
    : text;
};

const idOf = (row: Row): string | undefined =>
  (row.metadata as { id?: string } | undefined)?.id;

/**
 * Hatchet reports a step's error as JSON, `{ message, stack }`. The message
 * is what an agent needs; the stack's first lines say where.
 */
function errorOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as { message?: string; stack?: string };
    if (parsed.message) {
      const where = (parsed.stack ?? "").split("\n").slice(1, 4).join("\n");
      return cap(`${parsed.message.trim()}${where ? `\n${where}` : ""}`);
    }
  } catch {
    // Not JSON: use it as it is.
  }
  return cap(value);
}

/** A one-step run reports Hatchet's envelope around the input; unwrap it. */
function inputOf(value: unknown): unknown {
  const envelope = value as { input?: unknown; triggered_by?: unknown } | null;
  return envelope && "triggered_by" in envelope ? envelope.input : value;
}

const metadataOf = (run: Row) =>
  (run.additionalMetadata ?? {}) as { trigger?: string };

const runSummary = (run: Row, workflowName: unknown = run.workflowName) => ({
  runId: idOf(run),
  workflowId: String(workflowName ?? ""),
  status: run.status,
  startedAt: run.startedAt ?? run.createdAt,
  durationMs: run.duration,
  error: errorOf(run.errorMessage),
  // Set by Mako when a person or an agent starts the run; a scheduled run
  // has neither.
  trigger: metadataOf(run).trigger,
});

/** What a screen shows of one slot. */
function deployment(slot?: IWorkflowSlot) {
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

async function loadState(workspaceId: string) {
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
  const active = new Set(state?.active ?? []);
  // What is deployed is what the repository held at the deploy: a workflow
  // Hatchet still knows from an earlier commit is not one.
  const deployed = state?.live?.names ?? [];
  const workflows = deployed.map(workflowId => ({
    workflowId,
    active: active.has(workflowId),
    ...(webhooks ? { webhookUrl: webhooks[workflowId] ?? null } : {}),
  }));
  let crons: Rows;
  let runs: Rows;
  try {
    [crons, runs] = await Promise.all([
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
  } catch (error) {
    // The workspace's tenant did not answer (unreachable, or a token for a
    // tenant this Hatchet does not have): say so beside what is deployed,
    // rather than failing the whole overview and hiding Workflows.
    if (!(error instanceof HatchetError)) throw error;
    return {
      ...status,
      hatchetError: `Mako could not read this workspace's Hatchet tenant: ${error.message.trim()}`,
      workflows,
      schedules: [],
      recentRuns: [],
    };
  }
  return {
    ...status,
    workflows,
    schedules: (crons.rows ?? []).map(c => ({
      workflowId: c.workflowName,
      cron: c.cron,
    })),
    recentRuns: (runs.rows ?? []).map(run => runSummary(run)),
  };
}

/**
 * What Hatchet returns for one run. `shape` is its steps' graph: each step
 * with the steps that wait for it.
 */
export type RunDetail = {
  run?: Row;
  tasks?: Row[];
  shape?: Array<{
    stepId?: string;
    taskName?: string;
    childrenStepIds?: string[];
  }>;
};

/**
 * One run as a screen or an agent reads it: its steps in order, each with
 * the steps it waited for, status, output, error and its last log lines
 * (every line with `full`). Pure, so the same shape comes from the
 * workspace's Hatchet and from a sandbox's own engine (sandbox.ts).
 */
export function shapeRun(
  detail: RunDetail,
  logs: Record<string, Row[]>,
  { full = false }: { full?: boolean } = {},
) {
  // A step's `actionId` is `<workflow>:<step>`; Hatchet lists steps in no order.
  const tasks = [...(detail.tasks ?? [])].sort((a, b) =>
    String(a.taskInsertedAt ?? "").localeCompare(
      String(b.taskInsertedAt ?? ""),
    ),
  );
  const nameOf = (task: Row | undefined, part: 0 | 1) =>
    String(task?.actionId ?? "").split(":")[part];
  const stepName = (task: Row) => nameOf(task, 1) || String(task.displayName);
  const nameByStepId = new Map([
    ...(detail.shape ?? []).map(
      node => [String(node.stepId), String(node.taskName)] as const,
    ),
    ...tasks.map(task => [String(task.stepId), stepName(task)] as const),
  ]);
  const parentsOf = (stepId: unknown) =>
    (detail.shape ?? [])
      .filter(node => node.childrenStepIds?.includes(String(stepId)))
      .map(node => nameByStepId.get(String(node.stepId)))
      .filter((name): name is string => Boolean(name));
  // Hatchet lists a step once it starts; the run's graph has the rest, which
  // wait for the steps before them.
  const started = new Set(tasks.map(task => String(task.stepId)));
  const waiting = (detail.shape ?? [])
    .filter(node => node.stepId && !started.has(String(node.stepId)))
    .map(node => ({
      step: String(node.taskName),
      parents: parentsOf(node.stepId),
      status: "WAITING" as unknown,
      attempt: undefined as unknown,
      durationMs: undefined as unknown,
      output: undefined as string | undefined,
      error: undefined as string | undefined,
      logs: [] as Array<string | undefined>,
    }));
  return {
    ...runSummary(detail.run ?? {}, nameOf(tasks[0], 0)),
    input: cap(inputOf(detail.run?.input)),
    output: cap(detail.run?.output),
    steps: [
      ...tasks.map(task => ({
        step: stepName(task),
        parents: parentsOf(task.stepId),
        status: task.status,
        attempt: task.attempt,
        durationMs: task.duration,
        output: cap(task.output),
        error: errorOf(task.errorMessage),
        logs: (logs[idOf(task) ?? ""] ?? [])
          .slice(full ? 0 : -LOG_LINES_PER_STEP)
          .map(line => cap(line.message)),
      })),
      ...waiting,
    ],
  };
}

const readDetail = (tenant: WorkspaceTenant, runId: string) => {
  if (!isHatchetId(runId)) throw new HatchetError("Invalid run id", 400);
  return tenantJson<RunDetail>(tenant, `/api/v1/stable/workflow-runs/${runId}`);
};

/** One run of the workspace's Hatchet; `full` keeps every log line. */
export async function readRun(
  tenant: WorkspaceTenant,
  runId: string,
  { full = false }: { full?: boolean } = {},
) {
  const detail = await readDetail(tenant, runId);
  const logs: Record<string, Row[]> = {};
  await Promise.all(
    (detail.tasks ?? []).map(async task => {
      const taskId = idOf(task);
      if (!taskId) return;
      // Hatchet answers the oldest 50 lines of every attempt unless asked:
      // ask for the newest lines of the step's last attempt, then put them
      // back in order.
      const query = new URLSearchParams({
        limit: String(full ? FULL_LOG_LINES : LOG_LINES_PER_STEP),
        order_by_direction: "DESC",
      });
      if (typeof task.attempt === "number") {
        query.set("attempt", String(task.attempt));
      }
      logs[taskId] = await tenantJson<Rows>(
        tenant,
        `/api/v1/stable/tasks/${taskId}/logs`,
        { query },
      )
        .then(l => (l.rows ?? []).reverse())
        .catch(() => []);
    }),
  );
  return shapeRun(detail, logs, { full });
}

/**
 * Retry a run in place (Hatchet's replay). With `step`: that step and the
 * steps after it run again, on the outputs the steps before it kept. Without:
 * the whole run, from its first step.
 */
export async function retryRun(
  tenant: WorkspaceTenant,
  runId: string,
  step?: string,
) {
  let id = runId;
  if (step) {
    const detail = await readDetail(tenant, runId);
    const task = (detail.tasks ?? []).find(
      t =>
        String(t.actionId ?? "").split(":")[1] === step ||
        t.displayName === step,
    );
    if (!task) throw new HatchetError(`No step "${step}" in this run`, 404);
    if (isActiveRun(task.status)) {
      throw new HatchetError(`Step "${step}" is still running`, 409);
    }
    id = String(task.taskExternalId ?? idOf(task));
  } else if (!isHatchetId(runId)) {
    throw new HatchetError("Invalid run id", 400);
  }
  await tenantJson(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/tasks/replay`,
    { method: "POST", body: { externalIds: [id] } },
  );
  return { runId };
}

const isActiveRun = (status: unknown) =>
  status === "QUEUED" || status === "RUNNING";
