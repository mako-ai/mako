/**
 * A sandbox run: one workflow of a person's checkout, as it is on disk,
 * uncommitted edits included, run once inside their sandbox on a Hatchet
 * engine of its own (`run.mjs` in the workflow runtime, Hatchet's embedded
 * mode). Nothing leaves the box but the result: no shared tenant, no Hatchet
 * token, no address for the workspace's Hatchet. Schedules are off; the
 * workflow runs because it was started. This is how a change is tested
 * before it is on main.
 *
 * The steps call Mako (`query`, `call`, `agent`) with a key made for this
 * run that acts as the person testing, so a test can do what they can do.
 */
import { appsGitOriginBase } from "../apps/config";
import { getSandboxProvider } from "../apps/sandbox/provider";
import {
  boxCtx,
  ensureWorkspaceWorktree,
  execInWorktree,
} from "../apps/worktree.service";
import { generateApiKey } from "../auth/api-key.middleware";
import { HatchetError } from "./hatchet";
import { setKey } from "./on-push";
import { type RunDetail, shapeRun } from "./runs";
import { RUNTIME_IN_BOX, installRuntimeCommand } from "./runtime-files";

/**
 * run.mjs ends a run after five minutes; the exec gets longer, for a box
 * that installs the runtime and fetches the engine first.
 */
const EXEC_TIMEOUT_MS = 8 * 60_000;
const FAILED = "MAKO_SANDBOX_FAILED";

type Result = {
  buildError?: string;
  detail?: RunDetail;
  logs?: Record<string, Array<Record<string, unknown>>>;
};

/** One run at a time per box: two engines cannot share one data folder. */
const queue = new Map<string, Promise<unknown>>();

export function runInSandbox(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object = {},
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId)) {
    throw new HatchetError(`Invalid workflow: ${workflowId}`, 400);
  }
  const box = `${workspaceId}:${userId}`;
  const run = (queue.get(box) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => runNow(workspaceId, userId, workflowId, input))
    .finally(() => {
      if (queue.get(box) === run) queue.delete(box);
    });
  queue.set(box, run);
  return run;
}

async function runNow(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object,
) {
  const provider = getSandboxProvider();
  const handle = await ensureWorkspaceWorktree(workspaceId, userId);
  const ctx = boxCtx(handle);
  const { key } = generateApiKey();
  await setKey(workspaceId, userId, `Workflows sandbox ${userId}`, key);

  const scratch = provider.scratch(ctx);
  const out = `${scratch}/mako-workflow-run.json`;
  const log = `${scratch}/mako-workflow-run.log`;
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  // Only the result reaches stdout; the install's, the engine's and the
  // worker's output go to a log, shown when there is no result.
  const command =
    `rm -f ${out}; { ${installRuntimeCommand()}; } > ${log} 2>&1; ` +
    `MAKO_SANDBOX_RESULT_FILE=${out} node "${RUNTIME_IN_BOX}/run.mjs" ${workflowId} ${encoded} >> ${log} 2>&1; ` +
    `if [ -s ${out} ]; then cat ${out}; else echo ${FAILED}; tail -n 40 ${log}; fi`;
  const exec = await execInWorktree(handle, command, {
    timeoutMs: EXEC_TIMEOUT_MS,
    env: {
      WORKFLOWS_ROOT: provider.root(ctx),
      MAKO_URL: appsGitOriginBase(),
      MAKO_API_KEY: key,
    },
  });

  let result: Result | null = null;
  if (!exec.stdout.startsWith(FAILED)) {
    try {
      result = JSON.parse(exec.stdout) as Result;
    } catch {
      // Not a result: reported below with what was printed.
    }
  }
  if (!result) {
    throw new HatchetError(
      `The sandbox run did not finish.\n${exec.stdout.replace(FAILED, "").trim() || exec.stderr.trim()}`,
      500,
    );
  }
  if (result.buildError) throw new HatchetError(result.buildError, 422);
  return {
    ...shapeRun(result.detail ?? {}, result.logs ?? {}),
    sandbox: true as const,
  };
}
