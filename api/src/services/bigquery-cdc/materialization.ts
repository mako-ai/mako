import { Types } from "mongoose";
import {
  BigQueryCdcState,
  BigQueryChangeEvent,
  DatabaseConnection,
  Flow,
  IBigQueryChangeEvent,
  IFlow,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { resolveConfiguredEntities } from "../../sync-cdc/entity-selection";
import {
  cdcLiveTableName,
  cdcStageTableName,
} from "../../sync-cdc/table-names";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../../sync-cdc/normalization";
import { BIGQUERY_WORKING_DATASET } from "../../utils/bigquery-working-dataset";
import { createDestinationWriter } from "../destination-writer.service";

const log = loggers.sync("bigquery-cdc");

async function stageChangeEventsToBigQuery(params: {
  flow: Pick<IFlow, "_id" | "tableDestination">;
  destinationDatabaseId: Types.ObjectId;
  destinationDatabaseName?: string;
  tableDestination: NonNullable<IFlow["tableDestination"]>;
  entity: string;
  events: IBigQueryChangeEvent[];
}): Promise<void> {
  const stageTableName = cdcStageTableName(
    params.tableDestination.tableName,
    params.entity,
    String(params.flow._id),
  );

  const writer = await createDestinationWriter(
    {
      destinationDatabaseId: params.destinationDatabaseId,
      destinationDatabaseName: params.destinationDatabaseName,
      tableDestination: {
        ...params.tableDestination,
        connectionId: new Types.ObjectId(
          String(params.tableDestination.connectionId),
        ),
        schema: BIGQUERY_WORKING_DATASET,
        tableName: stageTableName,
      },
    },
    "bigquery-cdc",
  );

  const rows = params.events.map(event => ({
    ...(event.payload || {}),
    _mako_record_id: event.recordId,
    _mako_op: event.op,
    _mako_source_ts: event.sourceTs,
    _mako_ingest_seq: event.ingestSeq,
    _mako_ingest_ts: event.ingestTs,
    _mako_source_kind: event.sourceKind,
    _mako_run_id: event.runId || null,
    _mako_entity: event.entity,
    _mako_webhook_event_id: event.webhookEventId || null,
  }));

  const result = await writer.writeBatch(rows);
  if (!result.success) {
    throw new Error(result.error || "Failed to stage BigQuery CDC events");
  }
}

export async function materializeBigQueryEntity(params: {
  workspaceId: string;
  flowId: string;
  entity: string;
  maxEvents?: number;
}): Promise<{
  staged: number;
  applied: number;
  lastMaterializedSeq: number;
}> {
  const maxEvents = Math.max(params.maxEvents || 5000, 100);
  const flow = await Flow.findById(params.flowId).lean();
  if (!flow?.tableDestination?.connectionId) {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }
  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  ).lean();
  if (!destination || destination.type !== "bigquery") {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }

  const { entities: configuredEntities, hasExplicitSelection } =
    resolveConfiguredEntities(flow);
  const isEntityEnabled =
    !hasExplicitSelection || configuredEntities.includes(params.entity);

  const pending = await BigQueryChangeEvent.find({
    flowId: new Types.ObjectId(params.flowId),
    entity: params.entity,
    materializationStatus: "pending",
  })
    .sort({ ingestSeq: 1 })
    .limit(maxEvents)
    .lean();

  if (pending.length === 0) {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }

  if (!isEntityEnabled) {
    await BigQueryChangeEvent.updateMany(
      { _id: { $in: pending.map(event => event._id) } },
      {
        $set: {
          materializationStatus: "dropped",
          appliedAt: new Date(),
          materializationError: {
            code: "ENTITY_DISABLED",
            message: `Entity ${params.entity} is disabled or not selected in flow configuration`,
          },
        },
        $inc: { materializationAttemptCount: 1 },
      },
    );

    const webhookEventIds = pending
      .map(event => event.webhookEventId)
      .filter((id): id is string => Boolean(id));
    if (webhookEventIds.length > 0) {
      await (
        await import("../../database/workspace-schema")
      ).WebhookEvent.updateMany(
        {
          flowId: new Types.ObjectId(params.flowId),
          eventId: { $in: webhookEventIds },
        },
        {
          $set: {
            applyStatus: "applied",
            appliedAt: new Date(),
            status: "completed",
            applyError: {
              code: "ENTITY_DISABLED",
              message: `Entity ${params.entity} is disabled or not selected in flow configuration`,
            },
          },
        },
      );
    }

    const lastMaterializedSeq = Number(
      pending[pending.length - 1]?.ingestSeq || 0,
    );
    const backlogCount = await BigQueryChangeEvent.countDocuments({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
      materializationStatus: "pending",
    });
    await BigQueryCdcState.updateOne(
      { flowId: new Types.ObjectId(params.flowId), entity: params.entity },
      {
        $set: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
          lastMaterializedSeq,
          lastMaterializedAt: new Date(),
          backlogCount,
        },
      },
      { upsert: true },
    );

    log.warn("Discarded CDC events for disabled/unselected entity", {
      flowId: params.flowId,
      entity: params.entity,
      discarded: pending.length,
      backlogCount,
    });

    return {
      staged: pending.length,
      applied: 0,
      lastMaterializedSeq,
    };
  }

  await stageChangeEventsToBigQuery({
    flow,
    destinationDatabaseId: new Types.ObjectId(
      String(flow.destinationDatabaseId),
    ),
    destinationDatabaseName: flow.destinationDatabaseName,
    tableDestination: flow.tableDestination,
    entity: params.entity,
    events: pending,
  });

  await BigQueryChangeEvent.updateMany(
    { _id: { $in: pending.map(e => e._id) } },
    {
      $set: { stageStatus: "staged", stagedAt: new Date() },
      $inc: { stageAttemptCount: 1 },
      $unset: { stageError: "" },
    },
  );

  const latest = selectLatestChangePerRecord(pending);
  const entityTableName = cdcLiveTableName(
    flow.tableDestination.tableName,
    params.entity,
    String(flow._id),
  );
  const writer = await createDestinationWriter(
    {
      destinationDatabaseId: new Types.ObjectId(
        String(flow.destinationDatabaseId),
      ),
      destinationDatabaseName: flow.destinationDatabaseName,
      tableDestination: {
        ...flow.tableDestination,
        connectionId: new Types.ObjectId(
          String(flow.tableDestination.connectionId),
        ),
        schema: flow.tableDestination.schema || BIGQUERY_WORKING_DATASET,
        tableName: entityTableName,
      },
    },
    "bigquery-cdc",
  );

  const rows = latest.map(event => {
    const payload = normalizePayloadKeys(event.payload || {});
    const sourceTs = resolveSourceTimestamp(payload, new Date(event.sourceTs));
    return {
      ...payload,
      id: event.recordId,
      _mako_source_ts: sourceTs,
      _mako_ingest_seq: Number(event.ingestSeq),
      _mako_deleted_at: event.op === "delete" ? new Date() : null,
      is_deleted: event.op === "delete",
      deleted_at: event.op === "delete" ? new Date() : null,
    };
  });

  const write = await writer.writeBatch(rows, {
    keyColumns: ["id", "_dataSourceId"],
    conflictStrategy: "update",
  });
  if (!write.success) {
    await BigQueryChangeEvent.updateMany(
      { _id: { $in: pending.map(e => e._id) } },
      {
        $set: {
          materializationStatus: "failed",
          materializationError: {
            message: write.error || "Materialization write failed",
            code: "WRITE_FAILED",
          },
        },
        $inc: { materializationAttemptCount: 1 },
      },
    );
    throw new Error(write.error || "Failed to materialize BigQuery CDC batch");
  }

  await BigQueryChangeEvent.updateMany(
    { _id: { $in: pending.map(e => e._id) } },
    {
      $set: {
        materializationStatus: "applied",
        appliedAt: new Date(),
      },
      $inc: { materializationAttemptCount: 1 },
      $unset: { materializationError: "" },
    },
  );

  const webhookEventIds = pending
    .map(event => event.webhookEventId)
    .filter((id): id is string => Boolean(id));
  if (webhookEventIds.length > 0) {
    await (
      await import("../../database/workspace-schema")
    ).WebhookEvent.updateMany(
      {
        flowId: new Types.ObjectId(params.flowId),
        eventId: { $in: webhookEventIds },
      },
      {
        $set: {
          applyStatus: "applied",
          appliedAt: new Date(),
          status: "completed",
        },
        $unset: { applyError: "" },
      },
    );
  }

  const lastMaterializedSeq = Number(
    pending[pending.length - 1]?.ingestSeq || 0,
  );
  const backlogCount = await BigQueryChangeEvent.countDocuments({
    flowId: new Types.ObjectId(params.flowId),
    entity: params.entity,
    materializationStatus: "pending",
  });

  await BigQueryCdcState.updateOne(
    { flowId: new Types.ObjectId(params.flowId), entity: params.entity },
    {
      $set: {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
        lastMaterializedSeq,
        lastMaterializedAt: new Date(),
        backlogCount,
      },
    },
    { upsert: true },
  );

  return {
    staged: pending.length,
    applied: latest.length,
    lastMaterializedSeq,
  };
}
