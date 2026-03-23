import { Types } from "mongoose";
import { MaterializationRun } from "../database/workspace-schema";

export type DashboardMaterializationTriggerType =
  | "manual"
  | "schedule"
  | "dashboard_update";

export interface MaterializationRunEventRecord {
  type: string;
  timestamp: Date;
  message: string;
  metadata?: Record<string, unknown>;
}

export type MaterializationRunStatus =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "abandoned"
  | "cancelled";

export interface MaterializationRunRecord {
  runId: string;
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  triggerType: DashboardMaterializationTriggerType;
  status: MaterializationRunStatus;
  requestedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  lastHeartbeat?: Date;
  workerId?: string;
  stage?: string;
  attempt?: number;
  artifactKey?: string;
  version?: string;
  rowCount?: number;
  byteSize?: number;
  error?: string;
  events: MaterializationRunEventRecord[];
}

function toMaterializationRunRecord(run: any): MaterializationRunRecord {
  const plain = typeof run.toObject === "function" ? run.toObject() : run;
  return {
    runId: plain.runId,
    workspaceId: plain.workspaceId.toString(),
    dashboardId: plain.dashboardId.toString(),
    dataSourceId: plain.dataSourceId,
    triggerType: plain.triggerType,
    status: plain.status,
    requestedAt: new Date(plain.requestedAt),
    startedAt: plain.startedAt ? new Date(plain.startedAt) : undefined,
    finishedAt: plain.finishedAt ? new Date(plain.finishedAt) : undefined,
    lastHeartbeat: plain.lastHeartbeat
      ? new Date(plain.lastHeartbeat)
      : undefined,
    workerId: plain.workerId,
    stage: plain.stage,
    attempt: plain.attempt,
    artifactKey: plain.artifactKey,
    version: plain.version,
    rowCount: plain.rowCount,
    byteSize: plain.byteSize,
    error: plain.error,
    events: (plain.events || []).map((event: any) => ({
      type: event.type,
      timestamp: new Date(event.timestamp),
      message: event.message,
      metadata: event.metadata,
    })),
  };
}

export async function createMaterializationRun(input: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  runId: string;
  triggerType: DashboardMaterializationTriggerType;
  status: MaterializationRunStatus;
  requestedAt: Date;
  startedAt?: Date;
  workerId?: string;
  artifactKey?: string;
  version?: string;
  events?: MaterializationRunEventRecord[];
}): Promise<void> {
  await MaterializationRun.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    dashboardId: new Types.ObjectId(input.dashboardId),
    dataSourceId: input.dataSourceId,
    runId: input.runId,
    triggerType: input.triggerType,
    status: input.status,
    requestedAt: input.requestedAt,
    startedAt: input.startedAt,
    lastHeartbeat: new Date(),
    workerId: input.workerId,
    attempt: 1,
    artifactKey: input.artifactKey,
    version: input.version,
    events: input.events || [],
  });
}

export async function appendMaterializationRunEvent(input: {
  runId: string;
  event: MaterializationRunEventRecord;
}): Promise<void> {
  await MaterializationRun.updateOne(
    { runId: input.runId },
    {
      $push: {
        events: input.event,
      },
    },
  ).catch(() => undefined);
}

export async function finalizeMaterializationRun(input: {
  runId: string;
  status: MaterializationRunStatus;
  finishedAt?: Date;
  rowCount?: number;
  byteSize?: number;
  error?: string;
  artifactKey?: string;
  version?: string;
}): Promise<void> {
  await MaterializationRun.updateOne(
    { runId: input.runId },
    {
      $set: {
        status: input.status,
        finishedAt: input.finishedAt,
        lastHeartbeat: new Date(),
        rowCount: input.rowCount,
        byteSize: input.byteSize,
        error: input.error,
        artifactKey: input.artifactKey,
        version: input.version,
      },
    },
  ).catch(() => undefined);
}

export async function updateMaterializationRunHeartbeat(input: {
  runId: string;
  stage?: string;
}): Promise<void> {
  const update: Record<string, unknown> = { lastHeartbeat: new Date() };
  if (input.stage) {
    update.stage = input.stage;
  }
  await MaterializationRun.updateOne(
    { runId: input.runId },
    { $set: update },
  ).catch(() => undefined);
}

export async function markStaleRunsAbandoned(options: {
  heartbeatTimeoutMs?: number;
  queuedTimeoutMs?: number;
}): Promise<number> {
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? 2 * 60 * 1000;
  const queuedTimeout = options.queuedTimeoutMs ?? 5 * 60 * 1000;
  const now = new Date();
  const heartbeatCutoff = new Date(now.getTime() - heartbeatTimeout);
  const queuedCutoff = new Date(now.getTime() - queuedTimeout);

  const result = await MaterializationRun.updateMany(
    {
      $or: [
        {
          status: "building",
          $or: [
            { lastHeartbeat: { $lt: heartbeatCutoff } },
            {
              lastHeartbeat: { $exists: false },
              startedAt: { $lt: heartbeatCutoff },
            },
          ],
        },
        {
          status: "queued",
          requestedAt: { $lt: queuedCutoff },
        },
      ],
    },
    {
      $set: {
        status: "abandoned",
        finishedAt: now,
        error: "Worker lost heartbeat or run was abandoned",
      },
    },
  );

  return result.modifiedCount;
}

export async function trimMaterializationRuns(input: {
  dashboardId: string;
  dataSourceId: string;
  keep: number;
}): Promise<void> {
  const staleRuns = await MaterializationRun.find({
    dashboardId: new Types.ObjectId(input.dashboardId),
    dataSourceId: input.dataSourceId,
  })
    .sort({ requestedAt: -1 })
    .skip(input.keep)
    .select("_id");

  if (staleRuns.length === 0) {
    return;
  }

  await MaterializationRun.deleteMany({
    _id: { $in: staleRuns.map(run => run._id) },
  });
}

export async function listMaterializationRuns(input: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId?: string;
  limit?: number;
}): Promise<MaterializationRunRecord[]> {
  const query: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(input.workspaceId),
    dashboardId: new Types.ObjectId(input.dashboardId),
  };
  if (input.dataSourceId) {
    query.dataSourceId = input.dataSourceId;
  }

  const runs = await MaterializationRun.find(query)
    .sort({ requestedAt: -1 })
    .limit(input.limit ?? 100);

  return runs.map(toMaterializationRunRecord);
}

export async function getMaterializationRunByRunId(input: {
  workspaceId: string;
  dashboardId: string;
  runId: string;
}): Promise<MaterializationRunRecord | null> {
  const run = await MaterializationRun.findOne({
    workspaceId: new Types.ObjectId(input.workspaceId),
    dashboardId: new Types.ObjectId(input.dashboardId),
    runId: input.runId,
  });

  return run ? toMaterializationRunRecord(run) : null;
}
