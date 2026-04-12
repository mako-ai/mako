/**
 * Backfill recovery: recover streams, reprocess stale events, retry failures.
 *
 * Contains logic for bringing a CDC flow back to a healthy state after
 * transient errors or stuck pipeline segments.
 */
import { Types } from "mongoose";
import { inngest } from "../../inngest/client";
import {
  CdcChangeEvent,
  CdcEntityState,
  Flow,
  WebhookEvent,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { getCdcEventStore } from "../event-store";
import { cdcSyncStateService } from "../sync-state";
import {
  assertCanStartBackfill,
  resumeStream,
  startBackfill,
} from "./orchestration";
import {
  drainPendingWebhookEvents,
  resetFailedWebhookEvents,
  reconcileWebhookApplyStatus,
  resolveOrphanedWebhookApplyStatus,
} from "./webhook-ops";
import { cleanupOrphanStagingTables } from "./destination-ops";

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
  if (!flow) throw new Error("Flow not found");
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

  for (const entity of entities) {
    const minPending = await CdcChangeEvent.findOne({
      flowId: new Types.ObjectId(params.flowId),
      entity,
      materializationStatus: "pending",
    })
      .sort({ ingestSeq: 1 })
      .select({ ingestSeq: 1 })
      .lean();
    if (minPending) {
      await CdcEntityState.updateOne(
        {
          flowId: new Types.ObjectId(params.flowId),
          entity,
        },
        {
          $set: {
            lastMaterializedSeq: Math.max(
              0,
              (parseInt(String(minPending.ingestSeq), 10) || 0) - 1,
            ),
          },
        },
      );
    }

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
  if (!flow) throw new Error("Flow not found");
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
  if (!flow) throw new Error("Flow not found");
  if (flow.syncEngine !== "cdc") {
    throw new Error("Reprocess stale events requires syncEngine=cdc");
  }

  const [reconciledWebhooks, drainedWebhooks, resetFailedWebhooksCount] =
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
  let cursorsRewound = 0;
  try {
    const byEntity = await getCdcEventStore().countEventsByEntity({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      materializationStatus: "pending",
    });
    for (const item of byEntity) {
      if (item.count <= 0) continue;

      const minPending = await CdcChangeEvent.findOne({
        flowId: new Types.ObjectId(params.flowId),
        entity: item.entity,
        materializationStatus: "pending",
      })
        .sort({ ingestSeq: 1 })
        .select({ ingestSeq: 1 })
        .lean();

      if (minPending) {
        const targetSeq = Math.max(
          0,
          (parseInt(String(minPending.ingestSeq), 10) || 0) - 1,
        );
        const state = await CdcEntityState.findOne({
          flowId: new Types.ObjectId(params.flowId),
          entity: item.entity,
        })
          .select({ lastMaterializedSeq: 1 })
          .lean();
        if (state && Number(state.lastMaterializedSeq || 0) > targetSeq) {
          await CdcEntityState.updateOne(
            {
              flowId: new Types.ObjectId(params.flowId),
              entity: item.entity,
            },
            { $set: { lastMaterializedSeq: targetSeq } },
          );
          cursorsRewound++;
        }
      }

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
    }
  } catch (error) {
    log.warn("Failed to force-drain CDC during reprocess-stale", {
      flowId: params.flowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const orphanedResolved = await resolveOrphanedWebhookApplyStatus(
    params.workspaceId,
    params.flowId,
  );

  log.info("Reprocessed stale events", {
    flowId: params.flowId,
    reconciledWebhooks,
    drainedWebhooks,
    resetFailedWebhooks: resetFailedWebhooksCount,
    materializeTriggered,
    cursorsRewound,
    orphanedResolved,
  });

  return {
    reconciledWebhooks,
    drainedWebhooks,
    resetFailedWebhooks: resetFailedWebhooksCount,
    materializeTriggered,
    cursorsRewound,
    orphanedResolved,
  };
}

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
  if (!flow) throw new Error("Flow not found");
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
