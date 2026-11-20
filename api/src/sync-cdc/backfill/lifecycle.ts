/**
 * Backfill and stream lifecycle for a CDC flow: start (or resume from a
 * checkpoint), pause, cancel and resume a backfill; pause and resume the stream.
 */
import * as crypto from "crypto";
import { Types } from "mongoose";
import {
  Flow,
  FlowExecution,
  type IFlow,
} from "../../database/workspace-schema";
import { inngest } from "../../inngest/client";
import { carriedInfraBackoff } from "../../inngest/functions/flow/infra-failure";
import { loggers } from "../../logging";
import { normalizeEntityList } from "../entity-selection";
import { getCdcEventStore } from "../event-store";
import { cdcSyncStateService } from "../sync-state";

import {
  automaticRecoveryFilter,
  backfillAttemptFilter,
  scheduledBackfillGate,
} from "./attempt";
import { forceDrainCdcFlow } from "./completion";
import {
  assertCanStartBackfill,
  cancelInngestFlowRuns,
} from "./execution-guard";
import { drainPendingWebhookEvents } from "./webhook-maintenance";

const log = loggers.sync("cdc.backfill");

function createBackfillRunId(flowId: string): string {
  return `backfill:${flowId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

function createBackfillTriggerEventId(flowId: string, runId: string): string {
  return `cdc-backfill:${flowId}:${runId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

export async function startBackfill(
  workspaceId: string,
  flowId: string,
  options?: {
    reuseExistingRunId?: boolean;
    automaticRecovery?: NonNullable<IFlow["backfillState"]>;
    entities?: string[];
    reason?: string;
    /**
     * "scheduled" lets eligible entities fetch incrementally (see
     * backfill-fetch-mode.ts). Default: a resumed run keeps its trigger,
     * anything else is "manual" (full).
     */
    trigger?: "scheduled" | "manual";
  },
): Promise<{ runId: string; reusedRunId: boolean }> {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Backfill start requires syncEngine=cdc");
  }

  const shouldReuseRunId = options?.reuseExistingRunId === true;
  const requestedEntities = normalizeEntityList(options?.entities);
  const scopeFromFlow =
    flow.backfillState?.scope?.mode === "subset" &&
    Array.isArray(flow.backfillState.scope.entities)
      ? normalizeEntityList(flow.backfillState.scope.entities)
      : [];
  const effectiveScope =
    requestedEntities.length > 0
      ? requestedEntities
      : shouldReuseRunId
        ? scopeFromFlow
        : [];

  log.info("startBackfill: pre-check starting", {
    flowId,
    workspaceId,
    currentBackfillStatus: flow.backfillState?.status,
    currentRunId: flow.backfillState?.runId,
    reuseExistingRunId: shouldReuseRunId,
    entities: effectiveScope.length > 0 ? effectiveScope : "all",
  });
  const preCheckStart = Date.now();
  const scopedFlow = { _id: flow._id, workspaceId: flow.workspaceId };
  const recoveryState = options?.automaticRecovery;
  const scheduledStart = options?.trigger === "scheduled" && !recoveryState;
  const automatic = Boolean(recoveryState || scheduledStart);
  if (automatic) {
    if (
      await FlowExecution.exists({
        flowId: flow._id,
        workspaceId: flow.workspaceId,
        status: "running",
      })
    ) {
      throw new Error(
        "Cannot start automatic backfill while an execution is running",
      );
    }
  } else {
    await assertCanStartBackfill(workspaceId, flowId);
  }
  const preCheckMs = Date.now() - preCheckStart;
  if (preCheckMs > 5000) {
    log.warn("startBackfill: pre-check was slow", {
      flowId,
      preCheckMs,
    });
  }

  const cancelLingering = () =>
    Promise.all([
      inngest.send({ name: "flow.cancel", data: { flowId } }),
      cancelInngestFlowRuns(flowId),
    ]);
  if (!automatic) await cancelLingering();

  const runId =
    shouldReuseRunId && flow.backfillState?.runId
      ? flow.backfillState.runId
      : createBackfillRunId(flowId);
  const reusedRunId = Boolean(shouldReuseRunId && flow.backfillState?.runId);
  const previousFailures = flow.backfillState?.consecutiveFailures ?? 0;
  const trigger: "scheduled" | "manual" =
    options?.trigger ??
    (reusedRunId && flow.backfillState?.trigger === "scheduled"
      ? "scheduled"
      : "manual");
  const now = new Date();
  const infraBackoff = carriedInfraBackoff(flow.backfillState, reusedRunId);
  const triggerEventId = createBackfillTriggerEventId(flowId, runId);
  const nextState: NonNullable<IFlow["backfillState"]> = {
    status: "running",
    runId,
    attemptId: triggerEventId,
    dispatchPendingAt: now,
    startedAt: reusedRunId ? flow.backfillState?.startedAt || now : now,
    completedAt: undefined,
    consecutiveFailures: previousFailures,
    ...infraBackoff,
    scope: {
      mode: effectiveScope.length > 0 ? "subset" : "all",
      entities: effectiveScope,
    },
    trigger,
  };
  if (automatic) {
    const gate = recoveryState
      ? automaticRecoveryFilter(recoveryState, now)
      : {
          ...scheduledBackfillGate,
          ...backfillAttemptFilter(flow.backfillState ?? {}),
        };
    if (!gate) throw new Error("Automatic backfill is no longer due");
    const claim = await Flow.updateOne(
      { ...scopedFlow, ...gate },
      { $set: { backfillState: nextState } },
    );
    if (!claim.modifiedCount) {
      throw new Error("Automatic backfill lost its claim");
    }
  } else {
    flow.backfillState = nextState;
    await flow.save();
  }

  const reason =
    options?.reason ||
    (reusedRunId
      ? `Backfill resumed from checkpoint (runId reused, attempt ${previousFailures + 1})`
      : "Backfill started via API");

  log.info(reason, {
    flowId,
    runId,
    reusedRunId,
    consecutiveFailures: previousFailures,
    scope: effectiveScope.length > 0 ? effectiveScope : "all",
  });

  const ownership = {
    ...scopedFlow,
    ...backfillAttemptFilter(nextState),
    "backfillState.status": "running" as const,
  };
  let sendResult;
  try {
    // Automatic starts never cancel flow-wide work. A queued event is fenced
    // by its attempt ID and Inngest's per-flow concurrency.
    if (!(await Flow.exists(ownership))) {
      throw new Error("Backfill start was superseded");
    }
    sendResult = await inngest.send({
      id: triggerEventId,
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true,
        backfill: true,
        triggerType: "manual",
        backfillRunId: runId,
        backfillAttemptId: triggerEventId,
        ...(effectiveScope.length > 0
          ? { backfillEntities: effectiveScope }
          : {}),
      },
    });
  } catch (error) {
    // Leave a paused or replaced attempt alone. Restore the prior checkpoint
    // after a failed automatic dispatch so the scheduler can try again.
    if (automatic) {
      if (flow.backfillState) {
        await Flow.updateOne(ownership, {
          $set: { backfillState: flow.backfillState },
        });
      } else {
        await Flow.updateOne(ownership, { $unset: { backfillState: 1 } });
      }
    }
    throw error;
  }

  log.info("Backfill flow.execute event sent to Inngest", {
    flowId,
    runId,
    triggerEventId,
    inngestEventIds: sendResult?.ids,
  });

  return { runId, reusedRunId };
}

export async function pauseBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Pause requires syncEngine=cdc");
  }

  const transition = await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "PAUSE", reason: "Paused via API" },
  });
  if (transition.toState !== "paused") {
    return {
      paused: false,
      cancelledExecutionId: null,
      runId: flow.backfillState?.runId ?? null,
    };
  }

  // Send cancel to Inngest so it stops the function between steps.
  // The FlowExecution stays "running" so assertCanStartBackfill()
  // blocks new starts until the Inngest function actually exits.
  const runningExecution = await FlowExecution.findOne({
    flowId: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
    status: "running",
  })
    .sort({ startedAt: -1 })
    .lean();

  if (runningExecution) {
    await inngest.send({
      name: "flow.cancel",
      data: {
        flowId: flow._id.toString(),
        executionId: runningExecution._id.toString(),
      },
    });
  }

  return {
    paused: true,
    cancelledExecutionId: runningExecution?._id?.toString() || null,
    runId: flow.backfillState?.runId || null,
  };
}

export async function cancelBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Cancel requires syncEngine=cdc");
  }

  const transition = await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "CANCEL", reason: "Cancelled via API" },
    expectedAttempt: flow.backfillState ?? {},
  });
  if (!transition.changed) {
    return { cancelled: false, cancelledExecutionId: null };
  }

  const runningExecution = await FlowExecution.findOne({
    flowId: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
    status: "running",
  })
    .sort({ startedAt: -1 })
    .lean();

  if (runningExecution) {
    await inngest.send({
      name: "flow.cancel",
      data: {
        flowId: flow._id.toString(),
        executionId: runningExecution._id.toString(),
      },
    });
  }

  return {
    cancelled: true,
    cancelledExecutionId: runningExecution?._id?.toString() || null,
  };
}

export async function resumeBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Resume requires syncEngine=cdc");
  }

  await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "RESUME", reason: "Backfill resumed via API" },
  });

  const pending = await getCdcEventStore().countEvents({
    workspaceId,
    flowId,
    materializationStatus: "pending",
  });
  if (pending > 0) {
    try {
      await forceDrainCdcFlow({
        workspaceId,
        flowId,
      });
    } catch (error) {
      log.warn("Failed to schedule CDC drain after resume", {
        flowId,
        workspaceId,
        pendingBacklog: pending,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const webhookEventsDrained = await drainPendingWebhookEvents(
    workspaceId,
    flowId,
    "resume",
  );

  let resumedRun: { runId: string; reusedRunId: boolean } | undefined;
  if (flow.backfillState?.runId) {
    resumedRun = await startBackfill(workspaceId, flowId, {
      reuseExistingRunId: true,
      reason: "Backfill resumed from pause",
    });
  }

  return {
    resumed: true,
    resumedRunId: resumedRun?.runId || null,
    reusedRunId: resumedRun?.reusedRunId || false,
    resumedBackfill: Boolean(resumedRun),
    webhookEventsDrained,
  };
}

export async function pauseStream(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Stream pause requires syncEngine=cdc");
  }

  await cdcSyncStateService.applyStreamTransition({
    workspaceId,
    flowId,
    event: { type: "PAUSE", reason: "Stream paused via API" },
  });

  return { paused: true };
}

export async function resumeStream(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Stream resume requires syncEngine=cdc");
  }

  const result = await cdcSyncStateService.applyStreamTransition({
    workspaceId,
    flowId,
    event: { type: "RESUME", reason: "Stream resumed via API" },
  });
  if (!result.changed) {
    await cdcSyncStateService.applyStreamTransition({
      workspaceId,
      flowId,
      event: { type: "START", reason: "Stream started via API" },
    });
  }

  const pending = await getCdcEventStore().countEvents({
    workspaceId,
    flowId,
    materializationStatus: "pending",
  });
  if (pending > 0) {
    try {
      await forceDrainCdcFlow({ workspaceId, flowId });
    } catch (error) {
      log.warn("Failed to schedule CDC drain after stream resume", {
        flowId,
        workspaceId,
        pendingBacklog: pending,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    resumed: true,
    pendingBacklog: pending,
    drainQueued: pending > 0,
    webhookEventsDrained: 0,
  };
}
