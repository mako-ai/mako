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
  readWorkspaceTenant,
  tenantJson,
  type RunStarter,
  tenantOfToken,
  type WorkspaceTenant,
} from "./hatchet";
import { type RunCost, readRunCosts } from "./costs";
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
  (run.additionalMetadata ?? {}) as { trigger?: string; startedBy?: string };

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

/**
 * Whether a deploy is over: the worker runs the wanted commit, or that commit
 * failed to build (the old code keeps running), or nothing was ever pushed.
 */
export function deploySettled({
  liveSha,
  targetSha,
  buildError,
}: ReturnType<typeof deployment>): boolean {
  return !targetSha || liveSha === targetSha || buildError !== null;
}

/** Just the deploy state, cheap to read again and again while waiting. */
export async function readDeployment(workspaceId: string) {
  const { state } = await loadState(workspaceId);
  return { deployment: deployment(state?.live), tree: state?.live?.tree };
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
    recentRuns: await withRunCosts(
      workspaceId,
      (runs.rows ?? []).map(run => runSummary(run)),
    ),
  };
}

/** Each run's AI cost beside it, for the runs that have one. */
async function withRunCosts<T extends { runId?: string }>(
  workspaceId: string,
  runs: T[],
): Promise<Array<T & { costUsd?: number }>> {
  const ids = runs.map(run => run.runId).filter((id): id is string => !!id);
  const costs = await readRunCosts(workspaceId, ids).catch(
    (): Record<string, RunCost> => ({}),
  );
  return runs.map(run => {
    const cost = run.runId ? costs[run.runId] : undefined;
    return cost ? { ...run, costUsd: cost.costUsd } : run;
  });
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

/**
 * What never changes about a run, once read: who started it and which
 * workflow it is a run of (lowercase, as Hatchet keeps step ids). With the
 * last time Hatchet said one of its tasks was waiting or executing.
 */
type KnownRun = { starter: RunStarter; workflow: string; activeAt?: number };

/** Runs looked up, by tenant and run. */
const knownRuns = new Map<string, KnownRun>();
const MAX_KNOWN_RUNS = 5000;
/** How long a run seen executing is taken as still executing. */
const ACTIVE_FOR_MS = 15_000;
/**
 * How long a run last seen executing is taken as still executing when
 * Hatchet does not answer: a short Hatchet outage does not refuse the writes
 * of a run in flight.
 */
const ACTIVE_WHEN_UNREADABLE_MS = 30 * 60_000;

/** A run or a task status that is waiting for, or doing, work. */
const ACTIVE_STATUSES = new Set(["QUEUED", "PENDING", "RUNNING"]);

/**
 * The workflow a run detail is of, lowercase: Hatchet keeps each step's id
 * as `<workflow>:<step>` lowercased; the run's `workflowName` as declared.
 */
export function workflowOfRunDetail(detail: RunDetail): string {
  for (const task of detail.tasks ?? []) {
    const name =
      String(task.actionId ?? "").split(":")[0] ||
      String(task.workflowName ?? "");
    if (name) return name.toLowerCase();
  }
  return String(detail.run?.workflowName ?? "").toLowerCase();
}

/**
 * Whether the run is executing now: the run waits or runs, or one of its
 * tasks does. An `onFailure` task runs while the run already shows FAILED.
 */
export function isRunExecuting(detail: RunDetail): boolean {
  if (ACTIVE_STATUSES.has(String(detail.run?.status ?? ""))) return true;
  return (detail.tasks ?? []).some(task =>
    ACTIVE_STATUSES.has(String(task.status ?? "")),
  );
}

function starterOf(run: Row): RunStarter {
  const { startedBy, trigger } = metadataOf(run);
  return startedBy === "agent" ||
    startedBy === "person" ||
    startedBy === "trigger"
    ? startedBy
    : trigger === "agent" || trigger === "api"
      ? "agent"
      : trigger === "ui"
        ? "person"
        : "trigger";
}

function remember(key: string, run: KnownRun) {
  if (!knownRuns.has(key) && knownRuns.size >= MAX_KNOWN_RUNS) {
    knownRuns.delete(knownRuns.keys().next().value as string);
  }
  knownRuns.set(key, run);
}

/** Forget every run looked up (tests). */
export function forgetKnownRunsForTests() {
  knownRuns.clear();
}

/**
 * Who started the workspace's run `runId` (hatchet.ts `RunStarter`), when
 * that run is a run of `workflow` and is executing now; else null, as when
 * Mako cannot tell (no run id, no tenant, a run the tenant does not have).
 *
 * The run is the one the worker names (X-Mako-Run), and deployed workflow
 * code holds the worker's key, so it could name another run: an old
 * scheduled run's, to write with that run's rights. So the run must be of
 * the workflow the request is for (X-Mako-Workflow, compared ignoring case)
 * and still executing: the run QUEUED, PENDING or RUNNING, or one of its
 * tasks so (an `onFailure` task runs while the run shows FAILED).
 *
 * Who started a run and its workflow never change: they are kept. Whether
 * it executes is asked again after ACTIVE_FOR_MS. When Hatchet does not
 * answer, a run seen executing within ACTIVE_WHEN_UNREADABLE_MS still is.
 * A run started before Mako kept `startedBy` is an agent's when its trigger
 * was an agent's tool or an API call, as those are now; a run with neither
 * (a schedule) is a trigger's.
 */
export async function runStartedBy(
  workspaceId: string,
  runId: string | undefined,
  workflow: string | undefined,
): Promise<RunStarter | null> {
  if (!runId || !isHatchetId(runId) || !workflow) return null;
  const tenant = await readWorkspaceTenant(workspaceId).catch(() => null);
  if (!tenant) return null;
  const key = `${tenant.tenantId}:${runId}`;
  const wanted = workflow.toLowerCase();
  const known = knownRuns.get(key);
  if (known && known.workflow !== wanted) return null;
  const now = Date.now();
  if (known?.activeAt !== undefined && now - known.activeAt < ACTIVE_FOR_MS) {
    return known.starter;
  }
  const detail = await readDetail(tenant, runId).catch(() => null);
  if (!detail?.run || idOf(detail.run) !== runId) {
    // Hatchet did not answer: a run seen executing a short while ago is
    // taken as still executing.
    return known?.activeAt !== undefined &&
      now - known.activeAt < ACTIVE_WHEN_UNREADABLE_MS
      ? known.starter
      : null;
  }
  const run: KnownRun = known ?? {
    starter: starterOf(detail.run),
    workflow: workflowOfRunDetail(detail),
  };
  if (isRunExecuting(detail)) run.activeAt = now;
  else delete run.activeAt;
  remember(key, run);
  return run.workflow === wanted && run.activeAt !== undefined
    ? run.starter
    : null;
}

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

/**
 * A deployed workflow's steps as its code defines them, from Hatchet's latest
 * version of it: each step with the steps it waits for, its retries and its
 * timeout. The flow before any run, or the same for every run.
 */
export async function readWorkflowFlow(tenant: WorkspaceTenant, name: string) {
  const list = await tenantJson<Rows>(
    tenant,
    `/api/v1/tenants/${tenant.tenantId}/workflows`,
  );
  const id = idOf((list.rows ?? []).find(row => row.name === name) ?? {});
  if (!id || !isHatchetId(id)) {
    throw new HatchetError(`"${name}" is not deployed`, 404);
  }
  const version = await tenantJson<{
    workflowConfig?: {
      Tasks?: Array<{
        ReadableId?: string;
        Parents?: string[];
        Retries?: number;
        Timeout?: string;
      }>;
    };
  }>(tenant, `/api/v1/workflows/${id}/versions`);
  return {
    workflowId: name,
    steps: (version.workflowConfig?.Tasks ?? []).map(task => ({
      step: String(task.ReadableId),
      parents: task.Parents ?? [],
      retries: task.Retries ?? 0,
      timeout: task.Timeout,
    })),
  };
}
