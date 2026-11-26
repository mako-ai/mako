/**
 * What a screen or an agent sees of a workspace's workflows: what is deployed
 * (the deploy state on the workspace, kept by on-push.ts and the worker's
 * reports) and the workflows, schedules and runs, read from Hatchet as the
 * workspace's tenant and trimmed. Shared by routes/workflows.ts and
 * agent-lib/tools/workflow-tools.ts, so both show the same thing.
 */
import {
  workspaceRepo,
  type WorkflowSlot,
  type WorkspaceWorkflows,
} from "../repositories/workspaces";
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
/** More workflows than a tenant holds, previews and earlier commits included. */
const KNOWN_WORKFLOWS = 1000;
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
  (run.additionalMetadata ?? {}) as {
    trigger?: string;
    startedBy?: string;
    dryRun?: unknown;
  };

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

/**
 * Every workflow the tenant knows, with its id. Hatchet answers 50 a page
 * unless asked for more, and keeps the workflows of earlier commits: one
 * past the first page would have no id, and so no runs and no flow.
 */
const knownWorkflows = (tenant: WorkspaceTenant) =>
  tenantJson<Rows>(tenant, `/api/v1/tenants/${tenant.tenantId}/workflows`, {
    query: new URLSearchParams({ limit: String(KNOWN_WORKFLOWS) }),
  });

/** What a screen shows of one slot. */
function deployment(slot?: WorkflowSlot) {
  return {
    /** The commit the worker reports running. Null before the first good deploy. */
    liveSha: slot?.running?.sha ?? null,
    /** The commit the worker should run. Differs from live until it switches. */
    targetSha: slot?.sha ?? null,
    /** The build output when the wanted commit could not be started. */
    buildError:
      slot?.sha && slot.failed?.sha === slot.sha
        ? (slot.failed.error ?? null)
        : null,
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

function statusOf(state: WorkspaceWorkflows | undefined, repoLinked: boolean) {
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
    workspaceRepo.findById(workspaceId),
    getWorkspaceRepo(workspaceId),
  ]);
  return { state: workspace?.workflows, repoLinked: Boolean(repo) };
}

/**
 * Everything a screen or an agent shows first: what is deployed, the
 * workflows and schedules, and the workspace's last `limit` runs, whichever
 * workflows they are of. One workflow's own runs: `readWorkflowRuns`.
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
      await settleOpenRuns(
        tenant,
        (runs.rows ?? []).map(run => runSummary(run)),
      ),
    ),
  };
}

/**
 * One workflow's own last `limit` runs, newest first. Asked of Hatchet for
 * that workflow alone: the workspace's last runs are those of whichever
 * workflow runs most often, and one that runs every few minutes leaves none
 * of a weekly one's. A workflow Hatchet does not know (never deployed) has
 * none.
 */
export async function listWorkflowRuns(
  tenant: WorkspaceTenant,
  name: string,
  limit: number,
) {
  const known = await knownWorkflows(tenant);
  const id = idOf((known.rows ?? []).find(row => row.name === name) ?? {});
  if (!id || !isHatchetId(id)) return [];
  const since = new Date(Date.now() - RECENT_RUNS_DAYS * 864e5).toISOString();
  const runs = await tenantJson<Rows>(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/workflow-runs`,
    {
      query: new URLSearchParams({
        since,
        only_tasks: "false",
        limit: String(limit),
        workflow_ids: id,
      }),
    },
  );
  return settleOpenRuns(
    tenant,
    (runs.rows ?? []).map(run => runSummary(run, name)),
  );
}

/** `listWorkflowRuns`, each run with its AI cost. */
export async function readWorkflowRuns(
  workspaceId: string,
  tenant: WorkspaceTenant,
  name: string,
  limit: number,
) {
  return {
    workflowId: name,
    runs: await withRunCosts(
      workspaceId,
      await listWorkflowRuns(tenant, name, limit),
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

// --- Runs Hatchet left open ---------------------------------------------------
//
// Hatchet keeps a run's status apart from its steps', and can lose the last
// update: when it restarts mid-run, and under a burst (seen on 2026-11-16,
// and in every stage of deploy/workflows/loadtest). Such a run shows RUNNING
// or QUEUED for good while every step of it has ended, and Hatchet's own
// cancel does nothing to it, having no step left to cancel. Mako reads how
// it ended from its steps.

/** A run whose steps all ended this long ago is no longer between two steps. */
const SETTLED_AFTER_MS = 10 * 60_000;
/** Open runs looked at per list: the rest keep Hatchet's status until the next one. */
const MAX_SETTLE_READS = 50;
const MAX_SETTLED = 5000;
const settled = new Map<string, string>();

const timeOf = (value: unknown): number => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * How a run ended, when Hatchet still shows it open and it is not: none of
 * its steps is queued or running, and the last one ended more than
 * SETTLED_AFTER_MS ago. FAILED when a step failed, else CANCELLED when one
 * was cancelled or never started, else COMPLETED. Null for a run that is
 * open (or closed) as Hatchet says.
 */
export function endedStatusOf(
  detail: RunDetail,
  now = Date.now(),
): "FAILED" | "CANCELLED" | "COMPLETED" | null {
  if (!ACTIVE_STATUSES.has(String(detail.run?.status ?? ""))) return null;
  const tasks = detail.tasks ?? [];
  // No step yet: the run waits its turn (a concurrency limit, a worker).
  if (tasks.length === 0) return null;
  const statuses = tasks.map(task => String(task.status ?? ""));
  if (statuses.some(status => ACTIVE_STATUSES.has(status))) return null;
  const lastChange = Math.max(
    ...tasks.map(task =>
      Math.max(
        timeOf(task.finishedAt),
        timeOf(task.startedAt),
        timeOf(task.taskInsertedAt),
        timeOf(task.createdAt),
      ),
    ),
  );
  // Without a time to go by, nothing is concluded.
  if (!lastChange || now - lastChange < SETTLED_AFTER_MS) return null;
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("CANCELLED")) return "CANCELLED";
  const started = new Set(tasks.map(task => String(task.stepId)));
  const allRan = (detail.shape ?? []).every(
    node => !node.stepId || started.has(String(node.stepId)),
  );
  return allRan ? "COMPLETED" : "CANCELLED";
}

/** `detail` with the status its steps give it, when Hatchet left it open. */
function settledDetail(detail: RunDetail): RunDetail {
  const status = endedStatusOf(detail);
  return status && detail.run
    ? { ...detail, run: { ...detail.run, status } }
    : detail;
}

/**
 * The runs of a list, with those Hatchet left open shown as they ended.
 * Only a run open for longer than SETTLED_AFTER_MS is read, once it has
 * ended never again; a run that cannot be read keeps Hatchet's status.
 */
async function settleOpenRuns<
  T extends { runId?: string; status: unknown; startedAt?: unknown },
>(tenant: WorkspaceTenant, runs: T[]): Promise<T[]> {
  const now = Date.now();
  const open = runs
    .filter(
      run =>
        run.runId &&
        isHatchetId(run.runId) &&
        !settled.has(run.runId) &&
        ACTIVE_STATUSES.has(String(run.status)) &&
        now - timeOf(run.startedAt) > SETTLED_AFTER_MS,
    )
    .slice(0, MAX_SETTLE_READS);
  await Promise.all(
    open.map(async run => {
      const id = run.runId as string;
      const detail = await readDetail(tenant, id).catch(() => null);
      const status = detail && endedStatusOf(detail, now);
      if (!status) return;
      if (settled.size >= MAX_SETTLED) {
        settled.delete(settled.keys().next().value as string);
      }
      settled.set(id, status);
    }),
  );
  return runs.map(run => {
    const status = run.runId ? settled.get(run.runId) : undefined;
    return status && ACTIVE_STATUSES.has(String(run.status))
      ? { ...run, status }
      : run;
  });
}

/** Forget the runs found ended (tests). */
export function forgetSettledRunsForTests() {
  settled.clear();
}

const readDetail = (tenant: WorkspaceTenant, runId: string) => {
  if (!isHatchetId(runId)) throw new HatchetError("Invalid run id", 400);
  return tenantJson<RunDetail>(tenant, `/api/v1/stable/workflow-runs/${runId}`);
};

/**
 * What a run's connection writes do (connections/proxy.service.ts):
 * - "send": through the connection, if the writers list allows it. A run a
 *   person, a trigger, a schedule, the agent's tool or an MCP login started.
 * - "record": kept under the run and not sent, a dry run (`dryRun: true`).
 * - "refuse": a run started with an API key (CI, a script: Mako cannot tell
 *   who holds the key), or an agent's run from before Mako kept its
 *   trigger. It fails loudly instead of passing with nothing sent.
 */
export type RunWrites = "send" | "record" | "refuse";

export type RunOrigin = { starter: RunStarter; writes: RunWrites };

/** What a run's writes do, from what Mako put on it when it started it. */
export function runWritesOf(
  starter: RunStarter,
  metadata: { trigger?: string; dryRun?: unknown },
): RunWrites {
  if (metadata.dryRun === true || metadata.dryRun === "true") return "record";
  if (starter !== "agent") return "send";
  return metadata.trigger === "agent" || metadata.trigger === "mcp"
    ? "send"
    : "refuse";
}

/**
 * What never changes about a run, once read: who started it, what its
 * writes do, and which workflow it is a run of (lowercase, as Hatchet keeps
 * step ids). With the last time Hatchet said one of its tasks was waiting
 * or executing.
 */
type KnownRun = { origin: RunOrigin; workflow: string; activeAt?: number };

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
/**
 * Waits between reads of a run Mako has not seen yet, when Hatchet does not
 * answer it. Hatchet can take a moment to answer a run it just started (seen
 * on the preview stack: a write in a run's first 200ms refused, the same
 * run's write 250ms later sent), so a run's first write is not refused for
 * asking too early. A run that never answers is refused after them.
 */
let firstReadRetryMs = [250, 500, 1000];

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

/** Who started a run and what its writes do, from Mako's metadata on it. */
function originOf(run: Row): RunOrigin {
  const metadata = metadataOf(run);
  const { startedBy, trigger } = metadata;
  const starter: RunStarter =
    startedBy === "agent" || startedBy === "person" || startedBy === "trigger"
      ? startedBy
      : trigger === "agent" || trigger === "api"
        ? "agent"
        : trigger === "ui"
          ? "person"
          : "trigger";
  return { starter, writes: runWritesOf(starter, metadata) };
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

/** Set the waits before reading a run not seen yet again (tests). */
export function setFirstReadRetryForTests(waits: number[]) {
  firstReadRetryMs = waits;
}

/** The run's detail, read again a few times when the run is new to Mako. */
async function readNewRunDetail(
  tenant: WorkspaceTenant,
  runId: string,
  read: () => Promise<RunDetail | null>,
): Promise<RunDetail | null> {
  for (let attempt = 0; ; attempt++) {
    const detail = await read();
    // A run's tasks, which name its workflow, can show up after the run
    // itself: a run without them yet is not known yet either.
    if (
      detail?.run &&
      idOf(detail.run) === runId &&
      workflowOfRunDetail(detail) !== ""
    ) {
      return detail;
    }
    const wait = firstReadRetryMs[attempt];
    if (wait === undefined) return null;
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

/**
 * Who started the workspace's run `runId` (hatchet.ts `RunStarter`) and
 * what its writes do, when that run is a run of `workflow` and is executing
 * now; else null, as when
 * Mako cannot tell (no run id, no tenant, a run the tenant does not have).
 *
 * Asked before a workflow pass is given for a step (pass.ts) and each time
 * one is used: the run must be of the pass's workflow (compared ignoring
 * case) and still executing, the run QUEUED, PENDING or RUNNING, or one of
 * its tasks so (an `onFailure` task runs while the run shows FAILED). A
 * pass for an old scheduled run lends nothing.
 *
 * Who started a run and its workflow never change: they are kept. Whether
 * it executes is asked again after ACTIVE_FOR_MS. When Hatchet does not
 * answer, a run seen executing within ACTIVE_WHEN_UNREADABLE_MS still is,
 * and a run not seen yet is read again a few times (firstReadRetryMs).
 * A run started before Mako kept `startedBy` is an agent's when its trigger
 * was an agent's tool or an API call, as those are now; a run with neither
 * (a schedule) is a trigger's.
 */
export async function runStartedBy(
  workspaceId: string,
  runId: string | undefined,
  workflow: string | undefined,
): Promise<RunOrigin | null> {
  return (await executingRun(workspaceId, runId, workflow)).origin;
}

/**
 * `runStartedBy`, and whether a null is Hatchet not answering (`unreadable`)
 * rather than a run that is not executing. The one who asks for a pass is
 * told which: a step waits out a Hatchet that restarts, and ends for good
 * only when its run is known to be over.
 */
export async function executingRun(
  workspaceId: string,
  runId: string | undefined,
  workflow: string | undefined,
): Promise<{ origin: RunOrigin | null; unreadable: boolean }> {
  const no = { origin: null, unreadable: false };
  if (!runId || !isHatchetId(runId) || !workflow) return no;
  const tenant = await readWorkspaceTenant(workspaceId).catch(() => null);
  if (!tenant) return no;
  const key = `${tenant.tenantId}:${runId}`;
  const wanted = workflow.toLowerCase();
  const known = knownRuns.get(key);
  if (known && known.workflow !== wanted) return no;
  const now = Date.now();
  if (known?.activeAt !== undefined && now - known.activeAt < ACTIVE_FOR_MS) {
    return { origin: known.origin, unreadable: false };
  }
  let unreadable = false;
  const read = () =>
    readDetail(tenant, runId).catch(error => {
      // No answer, or a 5xx: Hatchet is down or too slow. A 404 is an answer.
      unreadable = !(error instanceof HatchetError) || error.status >= 500;
      return null;
    });
  const detail = known
    ? await read()
    : await readNewRunDetail(tenant, runId, read);
  if (!detail?.run || idOf(detail.run) !== runId) {
    // Hatchet did not answer: a run seen executing a short while ago is
    // taken as still executing.
    return known?.activeAt !== undefined &&
      now - known.activeAt < ACTIVE_WHEN_UNREADABLE_MS
      ? { origin: known.origin, unreadable: false }
      : { origin: null, unreadable };
  }
  // Never kept without its workflow: that would refuse the run for good.
  if (!known && workflowOfRunDetail(detail) === "") return no;
  const run: KnownRun = known ?? {
    origin: originOf(detail.run),
    workflow: workflowOfRunDetail(detail),
  };
  if (isRunExecuting(detail)) run.activeAt = now;
  else delete run.activeAt;
  remember(key, run);
  return run.workflow === wanted && run.activeAt !== undefined
    ? { origin: run.origin, unreadable: false }
    : no;
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
  return shapeRun(settledDetail(detail), logs, { full });
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
  const list = await knownWorkflows(tenant);
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
