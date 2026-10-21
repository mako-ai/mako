/**
 * A sandbox run: `mako workflow run <name>` in a person's sandbox, the same
 * command as on their laptop, on their checkout as it is (uncommitted edits
 * included). It starts detached and answers a runId at once; the result is
 * the command's own JSON file in the box, read back on each status read.
 * Nothing waits in the API process, so neither a busy instance nor a deploy
 * ends a run. A run is in its person's box only, so only they read it.
 *
 * The steps call Mako with a key made for the run that acts as the person
 * (routes/workflows.ts), so a test can do what they can do.
 */
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";

import { appsGitOriginBase } from "../apps/config";
import { getSandboxProvider } from "../apps/sandbox/provider";
import {
  boxCtx,
  ensureWorkspaceWorktree,
  execInWorktree,
} from "../apps/worktree.service";
import { generateApiKey } from "../auth/api-key.middleware";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { HatchetError } from "./hatchet";
import { removeKey, setKey } from "./on-push";
import { RUNTIME_IN_BOX, installRuntimeCommand } from "./runtime-files";
import { sandboxKeyName } from "./worker-key";

const logger = loggers.api("workflows-sandbox");

const RUN_ID = /^sandbox-[0-9a-f-]{36}$/;
export const isSandboxRunId = (runId: string) => RUN_ID.test(runId);

/** How long a started run keeps its box awake; a run's key lives as long. */
const RUN_LIFETIME_MS = 60 * 60_000;
const SUMMARY_CHARS = 2000;
const SUMMARY_LINES = 20;
const LOG_TAIL_CHARS = 4000;
/**
 * The most a whole run's answer may hold: an MCP reply is cut at 200 000
 * characters (mcp/mako-mcp-server.ts), which would break its JSON. A longer
 * run is answered with its texts cut down, and its result file named.
 */
const REPLY_BUDGET = 180_000;

const keyNameOf = (userId: string, runId: string) =>
  `${sandboxKeyName(userId)} ${runId}`;
const runsDir = (scratch: string) => `${scratch}/mako-workflow-runs`;

/** The person's run keys older than a run can live: none is in use. */
async function pruneRunKeys(workspaceId: string, userId: string) {
  const prefix = `${sandboxKeyName(userId)} sandbox-`;
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    {
      $pull: {
        apiKeys: {
          name: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` },
          createdAt: { $lt: new Date(Date.now() - RUN_LIFETIME_MS) },
        },
      },
    },
  );
}

/** Start `mako workflow run` in the person's sandbox; answers its runId. */
export async function startSandboxRun(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object = {},
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId)) {
    throw new HatchetError(`Invalid workflow: ${workflowId}`, 400);
  }
  const provider = getSandboxProvider();
  const handle = await ensureWorkspaceWorktree(workspaceId, userId);
  const ctx = boxCtx(handle);
  const runId = `sandbox-${randomUUID()}`;
  await pruneRunKeys(workspaceId, userId);
  const { key } = generateApiKey();
  await setKey(workspaceId, userId, keyNameOf(userId, runId), key);

  const dir = runsDir(provider.scratch(ctx));
  const file = `${dir}/${runId}`;
  const input64 = Buffer.from(JSON.stringify(input)).toString("base64");
  // Install the runtime, run the command; its exit code marks the end even
  // when there is no result (a crash, a failed install).
  const script = [
    `echo $$ > ${file}.pid;`,
    `{ ${installRuntimeCommand()}; } > ${file}.log 2>&1 &&`,
    `node "${RUNTIME_IN_BOX}/run.mjs" ${workflowId} ${input64} ${file}.json >> ${file}.log 2>&1;`,
    `echo $? > ${file}.exit`,
  ].join(" ");
  const encoded = Buffer.from(script).toString("base64");
  // The box is up, and its runs folder exists, before the detached start.
  await execInWorktree(handle, `mkdir -p ${dir}`);
  await provider
    .keepAlive(ctx, RUN_LIFETIME_MS)
    .catch(error =>
      logger.warn("Could not keep the sandbox awake for a run", { error }),
    );
  await provider.execDetached(
    ctx,
    `nohup sh -c "$(echo ${encoded} | base64 -d)" > /dev/null 2>&1 &`,
    {
      env: {
        WORKFLOWS_ROOT: provider.root(ctx),
        MAKO_URL: appsGitOriginBase(),
        MAKO_API_KEY: key,
      },
    },
  );
  return { runId };
}

/** What `mako workflow run` writes (packages/cli/src/workflow-runner.js). */
export type RunResult = {
  workflow: string;
  input: unknown;
  status: string;
  startedAt: string;
  durationMs: number;
  tasks: Array<{
    name: string;
    status: string;
    attempts: number;
    durationMs?: number;
    output?: unknown;
    error?: string;
    logs: Array<{ at: string; level: string; message: string }>;
  }>;
};

const text = (value: unknown, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const all = typeof value === "string" ? value : JSON.stringify(value);
  return all.length <= max
    ? all
    : `${all.slice(0, max)}… (${all.length} chars)`;
};

/** A run as an agent or a screen reads it: a summary, or all of it. */
export function shapeSandboxRun(
  runId: string,
  result: RunResult,
  full = false,
  /** Each text's cap and a step's last lines, when the whole run is too big. */
  cut?: { chars: number; lines: number },
) {
  const max = cut?.chars ?? (full ? Number.POSITIVE_INFINITY : SUMMARY_CHARS);
  const keep = cut?.lines ?? (full ? Number.POSITIVE_INFINITY : SUMMARY_LINES);
  return {
    runId,
    sandbox: true as const,
    workflowId: result.workflow,
    status: result.status,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    input: text(result.input, max),
    steps: result.tasks.map(task => {
      const lines = task.logs.map(line => `${line.level}: ${line.message}`);
      const shown = Number.isFinite(keep) ? lines.slice(-keep) : lines;
      return {
        step: task.name,
        status: task.status,
        attempt: task.attempts,
        durationMs: task.durationMs,
        output: text(task.output, max),
        error: text(task.error, max),
        logs: shown,
        ...(shown.length < lines.length
          ? { logLinesOmitted: lines.length - shown.length }
          : {}),
      };
    }),
  };
}

/**
 * A sandbox run, read from the person's box: ended (its result, or why there
 * is none) or still running.
 */
export async function readSandboxRun(
  workspaceId: string,
  userId: string,
  runId: string,
  { full = false }: { full?: boolean } = {},
) {
  if (!isSandboxRunId(runId)) throw new HatchetError("Invalid run id", 400);
  const provider = getSandboxProvider();
  const handle = await ensureWorkspaceWorktree(workspaceId, userId);
  const ctx = boxCtx(handle);
  const failed = (error: string, log?: string) => ({
    runId,
    sandbox: true as const,
    status: "FAILED",
    error,
    ...(log ? { log: full ? log : log.slice(-LOG_TAIL_CHARS) } : {}),
    steps: [],
  });
  const done = <T>(answer: T) => {
    // An ended run's key is no longer needed.
    removeKey(workspaceId, keyNameOf(userId, runId)).catch(error =>
      logger.warn("Could not remove a sandbox run's key", { error }),
    );
    return answer;
  };
  // Asking must not start a box: a box that is gone took the run with it.
  if (!(await provider.hasSession(ctx))) {
    return done(
      failed("The sandbox stopped before the run ended. Start it again."),
    );
  }
  const file = `${runsDir(provider.scratch(ctx))}/${runId}`;
  const read = (suffix: string) =>
    provider
      .readFile(ctx, `${file}.${suffix}`)
      .then(bytes => Buffer.from(bytes).toString("utf8"))
      .catch(() => null);
  // The result, or the exit code of a run that ended without one.
  const end = async () => {
    const json = await read("json");
    if (json) {
      const result = JSON.parse(json) as RunResult;
      // The whole run in the box, for what does not fit in an answer.
      let run = {
        ...shapeSandboxRun(runId, result, full),
        resultFile: `${file}.json`,
      };
      for (
        let chars = 50_000;
        full && JSON.stringify(run).length > REPLY_BUDGET && chars >= 500;
        chars = Math.floor(chars / 4)
      ) {
        run = {
          ...shapeSandboxRun(runId, result, true, { chars, lines: 200 }),
          resultFile: `${file}.json`,
          cut: `Too large to answer whole: each text is cut at ${chars} characters and a step's logs to its last 200 lines. All of it is in resultFile, in your sandbox (read it with workflow_bash: node -e or jq).`,
        } as typeof run;
      }
      return done(run);
    }
    const exit = await read("exit");
    if (exit === null) return null;
    return done(
      failed(
        `The run ended without a result (exit code ${exit.trim()}).`,
        (await read("log")) ?? undefined,
      ),
    );
  };
  const ended = await end();
  if (ended) return ended;
  // Still going, unless its process is gone (the box restarted). A process
  // that just ended has written its end by now: read it again first.
  const pid = (await read("pid"))?.trim();
  if (pid) {
    const alive = await execInWorktree(handle, `kill -0 ${Number(pid)}`)
      .then(r => r.exitCode === 0)
      .catch(() => true);
    if (!alive) {
      return (
        (await end()) ??
        done(
          failed(
            "The run's process stopped before it ended. Start it again.",
            (await read("log")) ?? undefined,
          ),
        )
      );
    }
  }
  return { runId, sandbox: true as const, status: "RUNNING", steps: [] };
}
