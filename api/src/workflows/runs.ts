/**
 * Runs of a workspace's workflows, read from Hatchet as the workspace's tenant
 * and trimmed to what a person or a model needs. Shared by the Workflows
 * screens (routes/workflows.ts) and the agent tools
 * (agent-lib/tools/workflow-tools.ts), so both show the same thing.
 */
import { tenantJson, type WorkspaceTenant } from "./hatchet";
import { readWorkflowsStatus } from "./status";
import { webhookUrl } from "./webhook";

/** Preview workflows are registered in Hatchet under this prefix (worker.mjs). */
export const PREVIEW_PREFIX = "preview_";
const RECENT_RUNS_DAYS = 30;
const LOG_LINES_PER_STEP = 20;
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

/** A workflow's name as people write it, and whether it is the preview's. */
function splitName(name: unknown): { workflowId: string; preview: boolean } {
  const text = String(name ?? "");
  return text.startsWith(PREVIEW_PREFIX)
    ? { workflowId: text.slice(PREVIEW_PREFIX.length), preview: true }
    : { workflowId: text, preview: false };
}

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
  (run.additionalMetadata ?? {}) as { trigger?: string; triggeredBy?: string };

const runSummary = (run: Row, workflowName: unknown = run.workflowName) => ({
  runId: idOf(run),
  ...splitName(workflowName),
  status: run.status,
  startedAt: run.startedAt ?? run.createdAt,
  durationMs: run.duration,
  error: errorOf(run.errorMessage),
  // Set by Mako when a person or an agent starts the run; a scheduled run
  // has neither.
  trigger: metadataOf(run).trigger,
  triggeredBy: metadataOf(run).triggeredBy,
});

/**
 * Everything a screen or an agent shows first: what is deployed, the
 * workflows and schedules, and the last `limit` runs.
 */
export async function readWorkflowsOverview(
  workspaceId: string,
  tenant: WorkspaceTenant | null,
  limit: number,
  /** Include each live workflow's webhook URL: only for who may start runs. */
  withWebhooks = false,
) {
  const status = await readWorkflowsStatus(workspaceId);
  if (!tenant) return status;
  const base = `/api/v1/tenants/${tenant.tenantId}`;
  const since = new Date(Date.now() - RECENT_RUNS_DAYS * 864e5).toISOString();
  const [workflows, crons, runs] = await Promise.all([
    tenantJson<Rows>(tenant, `${base}/workflows`),
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
  return {
    ...status,
    workflows: (workflows.rows ?? []).map(w => {
      const workflow = splitName(w.name);
      return withWebhooks && !workflow.preview
        ? {
            ...workflow,
            webhookUrl: webhookUrl(workspaceId, workflow.workflowId),
          }
        : workflow;
    }),
    schedules: (crons.rows ?? []).map(c => ({
      workflowId: c.workflowName,
      cron: c.cron,
    })),
    recentRuns: (runs.rows ?? []).map(run => runSummary(run)),
  };
}

/** One run: its steps in order, each with status, output, error and logs. */
export async function readRun(tenant: WorkspaceTenant, runId: string) {
  const detail = await tenantJson<{ run?: Row; tasks?: Row[] }>(
    tenant,
    `/api/v1/stable/workflow-runs/${runId}`,
  );
  // A step's `actionId` is `<workflow>:<step>`; Hatchet lists steps in no order.
  const tasks = [...(detail.tasks ?? [])].sort((a, b) =>
    String(a.taskInsertedAt ?? "").localeCompare(
      String(b.taskInsertedAt ?? ""),
    ),
  );
  const nameOf = (task: Row | undefined, part: 0 | 1) =>
    String(task?.actionId ?? "").split(":")[part];
  const steps = await Promise.all(
    tasks.map(async task => {
      const taskId = idOf(task);
      const logs = taskId
        ? await tenantJson<Rows>(tenant, `/api/v1/stable/tasks/${taskId}/logs`)
            .then(l => (l.rows ?? []).slice(-LOG_LINES_PER_STEP))
            .catch(() => [])
        : [];
      return {
        step: nameOf(task, 1) || task.displayName,
        status: task.status,
        attempt: task.attempt,
        durationMs: task.duration,
        output: cap(task.output),
        error: errorOf(task.errorMessage),
        logs: logs.map(line => cap(line.message)),
      };
    }),
  );
  return {
    ...runSummary(detail.run ?? {}, nameOf(tasks[0], 0)),
    input: cap(inputOf(detail.run?.input)),
    output: cap(detail.run?.output),
    steps,
  };
}
