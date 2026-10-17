/**
 * What workflows_status and the Workflows routes answer, with a wait: the
 * overview (waiting for a deploy to go live) and one run, deployed or
 * sandbox (waiting for it to end). Sandbox runs are kept by Mako
 * (sandbox-runs.ts), deployed ones by the workspace's Hatchet (runs.ts).
 */
import { HatchetError, requireTenant } from "./hatchet";
import {
  deployment,
  isRunActive,
  loadState,
  readRun,
  readWorkflowsOverview,
  type ShapeOptions,
} from "./runs";
import {
  isSandboxRunId,
  listSandboxRuns,
  readSandboxRun,
} from "./sandbox-runs";
import { waitFor, waitSeconds } from "./wait";

/** A sandbox run is one Mongo read; a deployed one, several Hatchet calls. */
const SANDBOX_RUN_POLL_MS = 1000;
const DEPLOYED_RUN_POLL_MS = 3000;
const DEPLOY_POLL_MS = 2000;

type Deployment = ReturnType<typeof deployment>;

/** A deploy has settled: live on the wanted commit, failed, or nothing wanted. */
export const deploySettled = (d: Deployment) =>
  !d.targetSha || d.liveSha === d.targetSha || Boolean(d.buildError);

/**
 * The overview, with the caller's own sandbox runs among the recent runs.
 * With `wait`, first waits up to that many seconds for the deploy to settle.
 */
export async function readStatus(
  workspaceId: string,
  options: {
    userId?: string;
    limit: number;
    asAdmin: boolean;
    wait?: number;
  },
) {
  const seconds = waitSeconds(options.wait);
  let settled = true;
  if (seconds > 0) {
    ({ done: settled } = await waitFor(
      async () => deployment((await loadState(workspaceId)).state?.live),
      deploySettled,
      { seconds, intervalMs: DEPLOY_POLL_MS },
    ));
  }
  const [overview, sandboxRuns] = await Promise.all([
    readWorkflowsOverview(workspaceId, options.limit, options.asAdmin),
    options.userId
      ? listSandboxRuns(workspaceId, options.userId, options.limit)
      : Promise.resolve([]),
  ]);
  const deployed = "recentRuns" in overview ? overview.recentRuns : [];
  const recentRuns = [...deployed, ...sandboxRuns]
    .sort((a, b) =>
      String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
    )
    .slice(0, options.limit);
  return {
    ...overview,
    recentRuns,
    // Said only after a wait that ran out, so the caller knows to ask again.
    ...(seconds > 0 && !settled ? { deploying: true } : {}),
  };
}

/** One run, sandbox or deployed; 404 when the caller may not see it. */
export async function readAnyRun(
  workspaceId: string,
  userId: string | undefined,
  runId: string,
  options: ShapeOptions = {},
) {
  if (isSandboxRunId(runId)) {
    const run = userId
      ? await readSandboxRun(workspaceId, userId, runId, options)
      : null;
    if (!run) throw new HatchetError("Run not found", 404);
    return run;
  }
  return readRun(await requireTenant(workspaceId), runId, options);
}

/**
 * One run, waiting up to `wait` seconds for it to end. `done` is false when
 * it was still going at the end of the wait.
 */
export async function waitForRun(
  workspaceId: string,
  userId: string | undefined,
  runId: string,
  options: ShapeOptions & { wait?: number } = {},
) {
  const seconds = waitSeconds(options.wait);
  const shape = { full: options.full };
  if (seconds === 0) {
    const run = await readAnyRun(workspaceId, userId, runId, shape);
    return { run, done: !isRunActive(run) };
  }
  // The summary while waiting; the whole run, when asked for, read once.
  const { value, done } = await waitFor(
    () => readAnyRun(workspaceId, userId, runId),
    run => !isRunActive(run),
    {
      seconds,
      intervalMs: isSandboxRunId(runId)
        ? SANDBOX_RUN_POLL_MS
        : DEPLOYED_RUN_POLL_MS,
    },
  );
  const run = options.full
    ? await readAnyRun(workspaceId, userId, runId, shape)
    : value;
  return { run, done };
}
