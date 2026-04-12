/**
 * Backfill orchestration: start, pause, resume, cancel, resync flows.
 *
 * Contains the lifecycle state-machine operations for CDC backfills.
 * Called by the CdcBackfillService facade and Inngest flow functions.
 */
import * as crypto from "crypto";
import { Types } from "mongoose";
import { inngest } from "../../inngest/client";
import {
  CdcEntityState,
  CdcStateTransition,
  Flow,
  FlowExecution,
  WebhookEvent,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { getCdcEventStore } from "../event-store";
import { cdcSyncStateService } from "../sync-state";
import { deleteDestinationTables, forceDrainCdcFlow } from "./destination-ops";
import { drainPendingWebhookEvents } from "./webhook-ops";

const log = loggers.sync("cdc.backfill");

const STALE_HEARTBEAT_MS = 10 * 60 * 1000;
const CANCEL_WAIT_POLL_MS = 1000;
const CANCEL_WAIT_TIMEOUT_MS = 30_000;

const INNGEST_APP_ID = "mako-sync";
const INNGEST_FLOW_FUNCTION_ID = `${INNGEST_APP_ID}-flow`;
const INNGEST_ENTITY_FUNCTION_ID = `${INNGEST_APP_ID}-sync-backfill-entity`;

export async function cancelInngestFlowRuns(flowId: string): Promise<boolean> {
  const signingKey = process.env.INNGEST_SIGNING_KEY;
  if (!signingKey) {
    log.warn(
      "cancelInngestFlowRuns: INNGEST_SIGNING_KEY not set, skipping API cancel",
      { flowId },
    );
    return false;
  }

  const functionIds = [INNGEST_FLOW_FUNCTION_ID, INNGEST_ENTITY_FUNCTION_ID];
  const results = await Promise.allSettled(
    functionIds.map(async functionId => {
      const res = await fetch("https://api.inngest.com/v1/cancellations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_id: INNGEST_APP_ID,
          function_id: functionId,
          started_after: new Date(
            Date.now() - 24 * 60 * 60 * 1000,
          ).toISOString(),
          started_before: new Date().toISOString(),
          if: `event.data.flowId == '${flowId}'`,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error("Inngest bulk cancel API returned non-OK", {
          flowId,
          functionId,
          status: res.status,
          body: body.slice(0, 500),
        });
        return false;
      }

      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      log.info("Inngest bulk cancel API succeeded", {
        flowId,
        functionId,
        cancellationId: data?.id,
      });
      return true;
    }),
  );

  const allOk = results.every(
    r => r.status === "fulfilled" && r.value === true,
  );
  if (!allOk) {
    log.warn("Some Inngest bulk cancel calls failed", {
      flowId,
      results: results.map((r, i) => ({
        functionId: functionIds[i],
        status: r.status,
        value: r.status === "fulfilled" ? r.value : undefined,
        reason:
          r.status === "rejected"
            ? r.reason instanceof Error
              ? r.reason.message
              : String(r.reason)
            : undefined,
      })),
    });
  }
  return allOk;
}

export async function assertCanStartBackfill(
  workspaceId: string,
  flowId: string,
): Promise<void> {
  const abandonedCount = await abandonStaleExecutions(workspaceId, flowId);
  if (abandonedCount > 0) {
    log.warn("Abandoned stale executions before starting backfill", {
      flowId,
      workspaceId,
      abandonedCount,
    });
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const running = await FlowExecution.findOne({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
    status: "running",
  })
    .sort({ startedAt: -1 })
    .lean();

  if (!running) return;

  const executionAge = running.startedAt
    ? Date.now() - new Date(running.startedAt).getTime()
    : undefined;
  const heartbeatAge = running.lastHeartbeat
    ? Date.now() - new Date(running.lastHeartbeat).getTime()
    : undefined;

  const flow = await Flow.findById(flowId)
    .select("backfillState.status")
    .lean();
  const isPendingCancel =
    flow?.backfillState?.status === "paused" ||
    flow?.backfillState?.status === "error" ||
    flow?.backfillState?.status === "completed" ||
    flow?.backfillState?.status === "idle";

  if (!isPendingCancel) {
    log.error("Cannot start backfill — execution still running", {
      flowId,
      executionId: running._id?.toString(),
      backfillStatus: flow?.backfillState?.status,
      executionStartedAt: running.startedAt,
      executionAgeMs: executionAge,
      lastHeartbeat: running.lastHeartbeat,
      heartbeatAgeMs: heartbeatAge,
    });
    throw new Error(
      `Cannot start backfill while an execution is still running (execution ${running._id?.toString()}, started ${executionAge ? Math.round(executionAge / 1000) + "s ago" : "unknown"}, last heartbeat ${heartbeatAge ? Math.round(heartbeatAge / 1000) + "s ago" : "never"})`,
    );
  }

  log.info("Waiting for previous execution to finish before starting", {
    flowId,
    executionId: running._id?.toString(),
    backfillStatus: flow?.backfillState?.status,
    executionAgeMs: executionAge,
    heartbeatAgeMs: heartbeatAge,
  });

  await Promise.all([
    inngest.send({
      name: "flow.cancel",
      data: {
        flowId,
        executionId: running._id?.toString(),
      },
    }),
    cancelInngestFlowRuns(flowId),
  ]);

  const deadline = Date.now() + CANCEL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CANCEL_WAIT_POLL_MS));
    const still = await FlowExecution.exists({
      _id: running._id,
      status: "running",
    });
    if (!still) {
      log.info("Previous execution finished after cancel signal", {
        flowId,
        executionId: running._id?.toString(),
        waitedMs: CANCEL_WAIT_TIMEOUT_MS - (deadline - Date.now()),
      });
      return;
    }
  }

  log.error("Cancel wait timed out — force-abandoning stuck execution", {
    flowId,
    executionId: running._id?.toString(),
    executionStartedAt: running.startedAt,
    executionAgeMs: executionAge,
    heartbeatAgeMs: heartbeatAge,
    cancelWaitTimeoutMs: CANCEL_WAIT_TIMEOUT_MS,
  });

  await FlowExecution.updateOne(
    { _id: running._id, status: "running" },
    {
      $push: {
        logs: {
          $each: [
            {
              timestamp: new Date(),
              level: "error",
              message: `Backfill execution stuck — no heartbeat for ${heartbeatAge ? Math.round(heartbeatAge / 1000) + "s" : "unknown"}. Force-abandoning to allow restart.`,
              metadata: { flowId, executionId: running._id?.toString() },
            },
          ],
          $slice: -200,
        },
      },
    },
  );

  await abandonStaleExecutions(workspaceId, flowId, { force: true });
}

export async function abandonStaleExecutions(
  workspaceId: string,
  flowId: string,
  options?: { force?: boolean },
): Promise<number> {
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    status: "running",
  };

  if (!options?.force) {
    const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
    filter.$or = [
      { lastHeartbeat: { $lt: cutoff } },
      { lastHeartbeat: { $exists: false }, startedAt: { $lt: cutoff } },
    ];
  }

  const result = await FlowExecution.updateMany(filter, {
    $set: {
      status: "abandoned",
      completedAt: new Date(),
      error: {
        message: options?.force
          ? "Execution abandoned on server startup — previous process no longer running"
          : "Execution abandoned during recovery — no heartbeat for 10+ minutes",
        code: "RECOVERY_ABANDON",
      },
    },
  });

  if (result.modifiedCount > 0) {
    log.warn("Abandoned stale executions during recovery", {
      flowId,
      workspaceId,
      abandonedCount: result.modifiedCount,
      force: options?.force ?? false,
    });
  }

  return result.modifiedCount;
}

function createBackfillRunId(flowId: string): string {
  return `backfill:${flowId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

function createBackfillTriggerEventId(flowId: string, runId: string): string {
  return `cdc-backfill:${flowId}:${runId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeEntities(entities: unknown[] | undefined): string[] {
  return Array.isArray(entities)
    ? Array.from(
        new Set(
          entities
            .filter(
              (entity): entity is string =>
                typeof entity === "string" && entity.trim().length > 0,
            )
            .map(entity => entity.trim()),
        ),
      )
    : [];
}

export async function startBackfill(
  workspaceId: string,
  flowId: string,
  options?: {
    reuseExistingRunId?: boolean;
    entities?: string[];
    reason?: string;
  },
): Promise<{ runId: string; reusedRunId: boolean }> {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc") {
    throw new Error("Backfill start requires syncEngine=cdc");
  }

  const shouldReuseRunId = options?.reuseExistingRunId === true;
  const requestedEntities = normalizeEntities(options?.entities);
  const scopeFromFlow =
    flow.backfillState?.scope?.mode === "subset" &&
    Array.isArray(flow.backfillState.scope.entities)
      ? normalizeEntities(flow.backfillState.scope.entities)
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
  await assertCanStartBackfill(workspaceId, flowId);
  const preCheckMs = Date.now() - preCheckStart;
  if (preCheckMs > 5000) {
    log.warn("startBackfill: pre-check was slow", { flowId, preCheckMs });
  }

  await Promise.all([
    inngest.send({ name: "flow.cancel", data: { flowId } }),
    cancelInngestFlowRuns(flowId),
  ]);

  const runId =
    shouldReuseRunId && flow.backfillState?.runId
      ? flow.backfillState.runId
      : createBackfillRunId(flowId);
  const reusedRunId = Boolean(shouldReuseRunId && flow.backfillState?.runId);
  const previousFailures = flow.backfillState?.consecutiveFailures ?? 0;
  const now = new Date();
  flow.backfillState = {
    status: "running",
    runId,
    startedAt: reusedRunId ? flow.backfillState?.startedAt || now : now,
    completedAt: undefined,
    consecutiveFailures: previousFailures,
    scope: {
      mode: effectiveScope.length > 0 ? "subset" : "all",
      entities: effectiveScope,
    },
  };
  await flow.save();

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

  await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "START", reason },
    context: { hasActiveRunLock: false },
  });

  const triggerEventId = createBackfillTriggerEventId(flowId, runId);
  const sendResult = await inngest.send({
    id: triggerEventId,
    name: "flow.execute",
    data: {
      flowId,
      noJitter: true,
      backfill: true,
      backfillRunId: runId,
      ...(effectiveScope.length > 0
        ? { backfillEntities: effectiveScope }
        : {}),
    },
  });

  log.info("Backfill flow.execute event sent to Inngest", {
    flowId,
    runId,
    triggerEventId,
    inngestEventIds: sendResult?.ids,
  });

  return { runId, reusedRunId };
}

export async function resyncFlow(params: {
  workspaceId: string;
  flowId: string;
  deleteDestination?: boolean;
  clearWebhookEvents?: boolean;
}) {
  const { workspaceId, flowId, deleteDestination, clearWebhookEvents } = params;
  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const flow = await Flow.findOne({
    _id: flowObjectId,
    workspaceId: workspaceObjectId,
  });
  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc")
    throw new Error("Resync requires syncEngine=cdc");

  await assertCanStartBackfill(workspaceId, flowId);

  await getCdcEventStore().deleteFlowEvents({ workspaceId, flowId });
  await CdcEntityState.deleteMany({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
  });
  await CdcStateTransition.deleteMany({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
  });

  if (clearWebhookEvents) {
    await WebhookEvent.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
  }

  if (deleteDestination) {
    await deleteDestinationTables(flow);
  }

  flow.streamState = "idle";
  flow.syncStateUpdatedAt = new Date();
  flow.syncStateMeta = {
    lastEvent: "RESYNC",
    lastReason: "Operator initiated resync",
  };
  flow.backfillState = {
    status: "idle",
    runId: undefined,
    startedAt: undefined,
    completedAt: undefined,
  };
  await flow.save();

  await startBackfill(workspaceId, flowId);

  if (!clearWebhookEvents) {
    await drainPendingWebhookEvents(workspaceId, flowId, "resync");
  }
}

export async function pauseBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc") {
    throw new Error("Pause backfill requires syncEngine=cdc");
  }

  const currentStatus = flow.backfillState?.status;
  const runId = flow.backfillState?.runId;
  if (currentStatus !== "running") {
    log.warn("pauseBackfill: flow is not in backfill running state", {
      flowId,
      currentStatus,
    });
  }

  flow.backfillState = {
    ...(flow.backfillState || {}),
    status: "paused",
  };
  await flow.save();

  await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "PAUSE", reason: "Backfill paused via API" },
    context: { hasActiveRunLock: false },
  });

  await inngest.send({
    name: "flow.cancel",
    data: { flowId },
  });

  log.info("Backfill paused", { flowId, runId });
  return { paused: true, runId };
}

export async function cancelBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc") {
    throw new Error("Cancel backfill requires syncEngine=cdc");
  }

  const runId = flow.backfillState?.runId;
  flow.backfillState = {
    status: "idle",
    runId: undefined,
    startedAt: undefined,
    completedAt: undefined,
  };
  await flow.save();

  await cdcSyncStateService.applyBackfillTransition({
    workspaceId,
    flowId,
    event: { type: "CANCEL", reason: "Backfill cancelled via API" },
    context: { hasActiveRunLock: false },
  });

  await Promise.all([
    inngest.send({ name: "flow.cancel", data: { flowId } }),
    cancelInngestFlowRuns(flowId),
  ]);

  log.info("Backfill cancelled", { flowId, runId });
  return { cancelled: true, runId };
}

export async function resumeBackfill(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
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
      await forceDrainCdcFlow({ workspaceId, flowId });
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
    resumedRunId: resumedRun?.runId ?? null,
    reusedRunId: resumedRun?.reusedRunId ?? false,
    resumedBackfill: Boolean(resumedRun),
    webhookEventsDrained,
  };
}

export async function pauseStream(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc") {
    throw new Error("Pause stream requires syncEngine=cdc");
  }

  await cdcSyncStateService.applyStreamTransition({
    workspaceId,
    flowId,
    event: { type: "PAUSE", reason: "Stream paused via API" },
  });

  flow.streamState = "paused";
  await flow.save();

  log.info("Stream paused", { flowId, workspaceId });
  return { paused: true };
}

export async function resumeStream(workspaceId: string, flowId: string) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
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
