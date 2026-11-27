/**
 * A sandbox run: `mako workflow run <name>` in a person's sandbox, the same
 * command as on their laptop, on their checkout as it is (uncommitted edits
 * included). It starts detached and answers a runId at once; the result is
 * the command's own JSON file in the box, read back on each status read.
 * Nothing waits in the API process, so neither a busy instance nor a deploy
 * ends a run. A run is in its person's box only, so only they read it.
 *
 * The steps call Mako with a key made for the run that acts as the person
 * (routes/workflows.ts), so a test can do what they can do. A run an agent
 * started (the in-chat agent, an MCP client) is marked on its key: through
 * connections it writes as the person, as their own run does; a dry run
 * records its writes under the run instead (workflows/recorded-writes.ts),
 * and a run started with an API key (CI, a script) has them refused.
 */
import { randomUUID } from "node:crypto";
import type { RunWrites } from "./runs";

import { appsGitOriginBase } from "../apps/config";
import { boxRunState, getSandboxProvider } from "../apps/sandbox/provider";
import {
  boxCtx,
  ensureWorkspaceWorktree,
  execInWorktree,
} from "../apps/worktree.service";
import { generateApiKey } from "../auth/api-key.middleware";
import {
  isUuidString,
  isUuidv7,
  legacyUserIdToUuidv7,
} from "../database/pg/id-codec";
import { loggers } from "../logging";
import { workspaceRepo } from "../repositories/workspaces";
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

const SANDBOX_KEY_PREFIX = sandboxKeyName("");

function userIdsEquivalent(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (
    isUuidString(a) &&
    isUuidString(b) &&
    a.toLowerCase() === b.toLowerCase()
  ) {
    return true;
  }
  // Decision #3 legacy userId <-> deterministic UUIDv7 equivalence:
  // `legacyUserIdToUuidv7(legacyId, createdAt)` derives bytes 6..15 (`slice(14)`)
  // solely from SHA-256(legacyId), so a PG UUIDv7 `createdBy` matches a sandbox
  // key named with the user's legacy ID (and vice versa) without a DB round-trip.
  if (isUuidv7(a) && !isUuidv7(b)) {
    return legacyUserIdToUuidv7(b, 0).slice(14) === a.toLowerCase().slice(14);
  }
  if (isUuidv7(b) && !isUuidv7(a)) {
    return legacyUserIdToUuidv7(a, 0).slice(14) === b.toLowerCase().slice(14);
  }
  return false;
}

/**
 * The sandbox run a run's key was made for (`keyNameOf`), or null for any
 * other key. Trust it only from a key Mako made (`recordWrites` on it).
 *
 * Accepts both legacy user IDs and Postgres UUIDv7 `createdBy` values (as well
 * as any additional creator aliases such as `c.get("user").id`) so mixed-stage
 * reads where `workspaces_core` returns a UUIDv7 while the key name embeds a
 * legacy user ID continue matching seamlessly.
 */
export function sandboxRunOfKey(
  key: { name?: string; createdBy?: unknown } | undefined,
  additionalCreatorIds?: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!key?.name || key.createdBy === undefined || key.createdBy === null) {
    return null;
  }
  const creatorId = String(key.createdBy);
  if (!creatorId || !key.name.startsWith(SANDBOX_KEY_PREFIX)) return null;
  const rest = key.name.slice(SANDBOX_KEY_PREFIX.length);
  const sep = rest.lastIndexOf(" ");
  if (sep <= 0) return null;
  const embeddedUserId = rest.slice(0, sep);
  const runId = rest.slice(sep + 1);
  if (!isSandboxRunId(runId)) return null;

  if (userIdsEquivalent(embeddedUserId, creatorId)) return runId;
  if (
    additionalCreatorIds?.some(
      alias =>
        typeof alias === "string" && userIdsEquivalent(embeddedUserId, alias),
    )
  ) {
    return runId;
  }
  return null;
}
const runsDir = (scratch: string) => `${scratch}/mako-workflow-runs`;

/** The person's run keys older than a run can live: none is in use. */
async function pruneRunKeys(workspaceId: string, userId: string) {
  const prefix = `${sandboxKeyName(userId)} sandbox-`;
  await workspaceRepo.pruneExpiredApiKeysByNamePrefix(
    workspaceId,
    prefix,
    new Date(Date.now() - RUN_LIFETIME_MS),
  );
}

/** Start `mako workflow run` in the person's sandbox; answers its runId. */
export async function startSandboxRun(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object = {},
  /**
   * What its connection writes do (runs.ts `RunWrites`): sent as the
   * person, recorded (a dry run), or refused (started with an API key).
   */
  { writes }: { writes: RunWrites },
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
  await setKey(workspaceId, userId, keyNameOf(userId, runId), key, {
    agentRun: writes === "refuse",
    recordWrites: writes === "record",
  });

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
  /** The typecheck's errors (`tsc` output): the run did not start. */
  typeErrors?: string;
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
    ...(result.typeErrors ? { typeErrors: text(result.typeErrors, max) } : {}),
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
  // Asking must not start a box, nor wake a paused one: the run view polls
  // this every 3 s, and every read below would resume the box. A paused box
  // answers PAUSED (not an active status, so the polling stops); any real
  // use of the box (opening the app, a command) resumes it, and the next
  // read gives the result.
  // Fresh, and tri-state: a failed lookup or a stale cache must never turn
  // a live run into PAUSED, because PAUSED stops the run view's polling.
  const state = await boxRunState(ctx, { fresh: true });
  if (state === "unknown") {
    return { runId, sandbox: true as const, status: "RUNNING", steps: [] };
  }
  if (state === "not-running") {
    if (await provider.hasSession(ctx)) {
      return {
        runId,
        sandbox: true as const,
        status: "PAUSED",
        error:
          "The sandbox is asleep. Open the app or run any command in it to wake it, then read this run again.",
        steps: [],
      };
    }
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
