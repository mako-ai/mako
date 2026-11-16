/**
 * Read sessions: one connector process for a whole entity read, pulled one
 * batch at a time (CONNECTOR_SESSION_READS).
 *
 * A chunk run (sync-box.ts `runConnectorCommand`) boots Node, imports the
 * SDK and loads the connector for every chunk: about 3 s of a warm E2B
 * chunk. A session pays that once per read. The connector reads chunk after
 * chunk (`mako-connector read --session`); the root supervisor in the box
 * cuts its output into one file per chunk (session-supervisor.ts); the API
 * reads those files in order.
 *
 * Calls per batch, on the critical path:
 * - batch 1: write the inputs, start (setup, launch, wait for batch 1), read.
 *   Three, as a chunk run.
 * - batch N > 1: one `readFile`, when the connector is ahead of the API,
 *   which it usually is: it keeps reading while the API writes the batch
 *   before. The acknowledgement of batch N - 1 goes out at the same time,
 *   off the critical path. A batch not written yet costs a `wait` first.
 * - the end: one `close`, after the last batch.
 *
 * Every call is pinned to the box the session started in. A pull in a box
 * replaced since reports the session `lost`, and the caller resumes from the
 * last applied state; a box replaced DURING a call throws
 * ConnectorSessionLostError, and the retry does the same.
 */
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
import {
  getSandboxProvider,
  isSandboxGone,
  type SandboxExecContext,
  type SandboxExecResult,
} from "../../apps/sandbox/provider";
import { loggers } from "../../logging";
import { incomingPath, runLayout } from "./run-isolation";
import { sessionLimits } from "./session-config";
import {
  ackScript,
  batchPath,
  closeScript,
  sessionLayout,
  SESSION_MARKER,
  startScript,
  tailPath,
  waitScript,
  type SessionLimits,
} from "./session-isolation";
import {
  ConnectorOutputTooLargeError,
  MAX_CONNECTOR_PROTOCOL_BYTES,
  connectorCommandLine,
  connectorRuntimeNode,
  forgetPreparedBox,
  parseProtocol,
  prepareBox,
  writeAll,
  type RunResult,
} from "./sync-box";

const logger = loggers.connector("session");

/** Where a session lives: what the next attempt needs to find it again. */
export interface SessionHandle {
  id: string;
  /** The sandbox it runs in; every call is pinned to it. */
  box?: string;
}

/** What asking for batch N gave. */
export type PullOutcome =
  /**
   * Batch N: its messages, as a chunk run's. `exitCode` is 0 while the
   * connector runs; the last batch of a failed read carries its exit code.
   */
  | { kind: "batch"; seq: number; result: RunResult }
  /** One batch passed the protocol cap: read it as a chunk, one page. */
  | { kind: "too-large"; limit: "bytes" | "messages" }
  /** The runner predates sessions: read as chunks. */
  | { kind: "unsupported" }
  /** No such session any more: start again from the last applied state. */
  | { kind: "lost"; reason: string };

export interface SessionStart {
  config?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  state?: Record<string, unknown> | unknown[];
  maxIterations?: number;
  maxBytes?: number;
  /** Mako's incremental anchor, kept in every chunk's state by the runner. */
  since?: string;
}

/** The seam SandboxedConnector reads through; tests replace it. */
export interface ReadSessionTransport {
  start(
    input: SessionStart,
  ): Promise<{ handle: SessionHandle; outcome: PullOutcome }>;
  /** Batch `seq`; acknowledges `seq - 1`, which the caller has applied. */
  pull(handle: SessionHandle, seq: number): Promise<PullOutcome>;
  /** End the session and remove everything of it. */
  close(handle: SessionHandle): Promise<void>;
}

/**
 * The box under a session was replaced during a call. The batch was not
 * read; the retry finds the session lost and resumes from the last applied
 * state in the new box.
 */
export class ConnectorSessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSessionLostError";
  }
}

/** How long one `wait` command waits in the box before reporting back. */
const WAIT_SLICE_MS = 20_000;
/** A batch that takes longer than this fails, as a chunk's timeout. */
const BATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** A complete batch file -> its messages, bounded as a chunk's output. */
export function parseBatch(
  raw: string,
  exitCode: number,
  stderr: string,
): RunResult {
  if (Buffer.byteLength(raw) > MAX_CONNECTOR_PROTOCOL_BYTES) {
    throw new ConnectorOutputTooLargeError(
      `Connector protocol output exceeded the ${MAX_CONNECTOR_PROTOCOL_BYTES} byte limit. Reduce the page or batch size.`,
      "bytes",
    );
  }
  const exec: SandboxExecResult = {
    exitCode,
    stdout: "",
    stderr,
    timedOut: false,
    durationMs: 0,
    truncated: false,
  };
  return parseProtocol(raw, "read", exec);
}

/**
 * How a session that ended answers a request for batch `seq`, given its
 * status (`reason`, the connector's exit code) and what followed its last
 * STATE (`tail`, null when nothing did).
 */
export function endedOutcome(input: {
  seq: number;
  reason: string;
  exitCode: number;
  tail: string | null;
  stderr: string;
}): PullOutcome {
  const { seq, exitCode, stderr } = input;
  switch (input.reason) {
    case "too-large-bytes":
      return { kind: "too-large", limit: "bytes" };
    case "too-large-messages":
      return { kind: "too-large", limit: "messages" };
    case "unsupported":
      return { kind: "unsupported" };
    case "done":
      // What followed the last STATE: the failed read's TRACE, its logs.
      if (input.tail !== null) {
        return {
          kind: "batch",
          seq,
          result: parseBatch(input.tail, exitCode, stderr),
        };
      }
      if (Number.isFinite(exitCode) && exitCode !== 0) {
        return { kind: "batch", seq, result: parseBatch("", exitCode, stderr) };
      }
      // Exit 0 and no batch where one was due: never a short success.
      return {
        kind: "lost",
        reason: `the connector exited before batch ${seq}`,
      };
    default:
      // deadline, abandoned, a supervisor that died: start again.
      return { kind: "lost", reason: `the session ended (${input.reason})` };
  }
}

/** Sessions need real Unix users: the box provider must have them. */
export function sessionReadsSupported(): boolean {
  return getSandboxProvider().supportsRunUsers === true;
}

function lastMarker(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith(`${SESSION_MARKER} `))
    .at(-1)
    ?.slice(SESSION_MARKER.length + 1)
    .trim();
}

/**
 * A session in a box with real Unix users, the workspace's sync box (the
 * path CONNECTOR_BOX_LEASES off takes).
 */
export function boxSessionTransport(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  connectorDir: string;
  entry?: string;
  limits?: SessionLimits;
  batchTimeoutMs?: number;
  waitSliceMs?: number;
  /**
   * Something of a run may have survived its cleanup: the caller kills the
   * box. Called before the error or result that follows.
   */
  onCleanupFailure: (reason: string) => Promise<void> | void;
  now?: () => number;
}): ReadSessionTransport {
  const { ctx } = input;
  const provider = () => getSandboxProvider();
  const limits = input.limits ?? sessionLimits();
  const batchTimeoutMs = input.batchTimeoutMs ?? BATCH_TIMEOUT_MS;
  const waitSliceMs = input.waitSliceMs ?? WAIT_SLICE_MS;
  const now = input.now ?? Date.now;

  const owner = (box: string | undefined) => ({
    asRoot: true as const,
    expectSandboxId: box,
  });

  const gone = (error: unknown, what: string): never => {
    forgetPreparedBox(ctx.sessionKey);
    throw new ConnectorSessionLostError(
      `The box under this read session was replaced while ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const readBatch = async (
    handle: SessionHandle,
    seq: number,
  ): Promise<PullOutcome> => {
    let bytes: Uint8Array;
    try {
      bytes = await provider().readFile(
        ctx,
        batchPath(handle.id, seq),
        owner(handle.box),
      );
    } catch (error) {
      if (isSandboxGone(error)) gone(error, `reading batch ${seq}`);
      throw error;
    }
    return {
      kind: "batch",
      seq,
      result: parseBatch(new TextDecoder().decode(bytes), 0, ""),
    };
  };

  /** A `wait` or `start` marker -> an outcome; null means "keep waiting". */
  const interpret = async (
    handle: SessionHandle,
    seq: number,
    marker: string,
    stderr: string,
  ): Promise<PullOutcome | null> => {
    const [kind, ...rest] = marker.split(/\s+/);
    if (kind === "ready") return readBatch(handle, seq);
    if (kind === "waiting") return null;
    if (kind === "gone") {
      return { kind: "lost", reason: "the session was reaped" };
    }
    if (kind === "acked") {
      return {
        kind: "lost",
        reason: `batch ${seq} was already taken by another attempt`,
      };
    }
    if (kind !== "ended") {
      throw new Error(
        `Unexpected read session report: ${marker.slice(0, 200)}`,
      );
    }
    const [reason, exitText, cleanupText, tailText] = rest;
    if (cleanupText !== "0") {
      await input.onCleanupFailure(
        `Connector session cleanup failed (exit ${cleanupText})`,
      );
    }
    let tail: string | null = null;
    if (reason === "done" && tailText && tailText !== "none") {
      try {
        tail = new TextDecoder().decode(
          await provider().readFile(
            ctx,
            tailPath(handle.id, seq),
            owner(handle.box),
          ),
        );
      } catch (error) {
        if (isSandboxGone(error)) gone(error, "reading the read's end");
        throw error;
      }
    }
    return endedOutcome({
      seq,
      reason,
      exitCode: Number(exitText),
      tail,
      stderr,
    });
  };

  /** Ask the box for batch `seq` until it is there or the session ended. */
  const waitFor = async (
    handle: SessionHandle,
    seq: number,
  ): Promise<PullOutcome> => {
    const giveUp = now() + batchTimeoutMs;
    for (;;) {
      let result: SandboxExecResult;
      try {
        result = await provider().exec(
          ctx,
          waitScript(handle.id, seq, seq - 1, waitSliceMs),
          { ...owner(handle.box), timeoutMs: waitSliceMs + 60_000 },
        );
      } catch (error) {
        if (isSandboxGone(error)) gone(error, `waiting for batch ${seq}`);
        throw error;
      }
      const marker = lastMarker(result.stdout);
      if (!marker) {
        throw new Error(
          `The read session's wait ended without its report${result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : "."}`,
        );
      }
      const outcome = await interpret(handle, seq, marker, result.stderr);
      if (outcome) return outcome;
      if (now() > giveUp) {
        await close(handle);
        throw new Error(
          `The connector produced no batch in ${Math.round(batchTimeoutMs / 1000)} s.`,
        );
      }
    }
  };

  const close = async (handle: SessionHandle): Promise<void> => {
    let detail: string;
    try {
      const result = await provider().exec(ctx, closeScript(handle.id), {
        ...owner(handle.box),
        timeoutMs: 60_000,
      });
      const marker = lastMarker(result.stdout);
      if (marker === "closed 0") return;
      detail = marker
        ? `${marker}: ${result.stderr.trim().slice(0, 500)}`
        : (result.stderr || `exit ${result.exitCode}`).slice(0, 500);
    } catch (error) {
      // A box that is gone took the session with it.
      if (isSandboxGone(error)) return;
      detail = error instanceof Error ? error.message : String(error);
    }
    logger.error("Failed to close a connector read session", {
      sessionId: handle.id,
      detail,
    });
    await input.onCleanupFailure(`Connector session cleanup failed: ${detail}`);
  };

  return {
    async start(start) {
      let pinned: string | undefined;
      try {
        pinned = await prepareBox(ctx);
      } catch (error) {
        if (isSandboxGone(error)) forgetPreparedBox(ctx.sessionKey);
        throw error;
      }
      const encoder = new TextEncoder();
      const inputs: Array<{ name: string; bytes: Uint8Array }> = [];
      for (const [name, value] of [
        ["config", start.config],
        ["catalog", start.catalog],
        ["state", start.state],
      ] as const) {
        if (value === undefined) continue;
        inputs.push({
          name: `${name}.json`,
          bytes: encoder.encode(JSON.stringify(value)),
        });
      }

      let lastError = "";
      // A random UID can collide with one in use; a fresh user fixes it.
      for (let attempt = 0; attempt < 3; attempt++) {
        const layout = sessionLayout(
          runLayout(
            randomBytes(8).toString("hex"),
            `mkc${randomBytes(6).toString("hex")}`,
            randomInt(200_000, 2_000_000_000),
            randomInt(200_000, 2_000_000_000),
          ),
        );
        const handle: SessionHandle = { id: layout.id, box: pinned };
        const finalInputs = inputs.map(file =>
          path.posix.join(layout.run.dir, file.name),
        );
        const command = connectorCommandLine({
          ctx,
          runtimeId: input.runtimeId,
          connectorDir: input.connectorDir,
          entry: input.entry,
          command: "read",
          inputs: finalInputs,
          maxIterations: start.maxIterations,
          maxBytes: start.maxBytes,
          extra: [
            "--session",
            ...(start.since ? ["--since", start.since] : []),
          ],
        });
        let result: SandboxExecResult;
        try {
          // Round trip 1: every input into the root-only inbox.
          await writeAll(
            ctx,
            inputs.map(file => ({
              path: incomingPath(layout.id, file.name),
              bytes: file.bytes,
            })),
            owner(pinned),
          );
          // Round trip 2: setup, launch, wait for batch 1.
          result = await provider().exec(
            ctx,
            startScript({
              layout,
              inputs: finalInputs,
              command,
              node: connectorRuntimeNode(ctx, input.runtimeId),
              limits,
              waitMs: waitSliceMs,
            }),
            { ...owner(pinned), timeoutMs: waitSliceMs + 120_000 },
          );
        } catch (error) {
          if (isSandboxGone(error)) gone(error, "starting");
          // Cut off: the session may be running, with the credential on disk.
          await close(handle);
          throw error;
        }
        const marker = lastMarker(result.stdout);
        if (!marker) {
          await close(handle);
          throw new Error(
            `The read session ended its start without its report${result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : "."}`,
          );
        }
        if (marker === "setup-failed") {
          lastError = (result.stderr || result.stdout).trim().slice(0, 2000);
          // A fresh UID fixes a collision, never an account that cannot be
          // locked: refuse at once, as a chunk run does.
          if (
            /empty passwords left|could not lock|could not move/.test(lastError)
          ) {
            logger.error(
              "Could not lock passwordless accounts in a connector box",
              {
                sessionKey: ctx.sessionKey,
                detail: lastError.slice(0, 500),
              },
            );
            break;
          }
          continue;
        }
        if (marker === "inputs-missing") {
          forgetPreparedBox(ctx.sessionKey);
          throw new Error(
            "The connector's inputs are missing: its box was replaced before the read.",
          );
        }
        if (marker.startsWith("box-unclean")) {
          await input.onCleanupFailure(
            `An earlier read session's cleanup failed in this box (${marker})`,
          );
          throw new Error(
            "A connector box held what an earlier read left behind; it was killed. Retry.",
          );
        }
        let outcome = await interpret(handle, 1, marker, result.stderr);
        if (!outcome) outcome = await waitFor(handle, 1);
        return { handle, outcome };
      }
      throw new Error(
        `Could not create an isolated user for the read session${lastError ? `: ${lastError}` : "."}`,
      );
    },

    async pull(handle, seq) {
      let current: string | undefined;
      try {
        current = await prepareBox(ctx);
      } catch (error) {
        if (isSandboxGone(error)) forgetPreparedBox(ctx.sessionKey);
        throw error;
      }
      if (handle.box && current && handle.box !== current) {
        return { kind: "lost", reason: "its box was replaced" };
      }
      if (seq > 1) {
        // Batch seq - 1 is applied: free its slot. Off the critical path.
        void provider()
          .exec(ctx, ackScript(handle.id, seq - 1), {
            ...owner(handle.box),
            timeoutMs: 30_000,
          })
          .catch(error =>
            logger.warn("Could not acknowledge a read session batch", {
              sessionId: handle.id,
              seq: seq - 1,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      // One call when the connector is ahead, which is the point.
      try {
        return await readBatch(handle, seq);
      } catch (error) {
        if (error instanceof ConnectorSessionLostError) throw error;
        if (error instanceof ConnectorOutputTooLargeError) throw error;
        // Not written yet, or the session ended: ask the box.
      }
      return waitFor(handle, seq);
    },

    close,
  };
}
