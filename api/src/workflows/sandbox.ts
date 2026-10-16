/**
 * A sandbox run: one workflow of a person's checkout, as it is on disk,
 * uncommitted edits included, run once inside their sandbox on a Hatchet
 * engine of its own (`run.mjs` in the workflow runtime, Hatchet's embedded
 * mode). Nothing leaves the box but the result: no shared tenant, no Hatchet
 * token, no address for the workspace's Hatchet. Schedules are off; the
 * workflow runs because it was started. This is how a change is tested
 * before it is on main.
 *
 * Starting one answers at once with a runId; the run goes on in this process
 * and its result is kept (sandbox-runs.ts), so a caller that stopped waiting
 * loses nothing. One run at a time per box, whichever API process started it
 * (box-lock.ts).
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
import { loggers } from "../logging";
import { acquireBoxLock, releaseBoxLock, renewBoxLock } from "./box-lock";
import { HatchetError } from "./hatchet";
import { removeKey, setKey } from "./on-push";
import { RUNTIME_IN_BOX, installRuntimeCommand } from "./runtime-files";
import {
  createSandboxRun,
  finishSandboxRun,
  heartbeatSandboxRun,
  markSandboxRunStarted,
  readSandboxRun,
  type SandboxResult,
} from "./sandbox-runs";
import { sandboxKeyName } from "./worker-key";

const logger = loggers.api("workflows-sandbox");

/** How long run.mjs lets a workflow run before it ends the run. */
export const RUN_TIMEOUT_MS = 15 * 60_000;
/** Longer, for a box that installs the runtime and fetches the engine first. */
const EXEC_TIMEOUT_MS = RUN_TIMEOUT_MS + 5 * 60_000;
/** The box's lease: renewed every heartbeat, gone this long after a crash. */
const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 10_000;
/** How long a run waits for the box while another run has it. */
const QUEUE_LIMIT_MS = EXEC_TIMEOUT_MS + 60_000;
const QUEUE_POLL_MS = 2_000;
const BOX_LOG_BYTES = 64_000;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export const boxOf = (workspaceId: string, userId: string) =>
  `${workspaceId}:${userId}`;

/**
 * Start a sandbox run and answer its runId; `done` settles when the run has
 * ended and its result is kept (it never rejects).
 */
export async function startSandboxRun(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object = {},
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId)) {
    throw new HatchetError(`Invalid workflow: ${workflowId}`, 400);
  }
  const runId = await createSandboxRun(workspaceId, userId, workflowId, input);
  const done = driveRun(runId, workspaceId, userId, workflowId, input).catch(
    async error => {
      logger.error("Sandbox run failed", { runId, error });
      await finishSandboxRun(runId, {
        error: error instanceof Error ? error.message : String(error),
      }).catch(finishError =>
        logger.error("Could not record a sandbox run's failure", {
          runId,
          error: finishError,
        }),
      );
    },
  );
  return { runId, done };
}

/** Wait for the box, run, keep the result; renew the run and the lease meanwhile. */
async function driveRun(
  runId: string,
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object,
) {
  const box = boxOf(workspaceId, userId);
  let holding = false;
  const beat = setInterval(() => {
    heartbeatSandboxRun(runId).catch(error =>
      logger.warn("Sandbox run heartbeat failed", { runId, error }),
    );
    if (holding) {
      renewBoxLock(box, runId, LOCK_TTL_MS).catch(error =>
        logger.warn("Sandbox box lease renewal failed", { runId, error }),
      );
    }
  }, HEARTBEAT_MS);
  try {
    const deadline = Date.now() + QUEUE_LIMIT_MS;
    while (!(await acquireBoxLock(box, runId, LOCK_TTL_MS))) {
      if (Date.now() > deadline) {
        throw new Error(
          "Another sandbox run kept this sandbox busy for too long; start this one again.",
        );
      }
      await sleep(QUEUE_POLL_MS);
    }
    holding = true;
    await markSandboxRunStarted(runId);
    await finishSandboxRun(
      runId,
      await execRun(runId, workspaceId, userId, workflowId, input),
    );
  } finally {
    clearInterval(beat);
    if (holding) {
      await releaseBoxLock(box, runId).catch(error =>
        logger.warn("Could not release a sandbox box lease", { runId, error }),
      );
    }
  }
}

/** Run run.mjs in the box and read back what it left. */
async function execRun(
  runId: string,
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object,
): Promise<{ result?: SandboxResult; error?: string; boxLog?: string }> {
  const provider = getSandboxProvider();
  const handle = await ensureWorkspaceWorktree(workspaceId, userId);
  const ctx = boxCtx(handle);
  const { key } = generateApiKey();
  // The run's own key, for this run only: the code being tested can read it.
  const keyName = sandboxKeyName(userId);
  await setKey(workspaceId, userId, keyName, key);

  const scratch = provider.scratch(ctx);
  const dir = `${scratch}/mako-workflow-runs`;
  const out = `${dir}/${runId}.json`;
  const log = `${dir}/${runId}.log`;
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  // The result goes to a file, read back whole (an exec's output is capped);
  // the install's, the engine's and the worker's output go to a log, kept
  // in part when there is no result. Files of earlier runs are cleared.
  const command =
    `mkdir -p ${dir} && find ${dir} -type f -mmin +120 -delete; ` +
    `{ ${installRuntimeCommand()}; } > ${log} 2>&1; ` +
    `MAKO_SANDBOX_RESULT_FILE=${out} MAKO_SANDBOX_RUN_TIMEOUT_MS=${RUN_TIMEOUT_MS} ` +
    `MAKO_SANDBOX_ENGINE_DIR=${scratch}/mako-workflow-engine ` +
    `node "${RUNTIME_IN_BOX}/run.mjs" ${workflowId} ${encoded} >> ${log} 2>&1; true`;
  let execError: string | undefined;
  try {
    await provider.keepAlive(ctx, EXEC_TIMEOUT_MS).catch(() => undefined);
    const exec = await execInWorktree(handle, command, {
      timeoutMs: EXEC_TIMEOUT_MS,
      env: {
        WORKFLOWS_ROOT: provider.root(ctx),
        MAKO_URL: appsGitOriginBase(),
        MAKO_API_KEY: key,
      },
    });
    if (exec.timedOut) {
      execError = `The sandbox run did not end within ${EXEC_TIMEOUT_MS / 60_000} minutes.`;
    }
  } catch (error) {
    execError = error instanceof Error ? error.message : String(error);
  } finally {
    await removeKey(workspaceId, keyName).catch(error =>
      logger.warn("Could not remove a sandbox run's key", { error }),
    );
  }

  const read = (path: string) =>
    provider
      .readFile(ctx, path)
      .then(bytes => Buffer.from(bytes).toString("utf8"))
      .catch(() => null);
  const text = await read(out);
  let result: SandboxResult | undefined;
  if (text) {
    try {
      result = JSON.parse(text) as SandboxResult;
    } catch {
      // Not a result: reported below with the box's output.
    }
  }
  if (result) return { result };
  const boxLog = (await read(log))?.slice(-BOX_LOG_BYTES);
  return {
    error: execError ?? "The sandbox run did not finish.",
    boxLog: boxLog ?? undefined,
  };
}

/**
 * Start a sandbox run and answer it once it has ended: for the webhook test
 * URL, whose caller wants the finished run in the response.
 */
export async function runSandboxToEnd(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object = {},
) {
  const { runId, done } = await startSandboxRun(
    workspaceId,
    userId,
    workflowId,
    input,
  );
  await done;
  return readSandboxRun(workspaceId, userId, runId);
}
