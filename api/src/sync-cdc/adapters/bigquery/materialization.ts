import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  IFlow,
  WebhookEvent,
} from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import { resolveConfiguredEntities } from "../../entity-selection";
import { cdcLiveTableName, cdcStageTableName } from "../../table-names";
import { getCdcEventStore } from "../../stores";
import type { CdcStoredEvent } from "../../contracts/events";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../../normalization";
import { BIGQUERY_WORKING_DATASET } from "../../../utils/bigquery-working-dataset";
import { createDestinationWriter } from "../../../services/destination-writer.service";

const log = loggers.sync("bigquery-cdc");

async function stageChangeEventsToBigQuery(params: {
  flow: Pick<IFlow, "_id" | "tableDestination">;
  destinationDatabaseId: Types.ObjectId;
  destinationDatabaseName?: string;
  tableDestination: NonNullable<IFlow["tableDestination"]>;
  entity: string;
  events: CdcStoredEvent[];
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
    _mako_op: event.operation,
    _mako_source_ts: event.sourceTs,
    _mako_ingest_seq: event.ingestSeq,
    _mako_ingest_ts: event.ingestTs,
    _mako_source_kind: event.source,
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
  const eventStore = getCdcEventStore();
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

  const pending = await eventStore.listPendingEvents({
    flowId: params.flowId,
    entity: params.entity,
    limit: maxEvents,
  });

  if (pending.length === 0) {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }

  if (!isEntityEnabled) {
    await eventStore.markEventsDropped({
      eventIds: pending.map(event => event.id),
      errorCode: "ENTITY_DISABLED",
      errorMessage: `Entity ${params.entity} is disabled or not selected in flow configuration`,
    });

    const webhookEventIds = pending
      .map(event => event.webhookEventId)
      .filter((id): id is string => Boolean(id));
    if (webhookEventIds.length > 0) {
      await WebhookEvent.updateMany(
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
    const backlogCount = await eventStore.countEvents({
      flowId: params.flowId,
      entity: params.entity,
      materializationStatus: "pending",
    });
    await CdcEntityState.updateOne(
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

  await eventStore.markEventsStaged(pending.map(event => event.id));

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
      _mako_deleted_at: event.operation === "delete" ? new Date() : null,
      is_deleted: event.operation === "delete",
      deleted_at: event.operation === "delete" ? new Date() : null,
    };
  });

  const write = await writer.writeBatch(rows, {
    keyColumns: ["id", "_dataSourceId"],
    conflictStrategy: "update",
  });
  if (!write.success) {
    await eventStore.markEventsFailed({
      eventIds: pending.map(event => event.id),
      errorCode: "WRITE_FAILED",
      errorMessage: write.error || "Materialization write failed",
    });
    throw new Error(write.error || "Failed to materialize BigQuery CDC batch");
  }

  await eventStore.markEventsApplied(pending.map(event => event.id));

  const webhookEventIds = pending
    .map(event => event.webhookEventId)
    .filter((id): id is string => Boolean(id));
  if (webhookEventIds.length > 0) {
    await WebhookEvent.updateMany(
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
  const backlogCount = await eventStore.countEvents({
    flowId: params.flowId,
    entity: params.entity,
    materializationStatus: "pending",
  });

  await CdcEntityState.updateOne(
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
