/**
 * Long-poll core for the `check_query_status` agent tool.
 *
 * WHY THIS EXISTS: an LLM cannot sleep between tool calls. When
 * `check_query_status` returned instantly while a console run was still
 * `running`, the model would re-invoke it every ~1s — producing dozens of
 * back-to-back polls (observed: ~50 polls in ~100s near the 5-min cap) that
 * flood the chat UI and make it jump around. The fix is to make each poll
 * BLOCK server-side until the run settles or a bounded wait window elapses, so
 * the agent only gets a turn back roughly once per interval no matter how
 * eagerly it calls the tool. This does NOT change the hard execution cap — the
 * query keeps running server-side and is still aborted at its own ceiling.
 *
 * The logic is kept dependency-free (no Mongoose / services) so it is unit
 * testable in isolation with a fake run reader.
 */

/** Subset of the persisted `SavedConsole.lastRun` artifact this poll reads. */
export interface PollRunArtifact {
  status: "running" | "success" | "error" | "cancelled" | (string & {});
  executionId?: string;
  rowCount?: number;
  durationMs?: number;
  sampleRows?: unknown[];
  error?: string;
  startedAt?: Date | string;
  at: Date | string;
}

/** What a single read of the latest run yields. */
export type ReadRunResult =
  | { ok: true; lastRun?: PollRunArtifact | null }
  | { ok: false; error: string };

export interface PollRunStatusOptions {
  /** Re-reads the authoritative latest run each iteration. */
  readRun: () => Promise<ReadRunResult>;
  /** The executionId the caller pinned, if any (detects a superseding run). */
  executionId?: string;
  /** Max time to block before handing a "running" turn back (ms). */
  waitMs: number;
  /** How often to re-read while waiting (ms). */
  intervalMs: number;
  /** Turn abort signal: ends the wait early (explicit Stop / turn end). */
  signal?: AbortSignal;
  /** Max preview rows to surface on success. */
  previewMaxRows?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_PREVIEW_MAX_ROWS = 50;

/**
 * Sleep that resolves early if the turn is aborted. Exported so the tool and
 * tests share one implementation.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Block until the polled run settles (success/error/cancelled/superseded) or
 * the wait window elapses, then return the tool result payload. Re-reads the
 * run on every iteration so a status change is observed promptly.
 */
export async function pollRunStatus(
  options: PollRunStatusOptions,
): Promise<Record<string, unknown>> {
  const {
    readRun,
    executionId,
    waitMs,
    intervalMs,
    signal,
    previewMaxRows = DEFAULT_PREVIEW_MAX_ROWS,
    now = () => Date.now(),
    sleep = abortableSleep,
  } = options;

  const deadline = now() + waitMs;

  for (;;) {
    const read = await readRun();
    if (!read.ok) return { success: false, error: read.error };

    const lastRun = read.lastRun;
    if (!lastRun) {
      return {
        success: false,
        error:
          "No run found for this console yet. Use run_console to execute the query first.",
      };
    }

    // A newer run on the same console supersedes the one being polled.
    if (
      executionId &&
      lastRun.executionId &&
      lastRun.executionId !== executionId
    ) {
      return {
        success: true,
        status: "superseded",
        message:
          "A newer run has started on this console; the execution you polled is no longer the latest. Re-run or check the latest run instead.",
        latestExecutionId: lastRun.executionId,
        latestStatus: lastRun.status,
      };
    }

    if (lastRun.status === "success") {
      return {
        success: true,
        status: "success",
        rowCount: lastRun.rowCount ?? 0,
        durationMs: lastRun.durationMs,
        preview: (lastRun.sampleRows ?? []).slice(0, previewMaxRows),
        message: `Query finished: ${lastRun.rowCount ?? 0} row(s).`,
      };
    }

    if (lastRun.status === "cancelled") {
      return {
        success: true,
        status: "cancelled",
        error: lastRun.error || "Query was cancelled.",
      };
    }

    if (lastRun.status !== "running") {
      return {
        success: false,
        status: "error",
        error: lastRun.error || "Query failed.",
      };
    }

    // Still running: give up the wait once the window is exhausted or the turn
    // is aborted; otherwise sleep a short interval and re-check.
    const current = now();
    if (current >= deadline || signal?.aborted) {
      const startedAtMs = lastRun.startedAt
        ? new Date(lastRun.startedAt).getTime()
        : new Date(lastRun.at).getTime();
      return {
        success: true,
        status: "running",
        executionId: lastRun.executionId,
        elapsedMs: Math.max(0, current - startedAtMs),
        message:
          "Still running. Call check_query_status again to keep waiting " +
          "(each call already blocks server-side), or escalate to the user.",
      };
    }

    await sleep(Math.min(intervalMs, deadline - current), signal);
  }
}
