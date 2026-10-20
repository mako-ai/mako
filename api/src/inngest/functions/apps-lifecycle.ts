/**
 * Daily app lifecycle sweep (app-lifecycle.service.ts): stale notices,
 * archives 14 days later, and pausing binding schedules of unviewed apps.
 *
 * DRY-RUN unless `APPS_LIFECYCLE_ENFORCE` names the workspace: a dry run
 * only logs the plan. One step per workspace, so a workspace whose repo
 * cannot be read fails alone and the others still run.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  lifecycleWorkspaceIds,
  runAppLifecycle,
} from "../../apps/app-lifecycle.service";

const log = loggers.inngest();

export const appsLifecycleFunction = inngest.createFunction(
  {
    id: "apps-lifecycle-daily",
    name: "Apps Lifecycle (stale / unviewed apps)",
    // One sweep at a time: two would both send the same notices.
    concurrency: { limit: 1 },
    // Each action records its state as it lands, so a retry re-plans from
    // what already happened; but a failed notice is retried tomorrow, not
    // in a loop that could email someone twice.
    retries: 0,
    triggers: { cron: "0 6 * * *" },
  },
  async ({ step }) => {
    const workspaceIds = await step.run("list-workspaces", () =>
      lifecycleWorkspaceIds(),
    );
    const results: Array<{
      workspaceId: string;
      mode?: string;
      counts?: Record<string, number>;
      error?: string;
    }> = [];
    for (const workspaceId of workspaceIds) {
      const result = await step.run(`lifecycle-${workspaceId}`, async () => {
        try {
          const plan = await runAppLifecycle(workspaceId);
          return { workspaceId, mode: plan.mode, counts: plan.counts };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log.warn("Apps lifecycle failed for workspace", {
            workspaceId,
            error: message,
          });
          return { workspaceId, error: message };
        }
      });
      results.push(result);
    }
    return { workspaces: results.length, results };
  },
);
