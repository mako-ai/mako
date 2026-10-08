/**
 * Workflow agent tools (docs/src/content/docs/workflows.md).
 *
 * Two tools, because everything else an agent does to a workflow it does to
 * files: it writes `workflows/<name>/workflow.ts` with the shell, file and
 * git tools (`workflowId` on the `app_*` tools), and a merge to main is the
 * deploy. What is left is to look and to start:
 *
 *   workflows_status — what runs (live, and the preview of a branch), the
 *                      build error if a commit did not start, the workflows,
 *                      the recent runs; or one run in detail
 *   workflows_run    — start a run of the live code or of the preview
 *
 * Runs, steps and logs are read from Hatchet as the workspace's tenant and
 * trimmed to what a model needs; nothing is stored here.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { workspaceService } from "../../services/workspace.service";
import {
  HatchetError,
  isHatchetId,
  readWorkspaceTenant,
  tenantJson,
  triggerRun,
  type WorkspaceTenant,
} from "../../workflows/hatchet";
import { readWorkflowsStatus } from "../../workflows/status";

/** Preview workflows are registered in Hatchet under this prefix (worker.mjs). */
const PREVIEW_PREFIX = "preview_";
const RECENT_RUNS = 10;
const RECENT_RUNS_DAYS = 7;
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

const runSummary = (run: Row, workflowName: unknown = run.workflowName) => ({
  runId: idOf(run),
  ...splitName(workflowName),
  status: run.status,
  startedAt: run.startedAt ?? run.createdAt,
  durationMs: run.duration,
  error: errorOf(run.errorMessage),
});

async function overview(workspaceId: string, tenant: WorkspaceTenant | null) {
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
          limit: String(RECENT_RUNS),
        }),
      },
    ),
  ]);
  return {
    ...status,
    workflows: (workflows.rows ?? []).map(w => splitName(w.name)),
    schedules: (crons.rows ?? []).map(c => ({
      workflowId: c.workflowName,
      cron: c.cron,
    })),
    recentRuns: (runs.rows ?? []).map(run => runSummary(run)),
  };
}

async function runDetail(tenant: WorkspaceTenant, runId: string) {
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

const failure = (error: unknown) => ({
  success: false as const,
  error:
    error instanceof HatchetError || error instanceof Error
      ? error.message
      : String(error),
});

export function createWorkflowTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  return {
    workflows_status: tool({
      description:
        "Look at this workspace's workflows. Without runId: what is deployed (`deployment` is the live code on main; `preview` is the unmerged branch last pushed, registered as its own copy with schedules off), the build error if a commit did not start (`buildError` — the old code keeps running), the workflows and schedules, and the last runs. With runId: that run's steps, each with status, output, error and its last log lines (what the step wrote with ctx.logger). `deploying: true` means the worker has not switched to the new commit yet; call again in a few seconds.",
      inputSchema: z.object({
        runId: z
          .string()
          .optional()
          .describe("A run id from workflows_run or from recentRuns"),
      }),
      execute: async ({ runId }) => {
        try {
          const tenant = await readWorkspaceTenant(workspaceId);
          if (!runId) {
            return { success: true, ...(await overview(workspaceId, tenant)) };
          }
          if (!isHatchetId(runId)) {
            return { success: false, error: `Invalid run id: ${runId}` };
          }
          if (!tenant) {
            return { success: false, error: "Workflows are not set up." };
          }
          return { success: true, run: await runDetail(tenant, runId) };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_run: tool({
      description:
        "Start a run of a workflow and get its runId; follow it with workflows_status({ runId }). By default this runs the LIVE code on main, with real data. Pass preview: true to run the unmerged code of the branch last pushed instead — that is how to test a change before merging it. A preview exists only after its branch was committed and workflows_status shows `preview` without a buildError.",
      inputSchema: z.object({
        workflowId: z
          .string()
          .min(1)
          .describe('The workflow\'s folder name, e.g. "daily-digest"'),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The run's input object (default {})"),
        preview: z
          .boolean()
          .optional()
          .describe("Run the pushed branch's code instead of the live code"),
      }),
      execute: async ({ workflowId, input, preview }) => {
        try {
          if (
            userId &&
            !(await workspaceService.hasRole(workspaceId, userId, [
              "owner",
              "admin",
              "member",
            ]))
          ) {
            return { success: false, error: "Viewers cannot start runs." };
          }
          const tenant = await readWorkspaceTenant(workspaceId);
          if (!tenant) {
            return { success: false, error: "Workflows are not set up." };
          }
          const run = (await triggerRun(
            tenant,
            `${preview ? PREVIEW_PREFIX : ""}${workflowId}`,
            input ?? {},
            { trigger: "agent", triggeredBy: userId ?? "api-key" },
          )) as { run?: Row } & Row;
          return {
            success: true,
            runId: idOf(run.run ?? run),
            workflowId,
            preview: preview === true,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
