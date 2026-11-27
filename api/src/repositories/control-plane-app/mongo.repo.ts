/**
 * MongoDB test fallbacks for the small app control-plane repositories.
 * Legacy MongoMemoryServer suites run without `POSTGRES_URL`; production
 * always uses the Postgres implementations.
 */
import mongoose, { Types } from "mongoose";
import {
  WorkflowRecordedRun,
  WorkflowRecordedWrite,
} from "../../database/models/workflow-recorded-writes";
import { ModelCatalogSnapshot } from "../../database/schema";
import type {
  AppsBoxPolicyRepository,
  ModelCatalogSnapshotId,
  ModelCatalogSnapshotRecord,
  ModelCatalogSnapshotWrite,
  ModelCatalogSnapshotsRepository,
  RecordedWriteInput,
  RecordedWriteRow,
  RecordedWritesFilter,
  WorkflowRecordedWritesRepository,
} from "./types";

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number } | null)?.code === 11000;

export class MongoWorkflowRecordedWritesRepository implements WorkflowRecordedWritesRepository {
  /**
   * Two first writes may race on the upsert: the one that loses tries again
   * once, finding the run's row.
   */
  private async takePlace(
    workspaceId: string,
    runId: string,
    max: number,
  ): Promise<number | null> {
    const ws = new Types.ObjectId(workspaceId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const row = await WorkflowRecordedRun.findOneAndUpdate(
          { workspaceId: ws, runId, count: { $lt: max } },
          { $inc: { count: 1 }, $setOnInsert: { at: new Date() } },
          { upsert: true, returnDocument: "after" },
        ).lean();
        return row ? row.count - 1 : null;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const full = await WorkflowRecordedRun.exists({
          workspaceId: ws,
          runId,
          count: { $gte: max },
        });
        if (full) return null;
      }
    }
    return null;
  }

  async appendWrite(
    input: RecordedWriteInput,
    max: number,
  ): Promise<number | null> {
    const seq = await this.takePlace(input.workspaceId, input.runId, max);
    if (seq === null) return null;
    await WorkflowRecordedWrite.create({
      workspaceId: new Types.ObjectId(input.workspaceId),
      runId: input.runId,
      ...(input.userId ? { userId: input.userId } : {}),
      connectionId: new Types.ObjectId(input.connectionId),
      connection: input.connection,
      ...(input.step ? { step: input.step } : {}),
      request: input.request,
      seq,
      ...(input.bodyCut ? { bodyCut: true } : {}),
      ...(input.wouldSend !== undefined ? { wouldSend: input.wouldSend } : {}),
    });
    return seq;
  }

  private filterOf(filter: RecordedWritesFilter) {
    if (!Types.ObjectId.isValid(filter.workspaceId)) return null;
    return {
      workspaceId: new Types.ObjectId(filter.workspaceId),
      runId: filter.runId,
      ...(filter.userId !== undefined ? { userId: filter.userId } : {}),
    };
  }

  async countWrites(filter: RecordedWritesFilter): Promise<number> {
    const f = this.filterOf(filter);
    return f ? WorkflowRecordedWrite.countDocuments(f) : 0;
  }

  async listWrites(
    filter: RecordedWritesFilter,
    page: { offset: number; limit: number },
  ): Promise<RecordedWriteRow[]> {
    const f = this.filterOf(filter);
    if (!f) return [];
    const rows = await WorkflowRecordedWrite.find(f)
      .sort({ seq: 1 })
      .skip(page.offset)
      .limit(page.limit)
      .lean();
    return rows.map(row => ({
      connection: row.connection,
      ...(row.step ? { step: row.step } : {}),
      request: row.request,
      seq: row.seq,
      ...(row.bodyCut ? { bodyCut: true } : {}),
      ...(row.wouldSend !== undefined ? { wouldSend: row.wouldSend } : {}),
      at: row.at,
    }));
  }
}

type LeanSnapshot = {
  _id: ModelCatalogSnapshotId;
  data: unknown;
  fetchedAt: Date;
  itemCount: number;
};

function mongoSnapshotToRecord(doc: LeanSnapshot): ModelCatalogSnapshotRecord {
  return {
    id: doc._id,
    data: doc.data,
    fetchedAt: doc.fetchedAt,
    itemCount: doc.itemCount ?? 0,
  };
}

export class MongoModelCatalogSnapshotsRepository implements ModelCatalogSnapshotsRepository {
  async findSnapshot(
    id: ModelCatalogSnapshotId,
  ): Promise<ModelCatalogSnapshotRecord | null> {
    const doc = await ModelCatalogSnapshot.findOne({
      _id: id,
    }).lean<LeanSnapshot>();
    return doc ? mongoSnapshotToRecord(doc) : null;
  }

  async findSnapshots(
    ids: readonly ModelCatalogSnapshotId[],
  ): Promise<ModelCatalogSnapshotRecord[]> {
    const docs = await ModelCatalogSnapshot.find({
      _id: { $in: [...ids] },
    }).lean<LeanSnapshot[]>();
    return docs.map(mongoSnapshotToRecord);
  }

  async upsertSnapshot(
    id: ModelCatalogSnapshotId,
    write: ModelCatalogSnapshotWrite,
  ): Promise<void> {
    await ModelCatalogSnapshot.findOneAndUpdate(
      { _id: id },
      {
        data: write.data,
        fetchedAt: write.fetchedAt,
        itemCount: write.itemCount,
      },
      { upsert: true },
    );
  }

  async mutateSnapshot(
    id: ModelCatalogSnapshotId,
    mutate: (
      current: ModelCatalogSnapshotRecord | null,
    ) => ModelCatalogSnapshotWrite | null,
  ): Promise<boolean> {
    const next = mutate(await this.findSnapshot(id));
    if (!next) return false;
    await this.upsertSnapshot(id, next);
    return true;
  }
}

const POLICY_COLLECTION = "apps_box_policy";

export class MongoAppsBoxPolicyRepository implements AppsBoxPolicyRepository {
  private collection() {
    return mongoose.connection.collection<{ _id: string; since: Date }>(
      POLICY_COLLECTION,
    );
  }

  async ensureSince(id: string, now: Date): Promise<Date> {
    const col = this.collection();
    await col.updateOne(
      { _id: id },
      { $setOnInsert: { since: now } },
      { upsert: true },
    );
    const doc = await col.findOne({ _id: id });
    return doc?.since ?? now;
  }

  async readSince(id: string): Promise<Date | null> {
    const doc = await this.collection().findOne({ _id: id });
    return doc?.since ?? null;
  }
}
