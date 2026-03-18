import { Types } from "mongoose";
import {
  CdcStateTransition,
  Flow,
  SyncState,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  CdcMachineContext,
  CdcMachineEvent,
  CdcSyncEventType,
  passesTransitionGuard,
  resolveCdcTransition,
} from "./sync.machine";

const log = loggers.sync("cdc.machine");

export interface ApplyTransitionInput {
  workspaceId: string;
  flowId: string;
  event: CdcMachineEvent;
  context?: Partial<CdcMachineContext>;
}

export interface ApplyTransitionResult {
  changed: boolean;
  fromState: SyncState;
  toState: SyncState;
}

export class SyncMachineService {
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
    const eventType = input.event.type as CdcSyncEventType;
    const resolved = resolveCdcTransition(fromState, eventType);
    if (!resolved) {
      return { changed: false, fromState, toState: fromState };
    }

    this.assertGuards(input.event, input.context);

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

    return { changed: fromState !== resolved, fromState, toState: resolved };
  }

  async getLastTransition(workspaceId: string, flowId: string) {
    return CdcStateTransition.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
    })
      .sort({ at: -1 })
      .lean();
  }

  private assertGuards(
    event: CdcMachineEvent,
    context?: Partial<CdcMachineContext>,
  ) {
    if (!passesTransitionGuard(event, context)) {
      if (event.type === "START_BACKFILL") {
        throw new Error(
          "Cannot start backfill while an active run lock exists",
        );
      }
      if (event.type === "BACKFILL_COMPLETE") {
        throw new Error("Cannot complete backfill before cursor exhaustion");
      }
      if (event.type === "LAG_CLEARED") {
        throw new Error("LAG_CLEARED guard failed: backlog/lag threshold");
      }
    }

    // Specific messages retained for backwards-compatible API errors.
    if (event.type === "START_BACKFILL" && context?.hasActiveRunLock) {
      throw new Error("Cannot start backfill while an active run lock exists");
    }

    if (event.type === "BACKFILL_COMPLETE" && !context?.backfillCursorExhausted) {
      throw new Error("Cannot complete backfill before cursor exhaustion");
    }

    if (event.type === "LAG_CLEARED") {
      const backlogCount = context?.backlogCount ?? 0;
      const lagSeconds = context?.lagSeconds ?? null;
      const lagThreshold = context?.lagThresholdSeconds ?? 60;
      const lagWithinThreshold =
        lagSeconds === null || lagSeconds <= lagThreshold;
      if (backlogCount > 0 || !lagWithinThreshold) {
        throw new Error("LAG_CLEARED guard failed: backlog/lag threshold");
      }
    }
  }
}

export const syncMachineService = new SyncMachineService();
