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
  if (
    state?.status !== "error" ||
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

export function expiredBackfillDispatchFilter(
  state: BackfillState | undefined,
  now: Date,
) {
  if (
    state?.status !== "running" ||
    !state.runId ||
    !state.attemptId ||
    !state.dispatchPendingAt ||
    state.dispatchPendingAt > staleBackfillDispatchAt(now)
  ) {
    return null;
  }
  return {
    ...backfillAttemptFilter(state),
    "backfillState.status": "running" as const,
    "backfillState.dispatchPendingAt": state.dispatchPendingAt,
  };
}

/** A completed attempt keeps its dispatch ID but releases its checkpoint. */
export function completedBackfillAttemptFilter(attemptId: string) {
  return {
    "backfillState.attemptId": attemptId,
    "backfillState.status": "completed" as const,
    "backfillState.runId": null,
  };
}

// Leave a throttled checkpoint to automatic recovery while it has budget.
// After both the cap and the deadline, the next scheduled run may reconcile.
export const scheduledBackfillGate = (now: Date) => ({
  $or: [
    { "backfillState.providerRetryAt": null },
    {
      "backfillState.status": "error" as const,
      "backfillState.providerRetryAt": { $lte: now },
      "backfillState.consecutiveFailures": {
        $gte: MAX_BACKFILL_RECOVERY_FAILURES,
      },
    },
  ],
  "backfillState.status": {
    $nin: ["running", "paused"] as ("running" | "paused")[],
  },
  streamState: { $ne: "paused" as const },
});
