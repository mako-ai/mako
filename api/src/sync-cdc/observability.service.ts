import { Types } from "mongoose";
import {
  CdcEntityState,
  CdcStateTransition,
  Flow,
  SyncState,
} from "../database/workspace-schema";
import { CdcSyncDiagnostics, CdcSyncSummary } from "./contracts/observability";
import { resolveConfiguredEntities } from "./entity-selection";
import { getCdcEventStore } from "./stores";

function toLagSeconds(value: Date | null): number | null {
  if (!value) return null;
  return Math.max(Math.floor((Date.now() - value.getTime()) / 1000), 0);
}

export class CdcObservabilityService {
  async getSummary(
    workspaceId: string,
    flowId: string,
  ): Promise<CdcSyncSummary> {
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const flowObjectId = new Types.ObjectId(flowId);

    const flow = await Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    }).lean();
    if (!flow) {
      throw new Error("Flow not found");
    }

    const syncState = (flow.syncState || "idle") as SyncState;
    const eventStore = getCdcEventStore();
    const [lastTransition, lastIngestedWebhook, states] = await Promise.all([
      CdcStateTransition.findOne({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ at: -1 })
        .lean(),
      eventStore.findLatestEvent({
        workspaceId,
        flowId,
        source: "webhook",
      }),
      CdcEntityState.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      }).lean(),
    ]);

    const stateEntities = states.map(state => state.entity);
    const { entities: configuredEntities, hasExplicitSelection } =
      resolveConfiguredEntities(flow);
    const enabledEntities = hasExplicitSelection
      ? configuredEntities
      : stateEntities;

    const [
      appliedCount,
      backlogCount,
      failedCount,
      droppedCount,
      perEntityApplied,
      perEntityBacklog,
      perEntityFailed,
      perEntityDropped,
    ] = await Promise.all([
      eventStore.countEvents({
        workspaceId,
        flowId,
        materializationStatus: "applied",
      }),
      eventStore.countEvents({
        workspaceId,
        flowId,
        materializationStatus: "pending",
      }),
      eventStore.countEvents({
        workspaceId,
        flowId,
        materializationStatus: "failed",
      }),
      eventStore.countEvents({
        workspaceId,
        flowId,
        materializationStatus: "dropped",
      }),
      eventStore.countEventsByEntity({
        workspaceId,
        flowId,
        materializationStatus: "applied",
      }),
      eventStore.countEventsByEntity({
        workspaceId,
        flowId,
        materializationStatus: "pending",
      }),
      eventStore.countEventsByEntity({
        workspaceId,
        flowId,
        materializationStatus: "failed",
      }),
      eventStore.countEventsByEntity({
        workspaceId,
        flowId,
        materializationStatus: "dropped",
      }),
    ]);

    const appliedByEntity = new Map<string, number>(
      perEntityApplied.map(entry => [entry.entity, entry.count]),
    );
    const backlogByEntity = new Map<string, number>(
      perEntityBacklog.map(entry => [entry.entity, entry.count]),
    );
    const failedByEntity = new Map<string, number>(
      perEntityFailed.map(entry => [entry.entity, entry.count]),
    );
    const droppedByEntity = new Map<string, number>(
      perEntityDropped.map(entry => [entry.entity, entry.count]),
    );
    const stateByEntity = new Map(states.map(state => [state.entity, state]));

    const entityCounts = enabledEntities.map(entity => {
      const state = stateByEntity.get(entity);
      const lastMaterializedAt = state?.lastMaterializedAt
        ? new Date(state.lastMaterializedAt)
        : null;
      return {
        entity,
        appliedCount: appliedByEntity.get(entity) || 0,
        backlogCount: backlogByEntity.get(entity) || 0,
        failedCount: failedByEntity.get(entity) || 0,
        droppedCount: droppedByEntity.get(entity) || 0,
        lagSeconds: toLagSeconds(lastMaterializedAt),
        lastMaterializedAt,
      };
    });

    const lastMaterializedAt =
      entityCounts
        .map(entity => entity.lastMaterializedAt)
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    const minMaterializedAt =
      entityCounts
        .map(entity => entity.lastMaterializedAt)
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0] || null;

    return {
      syncState,
      lastTransition: lastTransition
        ? {
            fromState: lastTransition.fromState,
            event: lastTransition.event,
            toState: lastTransition.toState,
            at: lastTransition.at,
            reason: lastTransition.reason,
          }
        : null,
      lastWebhookAt: lastIngestedWebhook?.ingestTs || null,
      lastMaterializedAt,
      appliedCount,
      backlogCount,
      failedCount,
      droppedCount,
      lagSeconds: toLagSeconds(minMaterializedAt),
      entityCounts,
    };
  }

  async getDiagnostics(
    workspaceId: string,
    flowId: string,
  ): Promise<CdcSyncDiagnostics> {
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const flowObjectId = new Types.ObjectId(flowId);

    const flow = await Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    }).lean();
    if (!flow) {
      throw new Error("Flow not found");
    }

    const eventStore = getCdcEventStore();
    const [transitions, cursors, recentEvents] = await Promise.all([
      CdcStateTransition.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ at: -1 })
        .limit(200)
        .lean(),
      CdcEntityState.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ entity: 1 })
        .lean(),
      eventStore.listRecentEvents({
        workspaceId,
        flowId,
        limit: 500,
      }),
    ]);

    return {
      syncState: (flow.syncState || "idle") as SyncState,
      transitions: transitions.map(transition => ({
        fromState: transition.fromState,
        event: transition.event,
        toState: transition.toState,
        at: transition.at,
        reason: transition.reason,
      })),
      cursors: cursors.map(cursor => ({
        entity: cursor.entity,
        lastIngestSeq: cursor.lastIngestSeq || 0,
        lastMaterializedSeq: cursor.lastMaterializedSeq || 0,
        backlogCount: cursor.backlogCount || 0,
        lagSeconds: toLagSeconds(
          cursor.lastMaterializedAt
            ? new Date(cursor.lastMaterializedAt)
            : null,
        ),
        lastMaterializedAt: cursor.lastMaterializedAt
          ? new Date(cursor.lastMaterializedAt)
          : null,
      })),
      recentEvents: recentEvents.map(event => ({
        entity: event.entity,
        recordId: event.recordId,
        operation: event.operation,
        sourceTs: event.sourceTs,
        ingestSeq: event.ingestSeq,
        source: event.source,
        materializationStatus: event.materializationStatus,
      })),
    };
  }
}

export const cdcObservabilityService = new CdcObservabilityService();
