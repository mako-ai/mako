/**
 * Operator recovery for a CDC flow: retry failed materialization, recover the
 * stream, reprocess stale events, and the one-shot `recoverFlow` that runs them.
 */
import { Types } from "mongoose";
import { Flow, WebhookEvent } from "../../database/workspace-schema";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import { getCdcEventStore } from "../event-store";
import { cdcSyncStateService } from "../sync-state";

import { assertCanStartBackfill } from "./execution-guard";
import { resumeStream, startBackfill } from "./lifecycle";
import {
  cleanupOrphanStagingTables,
  drainPendingWebhookEvents,
  reconcileWebhookApplyStatus,
  resetFailedWebhookEvents,
  resolveOrphanedWebhookApplyStatus,
} from "./webhook-maintenance";

const log = loggers.sync("cdc.backfill");

export async function retryFailedMaterialization(params: {
  workspaceId: string;
  flowId: string;
  entity?: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Retry failed materialization requires syncEngine=cdc");
  }

  const eventStore = getCdcEventStore();
  const { resetCount, entities, webhookEventIds } =
    await eventStore.resetFailedEvents({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
    });

  if (resetCount === 0) {
    return { resetCount: 0, entities: [] as string[] };
  }

  if (webhookEventIds.length > 0) {
    await WebhookEvent.updateMany(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        eventId: { $in: webhookEventIds },
      },
      {
        $set: { applyStatus: "pending", status: "pending" },
        $unset: { applyError: "", error: "", processedAt: "" },
      },
    );
  }

  // Do NOT rewind lastMaterializedSeq under the oldest pending event.
  // readAfter() already selects pending rows independent of the cursor, and
  // findEntitiesWithPendingEvents() triggers drain without a rewind. Rewinding
  // invents a huge ingest/materialized seq gap that the status UI used to
  // surface as hundreds of thousands of fake "pending" events.
  for (const entity of entities) {
    await inngest.send({
      name: "cdc/materialize",
      data: {
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity,
        force: true,
      },
    });
  }

  return { resetCount, entities };
}

export async function recoverStream(params: {
  workspaceId: string;
  flowId: string;
  retryFailedMaterialization?: boolean;
  entity?: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Recover stream requires syncEngine=cdc");
  }

  const hasIncompleteBackfill = Boolean(flow.backfillState?.runId);
  if (hasIncompleteBackfill) {
    log.warn(
      "recoverStream: skipping stream activation because backfill is incomplete",
      {
        flowId: params.flowId,
        runId: flow.backfillState?.runId,
        backfillStatus: flow.backfillState?.status,
      },
    );
  } else {
    await assertCanStartBackfill(params.workspaceId, params.flowId);

    const streamResult = await cdcSyncStateService.applyStreamTransition({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      event: { type: "RECOVER", reason: "Stream recovered via API" },
    });
    if (!streamResult.changed) {
      await resumeStream(params.workspaceId, params.flowId);
    }
  }

  let retried = { resetCount: 0, entities: [] as string[] };
  if (params.retryFailedMaterialization !== false && !hasIncompleteBackfill) {
    retried = await retryFailedMaterialization({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
    });
  }

  const [
    webhookEventsDrained,
    drainedFailedWebhooks,
    reconciledWebhooks,
    stagingCleaned,
  ] = await Promise.all([
    drainPendingWebhookEvents(
      params.workspaceId,
      params.flowId,
      "recover-stream",
    ),
    resetFailedWebhookEvents(params.workspaceId, params.flowId),
    reconcileWebhookApplyStatus(params.workspaceId, params.flowId),
    hasIncompleteBackfill
      ? Promise.resolve(0)
      : cleanupOrphanStagingTables(flow),
  ]);

  return {
    retriedFailedRows: retried.resetCount,
    retriedEntities: retried.entities,
    webhookEventsDrained,
    drainedFailedWebhooks,
    reconciledWebhooks,
    stagingCleaned,
  };
}

export async function reprocessStaleEvents(params: {
  workspaceId: string;
  flowId: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Reprocess stale events requires syncEngine=cdc");
  }

  const [reconciledWebhooks, drainedWebhooks, resetFailedWebhooks] =
    await Promise.all([
      reconcileWebhookApplyStatus(params.workspaceId, params.flowId),
      drainPendingWebhookEvents(
        params.workspaceId,
        params.flowId,
        "reprocess-stale",
      ),
      resetFailedWebhookEvents(params.workspaceId, params.flowId),
    ]);

  let materializeTriggered = 0;
  let pendingEntities = 0;
  const drainErrors: string[] = [];

  // Enumerate entities with pending events. If THIS fails we must surface it
  // (the "Reprocess pending events" button previously swallowed every error
  // here and returned success:true, so a broken drain looked like a no-op).
  const byEntity = await getCdcEventStore().countEventsByEntity({
    workspaceId: params.workspaceId,
    flowId: params.flowId,
    materializationStatus: "pending",
  });

  for (const item of byEntity) {
    if (item.count <= 0) continue;
    pendingEntities++;

    try {
      // Force-trigger materialize only. Do not rewind lastMaterializedSeq —
      // readAfter() + findEntitiesWithPendingEvents() already drain orphans
      // without inventing a cursor seq gap that inflates the pending UI.
      await inngest.send({
        name: "cdc/materialize",
        data: {
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity: item.entity,
          force: true,
        },
      });
      materializeTriggered++;
    } catch (error) {
      // One bad entity must not abort the rest of the drain.
      const message = error instanceof Error ? error.message : String(error);
      drainErrors.push(`${item.entity}: ${message}`);
      log.warn("Failed to force-drain CDC entity during reprocess-stale", {
        flowId: params.flowId,
        entity: item.entity,
        error: message,
      });
    }
  }

  // If there was pending work but we couldn't trigger a single materialize,
  // the operation genuinely failed — surface it so the UI doesn't lie.
  if (pendingEntities > 0 && materializeTriggered === 0) {
    throw new Error(
      `Failed to trigger materialization for any of ${pendingEntities} pending entities: ${
        drainErrors[0] ?? "unknown error"
      }`,
    );
  }

  const orphanedResolved = await resolveOrphanedWebhookApplyStatus(
    params.workspaceId,
    params.flowId,
  );

  log.info("Reprocessed stale events", {
    flowId: params.flowId,
    reconciledWebhooks,
    drainedWebhooks,
    resetFailedWebhooks,
    pendingEntities,
    materializeTriggered,
    orphanedResolved,
    drainErrors: drainErrors.length,
  });

  return {
    reconciledWebhooks,
    drainedWebhooks,
    resetFailedWebhooks,
    pendingEntities,
    materializeTriggered,
    orphanedResolved,
    drainErrors,
  };
}

/**
 * Unified recovery: resumes an incomplete backfill (if runId exists) or
 * recovers the stream pipeline.
 */
export async function recoverFlow(params: {
  workspaceId: string;
  flowId: string;
  retryFailedMaterialization?: boolean;
  entity?: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Recover flow requires syncEngine=cdc");
  }

  const hasIncompleteBackfill = Boolean(flow.backfillState?.runId);

  if (hasIncompleteBackfill) {
    log.info("recoverFlow: restarting incomplete backfill from checkpoint", {
      flowId: params.flowId,
      runId: flow.backfillState?.runId,
      backfillStatus: flow.backfillState?.status,
    });

    await assertCanStartBackfill(params.workspaceId, params.flowId);

    const resumedBackfill = await startBackfill(
      params.workspaceId,
      params.flowId,
      {
        reuseExistingRunId: true,
        reason: "Backfill restarted via recover (from checkpoint)",
      },
    );

    const [webhookEventsDrained, drainedFailedWebhooks, reconciledWebhooks] =
      await Promise.all([
        drainPendingWebhookEvents(params.workspaceId, params.flowId, "recover"),
        resetFailedWebhookEvents(params.workspaceId, params.flowId),
        reconcileWebhookApplyStatus(params.workspaceId, params.flowId),
      ]);

    return {
      retriedFailedRows: 0,
      retriedEntities: [] as string[],
      stagingCleaned: 0,
      webhookEventsDrained,
      drainedFailedWebhooks,
      reconciledWebhooks,
      resumedBackfill: {
        runId: resumedBackfill.runId,
        reusedRunId: resumedBackfill.reusedRunId,
      },
    };
  }

  // Stream recovery (includes its own webhook drain/reset/reconcile)
  const streamResult = await recoverStream({
    workspaceId: params.workspaceId,
    flowId: params.flowId,
    retryFailedMaterialization: params.retryFailedMaterialization,
    entity: params.entity,
  });

  return {
    ...streamResult,
    resumedBackfill: undefined,
  };
}
