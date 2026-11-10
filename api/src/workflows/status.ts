/**
 * One run, sandbox (read from the person's box, sandbox.ts) or deployed
 * (read from the workspace's Hatchet, runs.ts), waiting on the server up to
 * `wait` seconds for it to end. Shared by workflows_status and the routes.
 * And the deploy, waited on the same way.
 */
import { readRunCosts } from "./costs";
import { requireTenant } from "./hatchet";
import { deployCarries } from "./on-push";
import { deploySettled, readDeployment, readRun } from "./runs";
import { isSandboxRunId, readSandboxRun } from "./sandbox";
import { waitFor, waitSeconds } from "./wait";

const ACTIVE = ["QUEUED", "RUNNING", "PENDING"];

export async function waitForRun(
  workspaceId: string,
  userId: string | undefined,
  runId: string,
  options: { wait?: number; full?: boolean; signal?: AbortSignal } = {},
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
      signal: options.signal,
    },
  );
  return { run, done };
}

/**
 * Wait up to `wait` seconds for the deploy under way (a commit on main), or
 * of commit `sha`, to be over: live on the worker, or failed to build. A
 * build takes a minute or two, so this saves the caller polling for it.
 * The target is set a few seconds after main moves, and only when
 * `workflows/` changed: until it carries `sha`, that deploy has not started.
 */
export async function waitForDeploy(
  workspaceId: string,
  options: { wait?: number; sha?: string; signal?: AbortSignal } = {},
) {
  const { sha } = options;
  // Asked of git once per target, not once per read.
  let known: { target: string; carries: boolean } | undefined;
  const read = async () => {
    const { deployment, tree } = await readDeployment(workspaceId);
    const target = deployment.targetSha;
    if (
      !sha ||
      !target ||
      !tree ||
      [target, deployment.liveSha].includes(sha)
    ) {
      return { deployment, carries: true };
    }
    if (known?.target !== target) {
      known = {
        target,
        carries: await deployCarries(workspaceId, sha, { sha: target, tree }),
      };
    }
    return { deployment, carries: known.carries };
  };
  const { value, done } = await waitFor(
    read,
    ({ deployment, carries }) => carries && deploySettled(deployment),
    {
      seconds: waitSeconds(options.wait),
      intervalMs: 3000,
      signal: options.signal,
    },
  );
  return { deployment: value.deployment, done };
}
