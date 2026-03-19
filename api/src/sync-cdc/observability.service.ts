import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  Flow,
  SyncState,
  WebhookEvent,
} from "../database/workspace-schema";
import {
  CdcSyncDiagnostics,
  CdcSyncSummary,
} from "./contracts/sync-summary";

function getEnabledEntities(flow: any, stateEntities: string[]): string[] {
  if (Array.isArray(flow?.entityLayouts) && flow.entityLayouts.length > 0) {
    return flow.entityLayouts
      .filter((layout: any) => layout.enabled !== false)
      .map((layout: any) => layout.entity);
  }

  if (Array.isArray(flow?.entityFilter) && flow.entityFilter.length > 0) {
    return flow.entityFilter;
  }

  return stateEntities;
}

function toLagSeconds(value: Date | null): number | null {
  if (!value) return null;
  return Math.max(Math.floor((Date.now() - value.getTime()) / 1000), 0);
}

export class CdcObservabilityService {
  async getSummary(workspaceId: string, flowId: string): Promise<CdcSyncSummary> {
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
    const [lastTransition, lastWebhook, states] = await Promise.all([
      CdcStateTransition.findOne({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ at: -1 })
        .lean(),
      WebhookEvent.findOne({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ receivedAt: -1 })
        .select({ receivedAt: 1 })
        .lean(),
      CdcEntityState.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      }).lean(),
    ]);

    const stateEntities = states.map(state => state.entity);
    const enabledEntities = getEnabledEntities(flow, stateEntities);

    const [backlogCount, failedCount, perEntityBacklog, perEntityFailed] =
      await Promise.all([
      CdcChangeEvent.countDocuments({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        materializationStatus: "pending",
      }),
      CdcChangeEvent.countDocuments({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        materializationStatus: "failed",
      }),
      CdcChangeEvent.aggregate([
        {
          $match: {
            workspaceId: workspaceObjectId,
            flowId: flowObjectId,
            materializationStatus: "pending",
          },
        },
        {
          $group: {
            _id: "$entity",
            count: { $sum: 1 },
          },
        },
      ]),
      CdcChangeEvent.aggregate([
        {
          $match: {
            workspaceId: workspaceObjectId,
            flowId: flowObjectId,
            materializationStatus: "failed",
          },
        },
        {
          $group: {
            _id: "$entity",
            count: { $sum: 1 },
          },
        },
      ]),
      ]);

    const backlogByEntity = new Map<string, number>(
      perEntityBacklog.map(entry => [entry._id as string, entry.count as number]),
    );
    const failedByEntity = new Map<string, number>(
      perEntityFailed.map(entry => [entry._id as string, entry.count as number]),
    );
    const stateByEntity = new Map(states.map(state => [state.entity, state]));

    const entityCounts = enabledEntities.map(entity => {
      const state = stateByEntity.get(entity);
      const lastMaterializedAt = state?.lastMaterializedAt
        ? new Date(state.lastMaterializedAt)
        : null;
      return {
        entity,
        backlogCount: backlogByEntity.get(entity) || 0,
        failedCount: failedByEntity.get(entity) || 0,
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
      lastWebhookAt: lastWebhook?.receivedAt || null,
      lastMaterializedAt,
      backlogCount,
      failedCount,
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
      CdcChangeEvent.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ ingestSeq: -1 })
        .limit(500)
        .lean(),
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
          cursor.lastMaterializedAt ? new Date(cursor.lastMaterializedAt) : null,
        ),
        lastMaterializedAt: cursor.lastMaterializedAt
          ? new Date(cursor.lastMaterializedAt)
          : null,
      })),
      recentEvents: recentEvents.map(event => ({
        entity: event.entity,
        recordId: event.recordId,
        operation: event.op,
        sourceTs: event.sourceTs,
        ingestSeq: event.ingestSeq,
        source: event.sourceKind,
        materializationStatus: event.materializationStatus,
      })),
    };
  }
}

export const cdcObservabilityService = new CdcObservabilityService();
