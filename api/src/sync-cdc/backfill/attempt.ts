import type { IFlow } from "../../database/workspace-schema";
import { backfillResumeDue } from "../../inngest/functions/flow/infra-failure";

type BackfillState = NonNullable<IFlow["backfillState"]>;

export const MAX_BACKFILL_RECOVERY_FAILURES = 10;
// Give the Inngest flow's 5-minute start timeout and the worker another tick.
const DISPATCH_GRACE_MS = 10 * 60_000;
export const staleBackfillDispatchAt = (now: Date) =>
  new Date(+now - DISPATCH_GRACE_MS);

export interface BackfillAttempt {
  runId?: string;
  attemptId?: string;
}

/** The checkpoint ID survives a resume. The dispatch ID does not. */
export function backfillAttemptFilter(attempt: BackfillAttempt) {
  return {
    "backfillState.runId": attempt.runId ?? null,
    "backfillState.attemptId": attempt.attemptId ?? null,
  };
}

/** Compare the retry state we actually checked, not just the checkpoint ID. */
export function automaticRecoveryFilter(
  state: BackfillState | undefined,
  now: Date,
) {
  const pendingExpired =
    state?.status === "running" &&
    state.attemptId &&
    state.dispatchPendingAt &&
    state.dispatchPendingAt <= staleBackfillDispatchAt(now);
  if (
    (state?.status !== "error" && !pendingExpired) ||
    !state?.runId ||
    (state.consecutiveFailures ?? 0) >= MAX_BACKFILL_RECOVERY_FAILURES ||
    !backfillResumeDue(state, now)
  ) {
    return null;
  }
  return {
    ...backfillAttemptFilter(state),
    "backfillState.status": state.status,
    "backfillState.dispatchPendingAt": state.dispatchPendingAt ?? null,
    "backfillState.consecutiveFailures": state.consecutiveFailures ?? null,
    "backfillState.infraFailures": state.infraFailures ?? null,
    "backfillState.lastInfraFailureAt": state.lastInfraFailureAt ?? null,
    "backfillState.providerRetryAt": state.providerRetryAt ?? null,
  };
}

// The scheduled run uses a fresh checkpoint. Leave a throttled checkpoint
// to automatic recovery or an explicit operator action, even once due.
export const scheduledBackfillGate = {
  "backfillState.providerRetryAt": null,
  "backfillState.status": {
    $nin: ["running", "paused"] as ("running" | "paused")[],
  },
  streamState: { $ne: "paused" as const },
};
