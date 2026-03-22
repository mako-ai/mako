import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  IFlow,
  WebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import { getCdcEventStore } from "./stores";

const log = loggers.sync("cdc.runtime");

type SourceKind = "webhook" | "backfill";

async function upsertStateAfterIngest(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  lastIngestSeq: number;
  sourceKind: SourceKind;
  runId?: string;
}) {
  const mergeIntervalSeconds =
    params.sourceKind === "backfill"
      ? Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_BACKFILL_MERGE_INTERVAL_SECONDS || "900",
            10,
          ) || 900,
          60,
        )
      : Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_STEADY_MERGE_INTERVAL_SECONDS || "60",
            10,
          ) || 60,
          10,
        );
  await CdcEntityState.updateOne(
    { flowId: params.flowId, entity: params.entity },
    {
      $set: {
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
        mode: params.sourceKind === "backfill" ? "backfill" : "steady",
        runId: params.runId,
        mergeIntervalSeconds,
      },
      $max: { lastIngestSeq: params.lastIngestSeq },
    },
    { upsert: true },
  );
}

async function maybeEnqueueMaterialization(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  force?: boolean;
}) {
  const flow = await Flow.findById(params.flowId)
    .select({ syncState: 1, syncEngine: 1 })
    .lean();
  if (!flow || flow.syncEngine !== "cdc") return;
  if (flow.syncState === "paused") {
    log.info("Skip CDC materialization enqueue while paused", {
      flowId: String(params.flowId),
      entity: params.entity,
    });
    return;
  }

  const state = await CdcEntityState.findOne({
    flowId: params.flowId,
    entity: params.entity,
  }).lean();
  const now = Date.now();
  const lastEnqueuedAt = state?.lastEnqueuedAt
    ? new Date(state.lastEnqueuedAt).getTime()
    : 0;
  const intervalMs = Math.max((state?.mergeIntervalSeconds || 60) * 1000, 1000);
  if (!params.force && now - lastEnqueuedAt < intervalMs) return;

  await CdcEntityState.updateOne(
    { flowId: params.flowId, entity: params.entity },
    { $set: { lastEnqueuedAt: new Date() } },
    { upsert: true },
  );

  await inngest.send({
    name: "bigquery/cdc.materialize",
    data: {
      workspaceId: String(params.workspaceId),
      flowId: String(params.flowId),
      entity: params.entity,
      force: Boolean(params.force),
    },
  });
}

export async function onCdcEventsAppended(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entities: Array<{
    entity: string;
    sourceKind: SourceKind;
    runId?: string;
    lastIngestSeq: number;
  }>;
  enqueue?: boolean;
}): Promise<void> {
  for (const entityState of params.entities) {
    await upsertStateAfterIngest({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: entityState.entity,
      lastIngestSeq: entityState.lastIngestSeq,
      sourceKind: entityState.sourceKind,
      runId: entityState.runId,
    });

    if (params.enqueue !== false) {
      await maybeEnqueueMaterialization({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: entityState.entity,
      });
    }
  }
}

export async function markCdcBackfillCompletedForFlow(params: {
  flowId: string;
  workspaceId: string;
}) {
  await CdcEntityState.updateMany(
    { flowId: new Types.ObjectId(params.flowId) },
    {
      $set: {
        mode: "steady",
        backfillCompletedAt: new Date(),
        mergeIntervalSeconds: Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_STEADY_MERGE_INTERVAL_SECONDS || "60",
            10,
          ) || 60,
          10,
        ),
      },
      $unset: { runId: "" },
    },
  );

  const states = await CdcEntityState.find({
    flowId: new Types.ObjectId(params.flowId),
  })
    .select({ entity: 1 })
    .lean();
  for (const state of states) {
    await maybeEnqueueMaterialization({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: state.entity,
      force: true,
    });
  }
}

export async function getCdcFlowStats(params: { flowId: string }): Promise<{
  enabled: boolean;
  mode: "steady" | "backfill";
  entities: number;
  backlogCount: number;
  lagSeconds: number | null;
}> {
  const states = await CdcEntityState.find({
    flowId: new Types.ObjectId(params.flowId),
  }).lean();
  if (states.length === 0) {
    return {
      enabled: false,
      mode: "steady",
      entities: 0,
      backlogCount: 0,
      lagSeconds: null,
    };
  }
  const backlogCount = states.reduce(
    (sum, s) => sum + (s.backlogCount || 0),
    0,
  );
  const mode = states.some(s => s.mode === "backfill") ? "backfill" : "steady";
  const latestMaterializedAt = states
    .map(s => s.lastMaterializedAt)
    .filter(Boolean)
    .map(d => new Date(d as Date).getTime())
    .sort((a, b) => b - a)[0];
  const lagSeconds = latestMaterializedAt
    ? Math.max(Math.floor((Date.now() - latestMaterializedAt) / 1000), 0)
    : null;
  return {
    enabled: true,
    mode,
    entities: states.length,
    backlogCount,
    lagSeconds,
  };
}

export async function forceDrainCdcFlow(params: {
  workspaceId: string;
  flowId: string;
}) {
  const states = await CdcEntityState.find({
    flowId: new Types.ObjectId(params.flowId),
  }).lean();
  for (const state of states) {
    await maybeEnqueueMaterialization({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: state.entity,
      force: true,
    });
  }
}

export async function sweepStaleCdcPending(params?: {
  staleSeconds?: number;
  maxEntities?: number;
}) {
  const staleSeconds = Math.max(params?.staleSeconds || 180, 30);
  const maxEntities = Math.max(params?.maxEntities || 25, 1);
  const staleThreshold = new Date(Date.now() - staleSeconds * 1000);

  // Pull candidates that haven't been enqueued recently.
  const candidates = await CdcEntityState.find({
    $or: [
      { lastEnqueuedAt: { $exists: false } },
      { lastEnqueuedAt: null },
      { lastEnqueuedAt: { $lt: staleThreshold } },
    ],
  })
    .sort({ lastEnqueuedAt: 1 })
    .limit(maxEntities * 5)
    .lean();

  if (candidates.length === 0) {
    return {
      staleSeconds,
      scannedEntities: 0,
      reenqueuedEntities: 0,
      details: [] as Array<{
        flowId: string;
        entity: string;
        pendingCount: number;
      }>,
    };
  }

  const flowIds = Array.from(
    new Set(candidates.map(state => String(state.flowId))),
  ).map(id => new Types.ObjectId(id));

  const flows = await Flow.find({ _id: { $in: flowIds } })
    .select({ _id: 1, syncEngine: 1, syncState: 1, tableDestination: 1 })
    .lean();
  const flowMap = new Map(flows.map(flow => [String(flow._id), flow]));

  let scannedEntities = 0;
  let reenqueuedEntities = 0;
  const details: Array<{
    flowId: string;
    entity: string;
    pendingCount: number;
  }> = [];

  for (const state of candidates) {
    if (reenqueuedEntities >= maxEntities) break;
    scannedEntities += 1;

    const flowId = String(state.flowId);
    const flow = flowMap.get(flowId);
    if (!flow || flow.syncEngine !== "cdc") continue;
    if (flow.syncState === "paused") continue;
    if (!flow.tableDestination?.connectionId) continue;

    const pendingCount = await getCdcEventStore().countEvents({
      flowId,
      entity: state.entity,
      materializationStatus: "pending",
    });

    // Keep state backlog in sync even when no requeue is needed.
    if (state.backlogCount !== pendingCount) {
      await CdcEntityState.updateOne(
        { _id: state._id },
        { $set: { backlogCount: pendingCount } },
      );
    }

    if (pendingCount === 0) continue;

    await maybeEnqueueMaterialization({
      workspaceId: state.workspaceId,
      flowId: state.flowId,
      entity: state.entity,
      force: true,
    });
    reenqueuedEntities += 1;
    details.push({
      flowId,
      entity: state.entity,
      pendingCount,
    });
  }

  if (reenqueuedEntities > 0) {
    log.warn("Auto-reenqueued stale CDC entities", {
      staleSeconds,
      scannedEntities,
      reenqueuedEntities,
      details,
    });
  }

  return {
    staleSeconds,
    scannedEntities,
    reenqueuedEntities,
    details,
  };
}

export async function retryFailedCdcMaterializationForFlow(params: {
  workspaceId: string;
  flowId: string;
  entity?: string;
}) {
  const workspaceObjectId = new Types.ObjectId(params.workspaceId);
  const flowObjectId = new Types.ObjectId(params.flowId);
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
    await maybeEnqueueMaterialization({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      entity,
      force: true,
    });
  }

  log.info("Retried failed CDC materialization rows", {
    flowId: params.flowId,
    entity: params.entity || null,
    resetCount,
    entityCount: entities.length,
  });

  return {
    resetCount,
    entities,
  };
}

export async function recordCdcMaterializationFailure(params: {
  flowId: string;
  entity: string;
  errorCode?: string;
  error: string;
}) {
  log.error("CDC materialization failed", {
    flowId: params.flowId,
    entity: params.entity,
    errorCode: params.errorCode || "MATERIALIZATION_FAILED",
    error: params.error,
  });
}

export async function resolveDestinationTypeForFlow(
  flow: Pick<IFlow, "tableDestination">,
): Promise<string | undefined> {
  if (!flow.tableDestination?.connectionId) return undefined;
  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  )
    .select({ type: 1 })
    .lean();
  return destination?.type;
}
