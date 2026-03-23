import { Types } from "mongoose";
import type { FetchState } from "../connectors/base/BaseConnector";
import {
  CdcEntityState,
  CdcStateTransition,
  Flow,
  SyncState,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const log = loggers.sync("cdc.sync-state");

type CdcSyncEventType =
  | "START_BACKFILL"
  | "BACKFILL_COMPLETE"
  | "LAG_CLEARED"
  | "LAG_SPIKE"
  | "PAUSE"
  | "RESUME"
  | "FAIL"
  | "RECOVER";

type CdcMachineEvent =
  | { type: "START_BACKFILL"; reason?: string }
  | { type: "BACKFILL_COMPLETE"; reason?: string }
  | { type: "LAG_CLEARED"; reason?: string }
  | { type: "LAG_SPIKE"; reason?: string }
  | { type: "PAUSE"; reason?: string }
  | { type: "RESUME"; reason?: string }
  | {
      type: "FAIL";
      reason?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "RECOVER"; reason?: string };

type TransitionMap = Record<
  SyncState,
  Partial<Record<CdcSyncEventType, SyncState>>
>;

const TRANSITIONS: TransitionMap = {
  idle: {
    START_BACKFILL: "backfill",
    PAUSE: "paused",
  },
  backfill: {
    BACKFILL_COMPLETE: "catchup",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  catchup: {
    START_BACKFILL: "backfill",
    LAG_CLEARED: "live",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  live: {
    START_BACKFILL: "backfill",
    LAG_SPIKE: "catchup",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  paused: {
    START_BACKFILL: "backfill",
    RESUME: "catchup",
    FAIL: "degraded",
  },
  degraded: {
    START_BACKFILL: "backfill",
    RECOVER: "catchup",
  },
};

interface TransitionGuardContext {
  hasActiveRunLock?: boolean;
  backfillCursorExhausted?: boolean;
  backlogCount?: number;
  lagSeconds?: number | null;
  lagThresholdSeconds?: number;
}

interface ApplyTransitionInput {
  workspaceId: string;
  flowId: string;
  event: CdcMachineEvent;
  context?: TransitionGuardContext;
}

interface ApplyTransitionResult {
  changed: boolean;
  fromState: SyncState;
  toState: SyncState;
}

function resolveTransition(
  fromState: SyncState,
  eventType: CdcSyncEventType,
): SyncState | null {
  return TRANSITIONS[fromState]?.[eventType] || null;
}

function assertGuards(
  event: CdcMachineEvent,
  context?: TransitionGuardContext,
): void {
  if (event.type === "START_BACKFILL" && context?.hasActiveRunLock) {
    throw new Error("Cannot start backfill while an active run lock exists");
  }

  if (
    event.type === "BACKFILL_COMPLETE" &&
    context?.backfillCursorExhausted !== true
  ) {
    throw new Error("Cannot complete backfill before cursor exhaustion");
  }

  if (event.type === "LAG_CLEARED") {
    const backlogCount = context?.backlogCount ?? 0;
    const lagSeconds = context?.lagSeconds ?? null;
    const lagThresholdSeconds = context?.lagThresholdSeconds ?? 60;
    if (
      backlogCount !== 0 ||
      (lagSeconds !== null && lagSeconds > lagThresholdSeconds)
    ) {
      throw new Error("LAG_CLEARED guard failed: backlog/lag threshold");
    }
  }
}

class CdcSyncStateService {
  async applyTransition(
    input: ApplyTransitionInput,
  ): Promise<ApplyTransitionResult> {
    const workspaceObjectId = new Types.ObjectId(input.workspaceId);
    const flowObjectId = new Types.ObjectId(input.flowId);

    const flow = await Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("CDC lifecycle transitions require syncEngine=cdc");
    }

    const fromState = (flow.syncState || "idle") as SyncState;
    const resolved = resolveTransition(fromState, input.event.type);
    if (!resolved) {
      return { changed: false, fromState, toState: fromState };
    }

    assertGuards(input.event, input.context);

    const now = new Date();
    const reason = "reason" in input.event ? input.event.reason : undefined;
    const lastErrorCode =
      "errorCode" in input.event ? input.event.errorCode : undefined;
    const lastErrorMessage =
      "errorMessage" in input.event ? input.event.errorMessage : undefined;

    flow.syncState = resolved;
    flow.syncStateUpdatedAt = now;
    flow.syncStateMeta = {
      lastEvent: input.event.type,
      lastReason: reason,
      lastErrorCode,
      lastErrorMessage,
    };
    await flow.save();

    await CdcStateTransition.create({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      fromState,
      event: input.event.type,
      toState: resolved,
      at: now,
      reason,
    });

    log.info("CDC state transition applied", {
      flowId: input.flowId,
      fromState,
      event: input.event.type,
      toState: resolved,
      reason,
    });

    return {
      changed: fromState !== resolved,
      fromState,
      toState: resolved,
    };
  }

  async saveBackfillCursor(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    cursor: FetchState;
  }): Promise<void> {
    await CdcEntityState.updateOne(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
      },
      {
        $set: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
          backfillCursor: params.cursor as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async loadBackfillCursor(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
  }): Promise<FetchState | undefined> {
    const state = await CdcEntityState.findOne({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
    }).lean();
    return (state?.backfillCursor || undefined) as FetchState | undefined;
  }

  async clearBackfillCursorsForFlow(params: {
    workspaceId: string;
    flowId: string;
  }): Promise<void> {
    await CdcEntityState.updateMany(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
      },
      {
        $unset: {
          backfillCursor: "",
        },
      },
    );
  }

  async listCompletedBackfillEntities(params: {
    workspaceId: string;
    flowId: string;
  }): Promise<string[]> {
    const rows = await CdcEntityState.find({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      "backfillCursor.hasMore": false,
    })
      .select({ entity: 1 })
      .lean();
    return rows
      .map(row => (typeof row.entity === "string" ? row.entity : null))
      .filter((entity): entity is string => Boolean(entity));
  }

  async updateIngestState(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    sourceKind: "webhook" | "backfill";
    runId?: string;
    lastIngestSeq: number;
  }): Promise<void> {
    await CdcEntityState.updateOne(
      {
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
      },
      {
        $set: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
          mode: params.sourceKind === "backfill" ? "backfill" : "steady",
          runId: params.runId,
        },
        $max: {
          lastIngestSeq: params.lastIngestSeq,
        },
      },
      { upsert: true },
    );
  }

  async advanceConsumerCursor(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    lastIngestSeq: number;
    backlogCount?: number;
    processedEventsDelta?: number;
    rowsAppliedDelta?: number;
  }): Promise<void> {
    const increments: Record<string, number> = {};
    if (
      typeof params.processedEventsDelta === "number" &&
      Number.isFinite(params.processedEventsDelta) &&
      params.processedEventsDelta !== 0
    ) {
      increments.lifetimeEventsProcessed = params.processedEventsDelta;
    }
    if (
      typeof params.rowsAppliedDelta === "number" &&
      Number.isFinite(params.rowsAppliedDelta) &&
      params.rowsAppliedDelta !== 0
    ) {
      increments.lifetimeRowsApplied = params.rowsAppliedDelta;
    }

    const updateDoc: Record<string, unknown> = {
      $set: {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
        lastMaterializedAt: new Date(),
        ...(typeof params.backlogCount === "number"
          ? { backlogCount: params.backlogCount }
          : {}),
      },
      $max: {
        lastMaterializedSeq: params.lastIngestSeq,
      },
    };
    if (Object.keys(increments).length > 0) {
      updateDoc.$inc = increments;
    }

    await CdcEntityState.updateOne(
      {
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
      },
      updateDoc,
      { upsert: true },
    );
  }
}

export const cdcSyncStateService = new CdcSyncStateService();

export const syncMachineService = {
  applyTransition:
    cdcSyncStateService.applyTransition.bind(cdcSyncStateService),
};

export const cdcBackfillCheckpointService = {
  listCompletedEntities: async (params: {
    workspaceId: string;
    flowId: string;
    runId: string;
  }) => {
    return cdcSyncStateService.listCompletedBackfillEntities({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
    });
  },
  loadEntityCheckpoint: async (params: {
    workspaceId: string;
    flowId: string;
    runId: string;
    entity: string;
  }) => {
    return cdcSyncStateService.loadBackfillCursor({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
    });
  },
  saveEntityCheckpoint: async (params: {
    workspaceId: string;
    flowId: string;
    runId: string;
    entity: string;
    fetchState: FetchState;
  }) => {
    await cdcSyncStateService.saveBackfillCursor({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
      cursor: params.fetchState,
    });
  },
  markEntityCompleted: async (params: {
    workspaceId: string;
    flowId: string;
    runId: string;
    entity: string;
    fetchState?: FetchState;
  }) => {
    const cursor = {
      ...(params.fetchState || {
        totalProcessed: 0,
        iterationsInChunk: 0,
        hasMore: false,
      }),
      hasMore: false,
    } as FetchState;

    await cdcSyncStateService.saveBackfillCursor({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
      cursor,
    });
  },
  clearRun: async (params: {
    workspaceId: string;
    flowId: string;
    runId: string;
  }) => {
    await cdcSyncStateService.clearBackfillCursorsForFlow({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
    });
  },
};

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
    (sum, state) => sum + (state.backlogCount || 0),
    0,
  );
  const mode = states.some(state => state.mode === "backfill")
    ? "backfill"
    : "steady";
  const latestMaterializedAt = states
    .map(state => state.lastMaterializedAt)
    .filter(Boolean)
    .map(date => new Date(date as Date).getTime())
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
