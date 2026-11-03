/**
 * One run, sandbox (read from the person's box, sandbox.ts) or deployed
 * (read from the workspace's Hatchet, runs.ts), waiting on the server up to
 * `wait` seconds for it to end. Shared by workflows_status and the routes.
 */
import { readRunCosts } from "./costs";
import { requireTenant } from "./hatchet";
import { readRun } from "./runs";
import { isSandboxRunId, readSandboxRun } from "./sandbox";
import { waitFor, waitSeconds } from "./wait";

const ACTIVE = ["QUEUED", "RUNNING", "PENDING"];

export async function waitForRun(
  workspaceId: string,
  userId: string | undefined,
  runId: string,
  options: { wait?: number; full?: boolean } = {},
) {
  const sandbox = isSandboxRunId(runId);
  const read = async () => {
    if (!sandbox) {
      const run = await readRun(await requireTenant(workspaceId), runId, {
        full: options.full,
      });
      // Its AI cost, in total and by step, once it has any.
      const cost = (await readRunCosts(workspaceId, [runId]))[runId];
      if (!cost) return run;
      return {
        ...run,
        costUsd: cost.costUsd,
        ...(cost.backfilled ? { costBackfilled: true } : {}),
        steps: run.steps.map(step => {
          const spent = cost.steps[String(step.step)];
          return spent ? { ...step, costUsd: spent.costUsd } : step;
        }),
      };
    }
    if (!userId) throw new Error("A sandbox run is read by its person.");
    return readSandboxRun(workspaceId, userId, runId, { full: options.full });
  };
  const { value: run, done } = await waitFor(
    read,
    value => !ACTIVE.includes(String(value.status)),
    {
      seconds: waitSeconds(options.wait),
      intervalMs: sandbox ? 2000 : 3000,
    },
  );
  return { run, done };
}
