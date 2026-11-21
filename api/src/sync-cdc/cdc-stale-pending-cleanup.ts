import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  WebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { getCdcEventStore } from "./event-store";
import {
  excludeRetainedInboxPeers,
  withCdcFlowWriteFence,
} from "./cdc-flow-write-fence";

const log = loggers.sync("cdc.stale-pending-cleanup");

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500;
const STALE_APPLY_ERROR = {
  code: "STALE_PENDING_CDC_EVENT",
  message:
    "Webhook ingest completed but destination apply never finalized; dropped after retention window",
};

type StaleCdcRow = {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  ingestSeq: number;
  webhookEventId?: string;
};

/**
 * Drops CDC change events that are still materialization-pending but whose
 * paired webhook row has been ingested (completed) with apply still pending
 * for longer than {@link STALE_MS}. Updates webhook applyStatus to dropped
 * and advances entity cursors when safe so the scheduler does not spin on
 * phantom backlog.
 */
export async function cleanupStalePendingCdcEvents(): Promise<{
  scanned: number;
  droppedCdc: number;
  droppedWebhooks: number;
  cursorsAdvanced: number;
}> {
  const cutoff = new Date(Date.now() - STALE_MS);

  const staleWebhooks = await WebhookEvent.find({
    status: "completed",
    applyStatus: "pending",
    receivedAt: { $lte: cutoff },
  })
    .select({ _id: 1, flowId: 1 })
    .limit(BATCH_LIMIT)
    .lean();

  if (staleWebhooks.length === 0) {
    return {
      scanned: 0,
      droppedCdc: 0,
      droppedWebhooks: 0,
      cursorsAdvanced: 0,
    };
  }

  const webhookIds = staleWebhooks.map(w => w._id);
  const flowIds = Array.from(
    new Set(staleWebhooks.map(w => String(w.flowId))),
  ).map(id => new Types.ObjectId(id));

  const { cdcRows, droppedWebhooks } = await withCdcFlowWriteFence(
    flowIds,
    async session => {
      const inboxFilter = {
        status: "completed",
        applyStatus: "pending",
        receivedAt: { $lte: cutoff },
      } as const;
      const current = await WebhookEvent.find(
        { ...inboxFilter, _id: { $in: webhookIds } },
        { _id: 1 },
      )
        .session(session)
        .lean();
      const candidates: StaleCdcRow[] = await CdcChangeEvent.find({
        flowId: { $in: flowIds },
        materializationStatus: "pending",
        retainedBigQueryWrite: { $exists: false },
        webhookEventId: { $in: current.map(row => String(row._id)) },
      })
        .select({
          _id: 1,
          workspaceId: 1,
          flowId: 1,
          entity: 1,
          ingestSeq: 1,
          webhookEventId: 1,
        })
        .session(session)
        .lean();
      const cdcRows = await excludeRetainedInboxPeers(
        candidates,
        flowIds,
        session,
      );
      if (cdcRows.length === 0) return { cdcRows, droppedWebhooks: 0 };

      await getCdcEventStore().markEventsDropped({
        eventIds: cdcRows.map(row => String(row._id)),
        errorCode: STALE_APPLY_ERROR.code,
        errorMessage: STALE_APPLY_ERROR.message,
        session,
      });
      const droppedInboxIds = new Set(cdcRows.map(row => row.webhookEventId));
      const webhookResult = await WebhookEvent.updateMany(
        {
          ...inboxFilter,
          _id: {
            $in: current
              .map(row => row._id)
              .filter(id => droppedInboxIds.has(String(id))),
          },
        },
        {
          $set: { applyStatus: "dropped", applyError: STALE_APPLY_ERROR },
          $unset: { appliedAt: "" },
        },
        { session },
      );
      return { cdcRows, droppedWebhooks: webhookResult.modifiedCount || 0 };
    },
  );

  if (cdcRows.length === 0) {
    log.info("No stale CDC events eligible for cleanup", {
      webhookCount: staleWebhooks.length,
    });
    return {
      scanned: staleWebhooks.length,
      droppedCdc: 0,
      droppedWebhooks: 0,
      cursorsAdvanced: 0,
    };
  }

  const maxIngestByEntity = new Map<string, number>();
  for (const row of cdcRows) {
    const key = JSON.stringify([
      String(row.workspaceId),
      String(row.flowId),
      row.entity,
    ]);
    const seq = Number(row.ingestSeq) || 0;
    const prev = maxIngestByEntity.get(key) ?? 0;
    if (seq > prev) {
      maxIngestByEntity.set(key, seq);
    }
  }

  let cursorsAdvanced = 0;
  for (const [key, maxDroppedSeq] of maxIngestByEntity) {
    const [workspaceId, flowId, entity] = JSON.parse(key) as [
      string,
      string,
      string,
    ];
    const state = await CdcEntityState.findOne({
      flowId: new Types.ObjectId(flowId),
      entity,
    }).lean();
    if (!state) {
      continue;
    }

    const lastMat = Number(state.lastMaterializedSeq || 0);
    if (lastMat >= maxDroppedSeq) {
      continue;
    }

    const stillPendingLowerOrEq = await CdcChangeEvent.countDocuments({
      flowId: new Types.ObjectId(flowId),
      entity,
      materializationStatus: "pending",
      ingestSeq: { $lte: maxDroppedSeq },
    });

    if (stillPendingLowerOrEq > 0) {
      continue;
    }

    const lastIngest = Number(state.lastIngestSeq || 0);
    const targetSeq = Math.min(maxDroppedSeq, lastIngest);
    const result = await CdcEntityState.updateOne(
      {
        flowId: new Types.ObjectId(flowId),
        entity,
      },
      {
        $set: {
          workspaceId: new Types.ObjectId(workspaceId),
          flowId: new Types.ObjectId(flowId),
          entity,
          lastMaterializedAt: new Date(),
        },
        $max: {
          lastMaterializedSeq: targetSeq,
        },
      },
    );
    if (result.matchedCount > 0) {
      cursorsAdvanced += 1;
    }
  }

  const droppedCdc = cdcRows.length;

  if (droppedCdc > 0) {
    log.info("Cleaned up stale pending CDC events", {
      droppedCdc,
      droppedWebhooks,
      cursorsAdvanced,
      cutoff: cutoff.toISOString(),
    });
  }

  return {
    scanned: staleWebhooks.length,
    droppedCdc,
    droppedWebhooks,
    cursorsAdvanced,
  };
}
