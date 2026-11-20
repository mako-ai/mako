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
import {
  backfillAttemptFilter,
  type BackfillAttempt,
} from "./backfill/attempt";
import {
  computeEntityPendingBacklog,
  computePendingLagSeconds,
} from "./backlog";

const log = loggers.sync("cdc.sync-state");

type StreamEventType = "START" | "PAUSE" | "RESUME" | "FAIL" | "RECOVER";

type BackfillEventType =
  "START" | "PAUSE" | "RESUME" | "COMPLETE" | "FAIL" | "RECOVER" | "CANCEL";

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
      providerRetryAt?: Date;
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
    PAUSE: "paused",
    CANCEL: "idle",
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
  /**
   * Apply the event only from these states; from any other state the call
   * is a no-op (`changed: false`). For callers that observed a specific
   * state and must not act on a later one — e.g. abandoned-flow cleanup
   * fails a `running` backfill but must leave one the user just paused.
   */
  onlyFrom?: BackfillStatus[];
  /** Fence a failure to its attempt, including legacy rows without an ID. */
  expectedAttempt?: BackfillAttempt;
  failureUpdate?: {
    $inc: Record<string, number>;
    $set: Record<string, unknown>;
  };
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

/**
 * How many times a transition re-reads the flow after losing a
 * compare-and-swap race before giving up. Each retry recomputes the
 * transition from the state the winner left, so a lost race either applies
 * the event on top of it or reports a no-op; it never overwrites.
 */
const MAX_TRANSITION_ATTEMPTS = 5;

/**
 * A filter matching a stored state value. A missing field reads as "idle"
 * (see `flow.streamState || "idle"`), so the idle CAS must also match a doc
 * that has no value yet. `$in: [null]` matches both null and missing.
 */
function stateFilter(path: string, state: string): Record<string, unknown> {
  return state === "idle"
    ? { [path]: { $in: [null, "idle"] } }
    : { [path]: state };
}

type TransitionMachine = "stream" | "backfill";

interface CasTransitionInput<S extends string> {
  machine: TransitionMachine;
  workspaceId: string;
  flowId: string;
  eventType: string;
  reason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  /** Dotted path of the state field on the flow document. */
  statePath: string;
  readState: (flow: {
    streamState?: string | null;
    backfillState?: { status?: string | null } | null;
  }) => S;
  resolve: (fromState: S) => S | null;
  /**
   * The `$set` for the new state. Defaults to `{ [statePath]: resolved }`;
   * the backfill machine overrides it because a dotted `$set` fails when
   * the parent subdocument is stored as null.
   */
  buildSet?: (
    flow: { backfillState?: { status?: string | null } | null },
    resolved: S,
  ) => Record<string, unknown>;
  expectedAttempt?: BackfillAttempt;
  updateIncrements?: Record<string, number>;
  updateUnset?: Record<string, "">;
  /** Throws when the transition is not allowed (guards). */
  assertGuards?: () => void;
}

/**
 * Apply one state-machine transition atomically: read the current state,
 * compute the target, then write with the read state in the filter
 * (compare-and-swap). Concurrent actors (cdc-materialize, the flow
 * function, the backfill sweeper, user pause/resume, abandoned-flow
 * cleanup) can no longer both read `running` and both apply a transition,
 * and the audit row records a `fromState` that was really there.
 */
async function casTransition<S extends string>(
  input: CasTransitionInput<S>,
): Promise<ApplyTransitionResult> {
  const workspaceObjectId = new Types.ObjectId(input.workspaceId);
  const flowObjectId = new Types.ObjectId(input.flowId);
  const scope = { _id: flowObjectId, workspaceId: workspaceObjectId };
  const attemptFilter =
    input.expectedAttempt && backfillAttemptFilter(input.expectedAttempt);

  for (let attempt = 1; attempt <= MAX_TRANSITION_ATTEMPTS; attempt++) {
    const flow = await Flow.findOne(scope)
      .select(
        "syncEngine streamState backfillState.status backfillState.runId backfillState.attemptId",
      )
      .lean();
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("CDC lifecycle transitions require syncEngine=cdc");
    }

    const fromState = input.readState(flow);
    if (
      attemptFilter &&
      ((flow.backfillState?.runId ?? null) !==
        attemptFilter["backfillState.runId"] ||
        (flow.backfillState?.attemptId ?? null) !==
          attemptFilter["backfillState.attemptId"])
    ) {
      return { changed: false, fromState, toState: fromState };
    }
    const resolved = input.resolve(fromState);
    if (!resolved) {
      return { changed: false, fromState, toState: fromState };
    }
    input.assertGuards?.();

    const now = new Date();
    const updated = await Flow.findOneAndUpdate(
      {
        ...scope,
        syncEngine: "cdc",
        ...stateFilter(input.statePath, fromState),
        ...attemptFilter,
      },
      {
        ...(input.updateIncrements ? { $inc: input.updateIncrements } : {}),
        ...(input.updateUnset ? { $unset: input.updateUnset } : {}),
        $set: {
          ...(input.buildSet
            ? input.buildSet(flow, resolved)
            : { [input.statePath]: resolved }),
          syncStateUpdatedAt: now,
          syncStateMeta: {
            lastEvent: `${input.machine}:${input.eventType}`,
            lastReason: input.reason,
            lastErrorCode: input.lastErrorCode,
            lastErrorMessage: input.lastErrorMessage,
          },
        },
      },
      { projection: { _id: 1 } },
    ).lean();

    if (!updated) {
      log.debug("State transition lost a compare-and-swap race; retrying", {
        flowId: input.flowId,
        machine: input.machine,
        fromState,
        event: input.eventType,
        attempt,
      });
      continue;
    }

    await CdcStateTransition.create({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      machine: input.machine,
      fromState,
      event: input.eventType,
      toState: resolved,
      at: now,
      reason: input.reason,
    });

    log.info(
      input.machine === "stream"
        ? "Stream state transition applied"
        : "Backfill state transition applied",
      {
        flowId: input.flowId,
        fromState,
        event: input.eventType,
        toState: resolved,
        reason: input.reason,
      },
    );

    return { changed: fromState !== resolved, fromState, toState: resolved };
  }

  throw new Error(
    `CDC ${input.machine} transition ${input.eventType} for flow ${input.flowId} ` +
      `lost ${MAX_TRANSITION_ATTEMPTS} compare-and-swap races`,
  );
}

function eventDetails(event: StreamMachineEvent | BackfillMachineEvent): {
  reason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
} {
  return {
    reason: "reason" in event ? event.reason : undefined,
    lastErrorCode: "errorCode" in event ? event.errorCode : undefined,
    lastErrorMessage: "errorMessage" in event ? event.errorMessage : undefined,
  };
}

class CdcSyncStateService {
  async applyStreamTransition(
    input: ApplyStreamTransitionInput,
  ): Promise<ApplyTransitionResult> {
    return casTransition<StreamState>({
      machine: "stream",
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      eventType: input.event.type,
      ...eventDetails(input.event),
      statePath: "streamState",
      readState: flow => (flow.streamState || "idle") as StreamState,
      resolve: from => STREAM_TRANSITIONS[from]?.[input.event.type] || null,
    });
  }

  async applyBackfillTransition(
    input: ApplyBackfillTransitionInput,
  ): Promise<ApplyTransitionResult> {
    return casTransition<BackfillStatus>({
      machine: "backfill",
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      eventType: input.event.type,
      ...eventDetails(input.event),
      statePath: "backfillState.status",
      expectedAttempt: input.expectedAttempt,
      updateIncrements: input.failureUpdate?.$inc,
      updateUnset:
        input.event.type === "CANCEL"
          ? {
              "backfillState.runId": "",
              "backfillState.attemptId": "",
              "backfillState.dispatchPendingAt": "",
              "backfillState.providerRetryAt": "",
            }
          : input.event.type === "FAIL" && input.expectedAttempt
            ? { "backfillState.dispatchPendingAt": "" }
            : undefined,
      readState: flow =>
        (flow.backfillState?.status || "idle") as BackfillStatus,
      resolve: from =>
        input.onlyFrom && !input.onlyFrom.includes(from)
          ? null
          : BACKFILL_TRANSITIONS[from]?.[input.event.type] || null,
      buildSet: (flow, resolved) => {
        const providerRetryAt =
          input.event.type === "FAIL" ? input.event.providerRetryAt : undefined;
        const failureSet = input.failureUpdate?.$set;
        return flow.backfillState == null
          ? {
              backfillState: {
                status: resolved,
                ...(providerRetryAt ? { providerRetryAt } : {}),
              },
            }
          : {
              ...failureSet,
              "backfillState.status": resolved,
              ...(input.event.type === "PAUSE" || input.event.type === "CANCEL"
                ? { "backfillState.completedAt": null }
                : {}),
              ...(providerRetryAt
                ? { "backfillState.providerRetryAt": providerRetryAt }
                : {}),
            };
      },
      assertGuards: () => assertBackfillGuards(input.event, input.context),
    });
  }

  async saveBackfillCursor(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    cursor: FetchState;
    scope: string;
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
          backfillCursorScope: params.scope,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  /** The entity's cursor, only when it was saved under `scope`. */
  async loadBackfillCursor(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    scope: string;
  }): Promise<FetchState | undefined> {
    const state = await CdcEntityState.findOne({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
      backfillCursorScope: params.scope,
    }).lean();
    return (state?.backfillCursor || undefined) as FetchState | undefined;
  }

  async clearBackfillCursorsForFlow(params: {
    workspaceId: string;
    flowId: string;
    scope?: string;
  }): Promise<void> {
    await CdcEntityState.updateMany(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        ...(params.scope ? { backfillCursorScope: params.scope } : {}),
      },
      {
        $unset: {
          backfillCursor: "",
          backfillCursorScope: "",
        },
      },
    );
  }

  /** Entities whose cursor of `scope` is exhausted. */
  async listCompletedBackfillEntities(params: {
    workspaceId: string;
    flowId: string;
    scope: string;
  }): Promise<string[]> {
    const rows = await CdcEntityState.find({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      backfillCursorScope: params.scope,
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

function anchorStamps(
  runStartedAt: string | Date | undefined,
  fetchMode: "full" | "incremental" | undefined,
): Record<string, Date> {
  if (!runStartedAt || !fetchMode) return {};
  const startedAt = new Date(runStartedAt);
  if (Number.isNaN(startedAt.getTime())) return {};
  return fetchMode === "full"
    ? {
        lastBackfillRunStartedAt: startedAt,
        lastFullBackfillRunStartedAt: startedAt,
      }
    : { lastBackfillRunStartedAt: startedAt };
}

/**
 * The scope a backfill checkpoint is saved and resumed under: the backfill
 * run, and the destination table it writes to. A cursor only resumes the run
 * that saved it, against the same destination. A new backfill gets a new
 * runId (startBackfill), so it starts fresh instead of resuming a cancelled
 * run; pause/resume and recovery reuse the runId and resume. A flow repointed
 * to another destination starts fresh too.
 */
export function backfillCheckpointScope(params: {
  runId: string;
  destinationId?: string;
  tableDestination?: Record<string, unknown> | null;
}): string {
  const table = params.tableDestination ?? {};
  return [
    params.runId,
    params.destinationId ?? "",
    String(table.connectionId ?? ""),
    String(table.schema ?? ""),
    String(table.tableName ?? ""),
  ].join("|");
}

export const cdcBackfillCheckpointService = {
  listCompletedEntities: async (params: {
    workspaceId: string;
    flowId: string;
    scope: string;
  }) => {
    return cdcSyncStateService.listCompletedBackfillEntities(params);
  },
  loadEntityCheckpoint: async (params: {
    workspaceId: string;
    flowId: string;
    scope: string;
    entity: string;
  }) => {
    return cdcSyncStateService.loadBackfillCursor(params);
  },
  /**
   * Save the entity's resume cursor. Callers save only a cursor whose rows
   * all reached the destination: a resume skips every row before it.
   */
  saveEntityCheckpoint: async (params: {
    workspaceId: string;
    flowId: string;
    scope: string;
    entity: string;
    fetchState: FetchState;
  }) => {
    await cdcSyncStateService.saveBackfillCursor({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
      cursor: params.fetchState,
      scope: params.scope,
    });
  },
  markEntityCompleted: async (params: {
    workspaceId: string;
    flowId: string;
    scope: string;
    entity: string;
    fetchState?: FetchState;
    /** Rows this backfill run wrote to the destination for this entity. */
    rowsWritten?: number;
    /**
     * `backfillState.startedAt` of this run and how the entity was fetched;
     * stamped as the anchor of the next incremental scheduled resync
     * (sync-cdc/backfill-fetch-mode.ts). Omitted for connectors not covered.
     */
    runStartedAt?: string | Date;
    fetchMode?: "full" | "incremental";
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
      scope: params.scope,
    });

    // Backfills write directly via the adapter (applyBatch / staging merge),
    // bypassing the event-store consumer that normally maintains
    // lifetimeRowsApplied — account for those rows here so the UI's
    // "Rows applied" reflects backfilled data too.
    const rowsWritten =
      typeof params.rowsWritten === "number" &&
      Number.isFinite(params.rowsWritten) &&
      params.rowsWritten > 0
        ? params.rowsWritten
        : 0;

    await CdcEntityState.updateOne(
      {
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
      },
      {
        $set: {
          backfillCompletedAt: new Date(),
          ...anchorStamps(params.runStartedAt, params.fetchMode),
        },
        ...(rowsWritten > 0
          ? { $inc: { lifetimeRowsApplied: rowsWritten } }
          : {}),
      },
    );
  },
  clearRun: (params: { workspaceId: string; flowId: string; scope: string }) =>
    cdcSyncStateService.clearBackfillCursorsForFlow(params),
};

export async function getCdcFlowStats(params: { flowId: string }): Promise<{
  enabled: boolean;
  mode: "steady" | "backfill";
  entities: number;
  backlogCount: number;
  lagSeconds: number | null;
}> {
  const flowObjectId = new Types.ObjectId(params.flowId);
  const [states, pendingCount, oldestPendingResult] = await Promise.all([
    CdcEntityState.find({ flowId: flowObjectId }).lean(),
    CdcChangeEvent.countDocuments({
      flowId: flowObjectId,
      materializationStatus: "pending",
    }),
    CdcChangeEvent.findOne(
      { flowId: flowObjectId, materializationStatus: "pending" },
      { ingestTs: 1 },
    )
      .sort({ ingestTs: 1 })
      .lean(),
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

  // Real pending CdcChangeEvents only — do not max() with cursor seq gaps.
  const backlogCount = computeEntityPendingBacklog(pendingCount);
  const mode = states.some(state => state.mode === "backfill")
    ? "backfill"
    : "steady";
  const oldestPendingTs = oldestPendingResult?.ingestTs
    ? new Date(oldestPendingResult.ingestTs)
    : null;
  const lagSeconds = computePendingLagSeconds({
    pendingCount: backlogCount,
    oldestPendingTs,
  });

  return {
    enabled: true,
    mode,
    entities: states.length,
    backlogCount,
    lagSeconds,
  };
}
