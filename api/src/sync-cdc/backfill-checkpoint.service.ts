import { Types } from "mongoose";
import type { FetchState } from "../connectors/base/BaseConnector";
import { CdcBackfillCheckpoint } from "../database/workspace-schema";
import { loggers } from "../logging";

const log = loggers.sync("cdc.backfill-checkpoint");

interface CheckpointScope {
  workspaceId: string;
  flowId: string;
  runId: string;
}

export class CdcBackfillCheckpointService {
  async loadEntityCheckpoint(
    params: CheckpointScope & { entity: string },
  ): Promise<FetchState | undefined> {
    const doc = await CdcBackfillCheckpoint.findOne({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      runId: params.runId,
      entity: params.entity,
    }).lean();

    if (!doc?.fetchState) {
      return undefined;
    }

    return doc.fetchState as unknown as FetchState;
  }

  async saveEntityCheckpoint(
    params: CheckpointScope & { entity: string; fetchState: FetchState },
  ): Promise<void> {
    const now = new Date();
    await CdcBackfillCheckpoint.updateOne(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        runId: params.runId,
        entity: params.entity,
      },
      {
        $set: {
          fetchState: params.fetchState as unknown as Record<string, unknown>,
          updatedAt: now,
        },
        $setOnInsert: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          runId: params.runId,
          entity: params.entity,
        },
        $unset: {
          completedAt: "",
        },
      },
      { upsert: true },
    );
  }

  async markEntityCompleted(
    params: CheckpointScope & { entity: string; fetchState?: FetchState },
  ): Promise<void> {
    const now = new Date();
    const update: Record<string, unknown> = {
      updatedAt: now,
      completedAt: now,
    };
    if (params.fetchState) {
      update.fetchState = params.fetchState as unknown as Record<string, unknown>;
    }

    await CdcBackfillCheckpoint.updateOne(
      {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        runId: params.runId,
        entity: params.entity,
      },
      {
        $set: update,
        $setOnInsert: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          runId: params.runId,
          entity: params.entity,
        },
      },
      { upsert: true },
    );
  }

  async listCompletedEntities(params: CheckpointScope): Promise<string[]> {
    const docs = await CdcBackfillCheckpoint.find({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      runId: params.runId,
      completedAt: { $exists: true, $ne: null },
    })
      .select({ entity: 1 })
      .lean();

    return docs.map(doc => doc.entity);
  }

  async clearRun(params: CheckpointScope): Promise<number> {
    const result = await CdcBackfillCheckpoint.deleteMany({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      runId: params.runId,
    });
    log.info("Cleared CDC backfill checkpoints for run", {
      flowId: params.flowId,
      runId: params.runId,
      deleted: result.deletedCount,
    });
    return result.deletedCount || 0;
  }

  async clearFlow(workspaceId: string, flowId: string): Promise<number> {
    const result = await CdcBackfillCheckpoint.deleteMany({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
    });
    log.info("Cleared CDC backfill checkpoints for flow", {
      flowId,
      deleted: result.deletedCount,
    });
    return result.deletedCount || 0;
  }
}

export const cdcBackfillCheckpointService = new CdcBackfillCheckpointService();
