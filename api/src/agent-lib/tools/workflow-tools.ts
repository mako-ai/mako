/**
 * Workflow agent tools (docs/src/content/docs/workflows.md). An agent writes
 * a workflow with the `app_*` shell, file and git tools (`workflowId`), and a
 * merge is the deploy. What is left is to look (`workflows_status`) and to
 * start a run (`workflows_run`).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { workspaceService } from "../../services/workspace.service";
import { requireTenant, startRun } from "../../workflows/hatchet";
import { WORKFLOWS_ADMIN_ONLY } from "../../workflows/policy";
import { startSandboxRun } from "../../workflows/sandbox";
import { readStatus, waitForRun } from "../../workflows/status";
import { MAX_WAIT_SECONDS } from "../../workflows/wait";
import { setTriggers } from "../../workflows/webhook";

/** How many recent runs an agent is shown. */
const RECENT_RUNS = 10;

const failure = (error: unknown) => ({
  success: false as const,
  error: error instanceof Error ? error.message : String(error),
});

export function createWorkflowTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  /** Viewers look; members start runs; admins activate and add webhooks. */
  const roleIs = async (roles: string[]) =>
    !userId || workspaceService.hasRole(workspaceId, userId, roles);
  const mayRun = () => roleIs(["owner", "admin", "member"]);
  const mayChange = () => roleIs(["owner", "admin"]);

  return {
    workflows_status: tool({
      description: `Look at this workspace's workflows. Without runId: what is deployed (\`deployment\`: the code on main), the build error if a commit did not start (\`buildError\` — the old code keeps running), the workflows (each with \`active\`, and \`webhookUrl\` when one has a webhook) and schedules, and the last runs, your sandbox runs among them (\`sandbox: true\`). With \`wait\` and no runId it first waits up to that many seconds for a deploy to go live (\`liveSha\` = \`targetSha\`) or fail (\`buildError\`); \`deploying: true\` means it had not yet, call again. With runId: that run, sandbox or deployed: its steps, each with status, output, error and log lines (what the step wrote with ctx.logger). With \`wait\` it waits up to that many seconds (at most ${MAX_WAIT_SECONDS}) for the run to end; \`running: true\` means it had not yet, call again. Texts are cut at 2000 characters and logs to a step's last 20 lines; \`full: true\` gives each text up to 1 MB and every log line.`,
      inputSchema: z.object({
        runId: z
          .string()
          .optional()
          .describe("A run id from workflows_run or from recentRuns"),
        wait: z
          .number()
          .min(0)
          .optional()
          .describe(
            `Seconds to wait for the run to end (with runId) or the deploy to go live (without), at most ${MAX_WAIT_SECONDS}`,
          ),
        full: z
          .boolean()
          .optional()
          .describe("With runId: the whole run, not a summary"),
      }),
      execute: async ({ runId, wait, full }) => {
        try {
          if (!runId) {
            return {
              success: true,
              ...(await readStatus(workspaceId, {
                userId,
                limit: RECENT_RUNS,
                asAdmin: await mayChange(),
                wait,
              })),
            };
          }
          const { run, done } = await waitForRun(workspaceId, userId, runId, {
            wait,
            full,
          });
          return { success: true, run, ...(done ? {} : { running: true }) };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_run: tool({
      description:
        "Start a run of a workflow; answers its runId at once. Follow it with workflows_status({ runId, wait: 90 }), again while it answers `running: true`. With `sandbox: true` it runs the workflow as it is in your checkout right now, uncommitted edits included, inside your sandbox, with real data and no schedule: that is how a change is tested. A sandbox run takes about ten seconds plus the workflow's own time, fifteen minutes at most; type errors in the checkout end it with `buildError`. Without `sandbox`, the deployed code on main is started, active or not.",
      inputSchema: z.object({
        workflowId: z
          .string()
          .min(1)
          .describe('The workflow\'s folder name, e.g. "daily-digest"'),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The run's input object (default {})"),
        sandbox: z
          .boolean()
          .optional()
          .describe("Run your checkout's version instead of the deployed one"),
      }),
      execute: async ({ workflowId, input, sandbox }) => {
        try {
          if (!(await mayRun())) {
            return { success: false, error: "Viewers cannot start runs." };
          }
          if (sandbox) {
            if (!userId) {
              return { success: false, error: "A sandbox needs a person." };
            }
            const { runId } = await startSandboxRun(
              workspaceId,
              userId,
              workflowId,
              input,
            );
            return { success: true, sandbox: true, runId, workflowId };
          }
          const runId = await startRun(
            await requireTenant(workspaceId),
            workflowId,
            { input, trigger: "agent" },
          );
          return { success: true, runId, workflowId };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_triggers: tool({
      description:
        "Change what starts a workflow by itself. `active`: a workflow is deployed inactive and runs only when started; true turns its `on: { cron }` schedule and its webhook on, false turns them off. `webhook`: true gives it a webhook and returns the new URL (a POST to it starts a run with the JSON body as input, while the workflow is active; the URL carries its own secret), false removes it. Ask the user before activating: from then on it runs by itself. A schedule is not set here: write it in the workflow's code.",
      inputSchema: z.object({
        workflowId: z.string().describe("The workflow's name"),
        active: z.boolean().optional(),
        webhook: z.boolean().optional(),
      }),
      execute: async ({ workflowId, ...change }) => {
        try {
          if (!(await mayChange())) {
            return { success: false, error: WORKFLOWS_ADMIN_ONLY };
          }
          return {
            success: true,
            workflowId,
            ...change,
            ...(await setTriggers(workspaceId, workflowId, change)),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
