/**
 * Workflow agent tools (docs/src/content/docs/workflows.md). An agent writes
 * a workflow with the `app_*` shell, file and git tools (`workflowId`), and a
 * merge is the deploy. What is left is to look (`workflows_status`) and to
 * start a run (`workflows_run`).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { workspaceService } from "../../services/workspace.service";
import {
  isHatchetId,
  readWorkspaceTenant,
  triggerRun,
} from "../../workflows/hatchet";
import { mayHaveWebhook, setWebhook } from "../../workflows/webhook";
import {
  PREVIEW_PREFIX,
  readRun,
  readWorkflowsOverview,
} from "../../workflows/runs";

/** How many recent runs an agent is shown. */
const RECENT_RUNS = 10;

const failure = (error: unknown) => ({
  success: false as const,
  error: error instanceof Error ? error.message : String(error),
});

const NOT_SET_UP =
  "Nothing is deployed yet. Commit a workflow first; if one is committed, its deploy failed (is Hatchet reachable?).";

export function createWorkflowTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  /** Viewers look; starting runs and changing webhooks need a member. */
  const mayRun = async () =>
    !userId ||
    workspaceService.hasRole(workspaceId, userId, ["owner", "admin", "member"]);

  return {
    workflows_status: tool({
      description:
        "Look at this workspace's workflows. Without runId: what is deployed (`deployment` is the live code on main; `preview` is the unmerged branch last pushed, registered as its own copy with schedules off), the build error if a commit did not start (`buildError` — the old code keeps running), the workflows (with `webhookUrl` when one has a webhook) and schedules, and the last runs. With runId: that run's steps, each with status, output, error and its last log lines (what the step wrote with ctx.logger). While `liveSha` is not yet `targetSha` the worker has not switched to the new commit; call again in a few seconds.",
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
            return {
              success: true,
              ...(await readWorkflowsOverview(
                workspaceId,
                tenant,
                RECENT_RUNS,
                await mayRun(),
              )),
            };
          }
          if (!isHatchetId(runId)) {
            return { success: false, error: `Invalid run id: ${runId}` };
          }
          if (!tenant) {
            return { success: false, error: NOT_SET_UP };
          }
          return { success: true, run: await readRun(tenant, runId) };
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
          if (!(await mayRun())) {
            return { success: false, error: "Viewers cannot start runs." };
          }
          const tenant = await readWorkspaceTenant(workspaceId);
          if (!tenant) {
            return { success: false, error: NOT_SET_UP };
          }
          const run = (await triggerRun(
            tenant,
            `${preview ? PREVIEW_PREFIX : ""}${workflowId}`,
            input ?? {},
            { trigger: "agent", triggeredBy: userId ?? "api-key" },
          )) as { run?: { metadata?: { id?: string } } };
          return {
            success: true,
            runId: run.run?.metadata?.id,
            workflowId,
            preview: preview === true,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_webhook: tool({
      description:
        "Give a live workflow a webhook, or remove it. With `enabled: true` it returns a new URL: a POST to it starts a run with the request's JSON body as the input. The URL carries its own secret; removing the webhook and adding it again gives a new URL and the old one stops working. A schedule is not set here: write `on: { cron }` in the workflow's code.",
      inputSchema: z.object({
        workflowId: z.string().describe("The workflow's name"),
        enabled: z.boolean(),
      }),
      execute: async ({ workflowId, enabled }) => {
        try {
          if (!mayHaveWebhook(workflowId)) {
            return { success: false, error: `Invalid workflow: ${workflowId}` };
          }
          if (!(await mayRun())) {
            return { success: false, error: "Viewers cannot change webhooks." };
          }
          return {
            success: true,
            workflowId,
            webhookUrl: await setWebhook(workspaceId, workflowId, enabled),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
