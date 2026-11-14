/**
 * Liveness and live-log writes to a `flow_executions` document, shared by
 * the flow function and the backfill entity worker (previously copy-pasted
 * in both, each ending in `.catch(() => {})`).
 *
 * Both writes are best-effort: a failed heartbeat must not fail the sync.
 * But they must not fail SILENTLY either — `cleanup-abandoned-flows` marks a
 * run abandoned after 10 minutes without a heartbeat, so heartbeats that
 * quietly stop landing (pool exhaustion, a Mongo blip) turn a healthy long
 * run into an "abandoned" one and reset its backfill gate. Failures are
 * logged at warn, throttled so a sustained outage does not flood the log.
 *
 * Long work inside ONE step (a page loop, a bulk flush, a merge) has no
 * natural write between its start and its end, so it is wrapped in
 * `withHeartbeat`, which keeps touching the heartbeat on a timer well below
 * the staleness threshold. Both numbers derive from one constant.
 */
import { Types } from "mongoose";

import { FlowExecution } from "../database/workspace-schema";
import { loggers } from "../logging";

const log = loggers.inngest("execution-tracking");

/**
 * A running execution whose heartbeat is older than this is considered
 * dead: `cleanup-abandoned-flows` and backfill recovery mark it abandoned.
 */
export const EXECUTION_HEARTBEAT_STALE_MS = 10 * 60_000;

/**
 * How often `withHeartbeat` touches the heartbeat during long work: a fifth
 * of the threshold, so four consecutive missed touches (a Mongo blip, a
 * blocked event loop) still do not make a live run look abandoned.
 */
export const EXECUTION_HEARTBEAT_INTERVAL_MS = EXECUTION_HEARTBEAT_STALE_MS / 5;

/** At most one warn per kind per window; the rest are counted. */
const WARN_WINDOW_MS = 60_000;

type WriteKind = "heartbeat" | "log";

const warnState: Record<WriteKind, { lastAt: number; suppressed: number }> = {
  heartbeat: { lastAt: 0, suppressed: 0 },
  log: { lastAt: 0, suppressed: 0 },
};

function warnWriteFailed(
  kind: WriteKind,
  executionId: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  const state = warnState[kind];
  const now = Date.now();
  if (now - state.lastAt < WARN_WINDOW_MS) {
    state.suppressed++;
    return;
  }
  const suppressed = state.suppressed;
  state.lastAt = now;
  state.suppressed = 0;
  log.warn(
    kind === "heartbeat"
      ? "Failed to write flow execution heartbeat"
      : "Failed to append flow execution log",
    {
      executionId,
      ...extra,
      suppressedSinceLastWarn: suppressed,
      error: error instanceof Error ? error.message : String(error),
    },
  );
}

/** Test seam: forget the throttle window. */
export function resetExecutionTrackingWarnThrottle(): void {
  for (const state of Object.values(warnState)) {
    state.lastAt = 0;
    state.suppressed = 0;
  }
}

function executionObjectId(executionId: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(executionId)
    ? new Types.ObjectId(executionId)
    : null;
}

/** Bump `lastHeartbeat`. Never rejects; failures are logged at warn. */
export async function touchExecutionHeartbeat(
  executionId: string | undefined,
): Promise<void> {
  if (!executionId) return;
  const _id = executionObjectId(executionId);
  if (!_id) return;
  try {
    await FlowExecution.collection.updateOne(
      { _id },
      { $set: { lastHeartbeat: new Date() } },
    );
  } catch (error) {
    warnWriteFailed("heartbeat", executionId, error);
  }
}

export type ExecutionLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Push one log line onto the execution (keeping the last 200), bump the
 * heartbeat, and record per-entity progress when the metadata carries
 * `entity` / `totalProcessed` so UI counters move while a chunk runs.
 * Never rejects; failures are logged at warn.
 */
export async function appendExecutionLog(params: {
  executionId: string | undefined;
  flowId: string;
  level: ExecutionLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { executionId, flowId, level, message, metadata } = params;
  if (!executionId) return;
  const _id = executionObjectId(executionId);
  if (!_id) return;

  const entity =
    metadata && typeof metadata.entity === "string"
      ? metadata.entity
      : undefined;
  const totalProcessed =
    metadata && typeof metadata.totalProcessed === "number"
      ? metadata.totalProcessed
      : undefined;

  const now = new Date();
  const $set: Record<string, unknown> = { lastHeartbeat: now };
  const updateDoc: Record<string, unknown> = {
    $set,
    $push: {
      logs: {
        $each: [
          {
            timestamp: now,
            level,
            message,
            metadata: { flowId, executionId, ...metadata },
          },
        ],
        $slice: -200,
      },
    },
  };
  if (entity) {
    $set["stats.currentEntity"] = entity;
  }
  if (entity && totalProcessed !== undefined) {
    updateDoc.$max = { [`stats.entityStats.${entity}`]: totalProcessed };
    $set[`stats.entityStatus.${entity}`] = "syncing";
  }

  try {
    await FlowExecution.collection.updateOne({ _id }, updateDoc);
  } catch (error) {
    warnWriteFailed("log", executionId, error, { flowId });
  }
}

/**
 * Run `fn` while keeping the execution's heartbeat alive: one touch up
 * front, then one every `intervalMs` until `fn` settles. The timer is
 * unref'd (it never keeps the process alive) and always cleared, on success
 * and on throw. A failed touch never fails `fn`: `touchExecutionHeartbeat`
 * does not reject (it logs, throttled), and a touch still in flight when the
 * next tick fires is not doubled up.
 */
export async function withHeartbeat<T>(
  executionId: string | undefined,
  fn: () => Promise<T>,
  intervalMs: number = EXECUTION_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  if (!executionId) return fn();

  let inFlight: Promise<void> | null = null;
  const touch = (): void => {
    if (inFlight) return;
    inFlight = touchExecutionHeartbeat(executionId)
      .catch(() => {
        // Never rejects today; belt and braces for the timer callback.
      })
      .finally(() => {
        inFlight = null;
      });
  };

  touch();
  const timer = setInterval(touch, intervalMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
