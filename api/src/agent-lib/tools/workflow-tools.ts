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
import { readWorkflowsOverview } from "../../workflows/runs";
import { WORKFLOWS_ADMIN_ONLY } from "../../workflows/policy";
import { startSandboxRun } from "../../workflows/sandbox";
import { waitForDeploy, waitForRun } from "../../workflows/status";
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
      description: `Look at this workspace's workflows. Without runId: what is deployed (\`deployment\`: the code on main), the build error if a commit did not start (\`buildError\` — the old code keeps running), the workflows (each with \`active\`, and \`webhookUrl\` when one has a webhook) and schedules, and the last deployed runs. With runId (sandbox or deployed): that run's steps, each with status, output, error and its last log lines (what the step wrote with ctx.logger), and, for a run you started, the connection calls that write it recorded instead of sending: \`recordedWriteCount\` and a page of \`recordedWrites\`, each whole (method, url, headers, body; credentials redacted); \`recordedWritesNext\` is the \`recordedFrom\` of the next page. \`wait\` waits on the server up to that many seconds (at most ${MAX_WAIT_SECONDS}): with runId for the run to end (\`running: true\` means it had not), without for the deploy under way, or of \`sha\`, to go live or fail to build (\`deploying: true\` means it had not); call again the same way. Texts are cut at 2000 characters and logs to a step's last 20 lines; \`full: true\` gives a sandbox run whole. While \`liveSha\` is not yet \`targetSha\` the worker has not switched to the new commit; after a commit on main, call workflows_status({ wait: 90, sha: <its commitOid> }) rather than polling.`,
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
            `Seconds to wait, at most ${MAX_WAIT_SECONDS}: with runId for the run to end, without for the deploy to go live or fail`,
          ),
        sha: z
          .string()
          .optional()
          .describe(
            "Without runId: the commit whose deploy to wait for (commitOid from workflow_commit or workflow_merge_to_main)",
          ),
        full: z
          .boolean()
          .optional()
          .describe(
            "With a sandbox runId: the whole run, not a summary; with recordedWrites, their bodies whole",
          ),
        recordedFrom: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "With runId: the page of recordedWrites starting here (recordedWritesNext)",
          ),
      }),
      execute: async (
        { runId, wait, sha, full, recordedFrom },
        { abortSignal },
      ) => {
        try {
          if (!runId) {
            const deploy = wait
              ? await waitForDeploy(workspaceId, {
                  wait,
                  sha,
                  signal: abortSignal,
                })
              : { done: true };
            return {
              success: true,
              ...(deploy.done ? {} : { deploying: true }),
              ...(await readWorkflowsOverview(
                workspaceId,
                RECENT_RUNS,
                await mayChange(),
              )),
            };
          }
          const { run, done } = await waitForRun(workspaceId, userId, runId, {
            wait,
            full,
            signal: abortSignal,
            recordedFrom,
          });
          return { success: true, run, ...(done ? {} : { running: true }) };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    workflows_run: tool({
      description:
        "Start a run of a workflow; answers its runId at once. Follow it with workflows_status({ runId, wait: 90 }), again while it answers `running: true`. With `sandbox: true` it runs `mako workflow run` in your sandbox (the same command as on a laptop) on your checkout as it is, uncommitted edits included, with real data, your own rights and no schedule: that is how a change is tested. It typechecks workflows/ first, as the deploy does: with type errors it does not run and answers them in `typeErrors`. Without `sandbox`, the deployed code on main is started on the workers, active or not, with the workflow's rights. Either way, in a run you start a connection call that writes (`post`/`put`/`patch`/`delete` through `connection(id)`) is recorded, not sent (answered 202, `recorded: true`), and listed in workflows_status as `recordedWrites`. SQL is not recorded: `execute` and a writing `query` run with the run's rights (yours in the sandbox).",
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
            // An agent's run only reads through connections; it records
            // its writes.
            const { runId } = await startSandboxRun(
              workspaceId,
              userId,
              workflowId,
              input,
              { byAgent: true },
            );
            return { success: true, sandbox: true, runId, workflowId };
          }
          const runId = await startRun(
            await requireTenant(workspaceId),
            workflowId,
            // Its deployed code only reads through connections; it records
            // its writes.
            { input, trigger: "agent", startedBy: "agent" },
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
