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

export interface MaterializationRunRecord {
  runId: string;
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  triggerType: DashboardMaterializationTriggerType;
  status: "building" | "ready" | "error";
  requestedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
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
  status: "building" | "ready" | "error";
  requestedAt: Date;
  startedAt?: Date;
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
  status: "building" | "ready" | "error";
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
        rowCount: input.rowCount,
        byteSize: input.byteSize,
        error: input.error,
        artifactKey: input.artifactKey,
        version: input.version,
      },
    },
  ).catch(() => undefined);
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
