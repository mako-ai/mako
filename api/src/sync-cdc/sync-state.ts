/**
 * CDC sync state management — stream and backfill state machines,
 * entity-level cursor tracking, and backfill checkpoint services.
 *
 * Defines `STREAM_TRANSITIONS` and `BACKFILL_TRANSITIONS` that govern
 * valid state changes, and exports `cdcSyncStateService` for applying
 * transitions and querying flow statistics.
 */
import { Types } from "mongoose";
import type { FetchState } from "../connectors/base/BaseConnector";
import {
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  Flow,
  StreamState,
  BackfillStatus,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const log = loggers.sync("cdc.sync-state");

type StreamEventType = "START" | "PAUSE" | "RESUME" | "FAIL" | "RECOVER";

type BackfillEventType =
  | "START"
  | "PAUSE"
  | "RESUME"
  | "COMPLETE"
  | "FAIL"
  | "RECOVER"
  | "CANCEL";

type StreamMachineEvent =
  | { type: "START"; reason?: string }
  | { type: "PAUSE"; reason?: string }
  | { type: "RESUME"; reason?: string }
  | {
      type: "FAIL";
      reason?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "RECOVER"; reason?: string };

type BackfillMachineEvent =
  | { type: "START"; reason?: string }
  | { type: "PAUSE"; reason?: string }
  | { type: "RESUME"; reason?: string }
  | { type: "COMPLETE"; reason?: string }
  | {
      type: "FAIL";
      reason?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "RECOVER"; reason?: string }
  | { type: "CANCEL"; reason?: string };

const STREAM_TRANSITIONS: Record<
  StreamState,
  Partial<Record<StreamEventType, StreamState>>
> = {
  idle: {
    START: "active",
    RESUME: "active",
  },
  active: {
    PAUSE: "paused",
    FAIL: "error",
  },
  paused: {
    START: "active",
    RESUME: "active",
    RECOVER: "active",
    FAIL: "error",
  },
  error: {
    RECOVER: "active",
  },
};

const BACKFILL_TRANSITIONS: Record<
  BackfillStatus,
  Partial<Record<BackfillEventType, BackfillStatus>>
> = {
  idle: {
    START: "running",
  },
  running: {
    PAUSE: "paused",
    COMPLETE: "completed",
    FAIL: "error",
    CANCEL: "idle",
  },
  paused: {
    RESUME: "running",
    COMPLETE: "completed",
    FAIL: "error",
    CANCEL: "idle",
  },
  completed: {
    START: "running",
  },
  error: {
    RECOVER: "running",
    START: "running",
  },
};

interface TransitionGuardContext {
  hasActiveRunLock?: boolean;
  backfillCursorExhausted?: boolean;
}

interface ApplyStreamTransitionInput {
  workspaceId: string;
  flowId: string;
  event: StreamMachineEvent;
}

interface ApplyBackfillTransitionInput {
  workspaceId: string;
  flowId: string;
  event: BackfillMachineEvent;
  context?: TransitionGuardContext;
}

interface ApplyTransitionResult {
  changed: boolean;
  fromState: string;
  toState: string;
}

function assertBackfillGuards(
  event: BackfillMachineEvent,
  context?: TransitionGuardContext,
): void {
  if (event.type === "START" && context?.hasActiveRunLock) {
    throw new Error("Cannot start backfill while an active run lock exists");
  }

  if (event.type === "COMPLETE" && context?.backfillCursorExhausted !== true) {
    throw new Error("Cannot complete backfill before cursor exhaustion");
  }
}

class CdcSyncStateService {
  async applyStreamTransition(
    input: ApplyStreamTransitionInput,
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

    const fromState = (flow.streamState || "idle") as StreamState;
    const resolved = STREAM_TRANSITIONS[fromState]?.[input.event.type] || null;
    if (!resolved) {
      return { changed: false, fromState, toState: fromState };
    }

    const now = new Date();
    const reason = "reason" in input.event ? input.event.reason : undefined;
    const lastErrorCode =
      "errorCode" in input.event ? input.event.errorCode : undefined;
    const lastErrorMessage =
      "errorMessage" in input.event ? input.event.errorMessage : undefined;

    flow.streamState = resolved;
    flow.syncStateUpdatedAt = now;
    flow.syncStateMeta = {
      lastEvent: `stream:${input.event.type}`,
      lastReason: reason,
      lastErrorCode,
      lastErrorMessage,
    };
    await flow.save();

    await CdcStateTransition.create({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      machine: "stream",
      fromState,
      event: input.event.type,
      toState: resolved,
      at: now,
      reason,
    });

    log.info("Stream state transition applied", {
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

  async applyBackfillTransition(
    input: ApplyBackfillTransitionInput,
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

    const fromState = (flow.backfillState?.status || "idle") as BackfillStatus;
    const resolved =
      BACKFILL_TRANSITIONS[fromState]?.[input.event.type] || null;
    if (!resolved) {
      return { changed: false, fromState, toState: fromState };
    }

    assertBackfillGuards(input.event, input.context);

    const now = new Date();
    const reason = "reason" in input.event ? input.event.reason : undefined;
    const lastErrorCode =
      "errorCode" in input.event ? input.event.errorCode : undefined;
    const lastErrorMessage =
      "errorMessage" in input.event ? input.event.errorMessage : undefined;

    if (!flow.backfillState) {
      flow.backfillState = { status: "idle" };
    }
    flow.backfillState.status = resolved;
    flow.syncStateUpdatedAt = now;
    flow.syncStateMeta = {
      lastEvent: `backfill:${input.event.type}`,
      lastReason: reason,
      lastErrorCode,
      lastErrorMessage,
    };
    await flow.save();

    await CdcStateTransition.create({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      machine: "backfill",
      fromState,
      event: input.event.type,
      toState: resolved,
      at: now,
      reason,
    });

    log.info("Backfill state transition applied", {
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
    const processedEventsDelta =
      typeof params.processedEventsDelta === "number" &&
      Number.isFinite(params.processedEventsDelta)
        ? params.processedEventsDelta
        : 0;
    const rowsAppliedDelta =
      typeof params.rowsAppliedDelta === "number" &&
      Number.isFinite(params.rowsAppliedDelta)
        ? params.rowsAppliedDelta
        : 0;
    const increments: Record<string, number> = {
      lifetimeEventsProcessed: processedEventsDelta,
      lifetimeRowsApplied: rowsAppliedDelta,
    };

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
    updateDoc.$inc = increments;

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
  applyStreamTransition:
    cdcSyncStateService.applyStreamTransition.bind(cdcSyncStateService),
  applyBackfillTransition:
    cdcSyncStateService.applyBackfillTransition.bind(cdcSyncStateService),
};

export const cdcBackfillCheckpointService = {
  listCompletedEntities: async (params: {
    workspaceId: string;
    flowId: string;
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

    await CdcEntityState.updateOne(
      {
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
      },
      { $set: { backfillCompletedAt: new Date() } },
    );
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
  const flowObjectId = new Types.ObjectId(params.flowId);
  const [states, pendingCount] = await Promise.all([
    CdcEntityState.find({ flowId: flowObjectId }).lean(),
    CdcChangeEvent.countDocuments({
      flowId: flowObjectId,
      materializationStatus: "pending",
    }),
  ]);
  if (states.length === 0) {
    return {
      enabled: false,
      mode: "steady",
      entities: 0,
      backlogCount: 0,
      lagSeconds: null,
    };
  }

  const backlogCount = Math.max(
    pendingCount,
    states.reduce(
      (sum, state) =>
        sum +
        Math.max(
          (state.lastIngestSeq || 0) - (state.lastMaterializedSeq || 0),
          state.backlogCount || 0,
        ),
      0,
    ),
  );
  const mode = states.some(state => state.mode === "backfill")
    ? "backfill"
    : "steady";
  let lagSeconds: number | null;
  if (backlogCount > 0) {
    const withBacklog = states.filter(
      s =>
        Math.max(
          (s.lastIngestSeq || 0) - (s.lastMaterializedSeq || 0),
          s.backlogCount || 0,
        ) > 0,
    );
    const candidates = withBacklog.length > 0 ? withBacklog : states;
    const oldest = candidates
      .map(s => s.lastMaterializedAt)
      .filter(Boolean)
      .map(d => new Date(d as Date).getTime())
      .sort((a, b) => a - b)[0];
    lagSeconds = oldest
      ? Math.max(Math.floor((Date.now() - oldest) / 1000), 0)
      : null;
  } else {
    lagSeconds = 0;
  }

  return {
    enabled: true,
    mode,
    entities: states.length,
    backlogCount,
    lagSeconds,
  };
}
