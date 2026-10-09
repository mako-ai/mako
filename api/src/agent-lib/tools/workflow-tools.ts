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
  isHatchetId,
  readWorkspaceTenant,
  triggerRun,
} from "../../workflows/hatchet";
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
            return {
              success: true,
              ...(await readWorkflowsOverview(
                workspaceId,
                tenant,
                RECENT_RUNS,
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
  };
}
