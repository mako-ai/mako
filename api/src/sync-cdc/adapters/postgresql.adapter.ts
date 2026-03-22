import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  DatabaseConnection,
  Flow,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { createDestinationWriter } from "../../services/destination-writer.service";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../normalization";
import { resolveConfiguredEntities } from "../entity-selection";
import {
  CdcDestinationAdapter,
  CdcEntityLayout,
  CdcMaterializationResult,
  CdcMaterializationRun,
} from "../contracts/adapters";

interface PostgreSqlAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

const log = loggers.sync("cdc.postgresql-adapter");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PostgreSqlDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "postgresql";

  constructor(private readonly config: PostgreSqlAdapterConfig) {}

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    // Table creation is handled lazily by DestinationWriter on first write.
  }

  async materializeEntity(
    run: CdcMaterializationRun,
    _fencingToken: number,
  ): Promise<CdcMaterializationResult> {
    const maxEvents = Math.max(run.maxEvents || 5000, 100);
    const flow = await Flow.findById(run.flowId).lean();
    if (!flow?.tableDestination?.connectionId) {
      return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
    }

    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    ).lean();
    if (!destination) {
      return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
    }
    if (
      destination.type !== "postgresql" &&
      destination.type !== "cloudsql-postgres"
    ) {
      return {
        staged: 0,
        applied: 0,
        lastMaterializedSeq: 0,
        skipped: true,
        reason: "destination is not postgresql",
      };
    }

    const pending = await CdcChangeEvent.find({
      flowId: new Types.ObjectId(run.flowId),
      entity: run.entity,
      materializationStatus: "pending",
    })
      .sort({ ingestSeq: 1 })
      .limit(maxEvents)
      .lean();

    if (pending.length === 0) {
      return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
    }

    const { entities: configuredEntities, hasExplicitSelection } =
      resolveConfiguredEntities(flow);
    const isEntityEnabled =
      !hasExplicitSelection || configuredEntities.includes(run.entity);

    const flowObjectId = new Types.ObjectId(run.flowId);
    const workspaceObjectId = new Types.ObjectId(run.workspaceId);
    const lastMaterializedSeq = Number(
      pending[pending.length - 1]?.ingestSeq || 0,
    );

    if (!isEntityEnabled) {
      await CdcChangeEvent.updateMany(
        { _id: { $in: pending.map(event => event._id) } },
        {
          $set: {
            materializationStatus: "dropped",
            appliedAt: new Date(),
            materializationError: {
              code: "ENTITY_DISABLED",
              message: `Entity ${run.entity} is disabled or not selected in flow configuration`,
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
            flowId: flowObjectId,
            eventId: { $in: webhookEventIds },
          },
          {
            $set: {
              applyStatus: "applied",
              appliedAt: new Date(),
              status: "completed",
              applyError: {
                code: "ENTITY_DISABLED",
                message: `Entity ${run.entity} is disabled or not selected in flow configuration`,
              },
            },
          },
        );
      }

      const backlogCount = await CdcChangeEvent.countDocuments({
        flowId: flowObjectId,
        entity: run.entity,
        materializationStatus: "pending",
      });
      await CdcEntityState.updateOne(
        { flowId: flowObjectId, entity: run.entity },
        {
          $set: {
            workspaceId: workspaceObjectId,
            flowId: flowObjectId,
            entity: run.entity,
            lastMaterializedSeq,
            lastMaterializedAt: new Date(),
            backlogCount,
          },
        },
        { upsert: true },
      );

      return {
        staged: pending.length,
        applied: 0,
        lastMaterializedSeq,
      };
    }

    const latest = selectLatestChangePerRecord(pending);
    const writer = await this.createWriter(
      this.config.tableDestination.tableName,
    );
    (writer as any).config.deleteMode = flow.deleteMode;

    const fallbackDataSourceId = flow.dataSourceId
      ? String(flow.dataSourceId)
      : undefined;

    const upserts = latest.filter(change => change.op === "upsert");
    const deletes = latest.filter(change => change.op === "delete");

    try {
      if (upserts.length > 0) {
        const rows = upserts.map(event => {
          const payload = normalizePayloadKeys(event.payload || {});
          const sourceTs = resolveSourceTimestamp(
            payload,
            new Date(event.sourceTs),
          );
          const dataSourceId =
            payload._dataSourceId ?? fallbackDataSourceId ?? undefined;
          return {
            ...payload,
            id: event.recordId,
            _dataSourceId: dataSourceId,
            _mako_source_ts: sourceTs,
            _mako_ingest_seq: Number(event.ingestSeq),
            _mako_deleted_at: null,
            is_deleted: false,
            deleted_at: null,
          };
        });

        const result = await writer.writeBatch(rows, {
          keyColumns: ["id", "_dataSourceId"],
          conflictStrategy: "update",
        });
        if (!result.success) {
          throw new Error(result.error || "PostgreSQL CDC upsert failed");
        }
      }

      if (deletes.length > 0) {
        const deleteMode = flow.deleteMode || "hard";
        if (deleteMode === "soft") {
          const rows = deletes.map(event => {
            const payload = normalizePayloadKeys(event.payload || {});
            const sourceTs = resolveSourceTimestamp(
              payload,
              new Date(event.sourceTs),
            );
            const dataSourceId =
              payload._dataSourceId ?? fallbackDataSourceId ?? undefined;
            return {
              ...payload,
              id: event.recordId,
              _dataSourceId: dataSourceId,
              _mako_source_ts: sourceTs,
              _mako_ingest_seq: Number(event.ingestSeq),
              _mako_deleted_at: new Date(),
              is_deleted: true,
              deleted_at: new Date(),
            };
          });

          const result = await writer.writeBatch(rows, {
            keyColumns: ["id", "_dataSourceId"],
            conflictStrategy: "update",
          });
          if (!result.success) {
            throw new Error(
              result.error || "PostgreSQL CDC soft delete failed",
            );
          }
        } else {
          for (const event of deletes) {
            const payload = normalizePayloadKeys(event.payload || {});
            const dataSourceId =
              payload._dataSourceId ?? fallbackDataSourceId ?? undefined;
            const keyFilters: Record<string, unknown> = {
              id: event.recordId,
            };
            if (dataSourceId !== undefined) {
              keyFilters._dataSourceId = dataSourceId;
            }
            const result = await writer.deleteByKeys(keyFilters);
            if (!result.success) {
              throw new Error(
                result.error || "PostgreSQL CDC hard delete failed",
              );
            }
          }
        }
      }

      await CdcChangeEvent.updateMany(
        { _id: { $in: pending.map(event => event._id) } },
        {
          $set: {
            stageStatus: "staged",
            stagedAt: new Date(),
            materializationStatus: "applied",
            appliedAt: new Date(),
          },
          $inc: {
            stageAttemptCount: 1,
            materializationAttemptCount: 1,
          },
          $unset: {
            stageError: "",
            materializationError: "",
          },
        },
      );
    } catch (error) {
      await CdcChangeEvent.updateMany(
        { _id: { $in: pending.map(event => event._id) } },
        {
          $set: {
            stageStatus: "failed",
            materializationStatus: "failed",
            stageError: {
              code: "POSTGRES_CDC_WRITE_FAILED",
              message: toErrorMessage(error),
            },
            materializationError: {
              code: "POSTGRES_CDC_WRITE_FAILED",
              message: toErrorMessage(error),
            },
          },
          $inc: {
            stageAttemptCount: 1,
            materializationAttemptCount: 1,
          },
        },
      );
      throw error;
    }

    const webhookEventIds = pending
      .map(event => event.webhookEventId)
      .filter((id): id is string => Boolean(id));
    if (webhookEventIds.length > 0) {
      await (
        await import("../../database/workspace-schema")
      ).WebhookEvent.updateMany(
        {
          flowId: flowObjectId,
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

    const backlogCount = await CdcChangeEvent.countDocuments({
      flowId: flowObjectId,
      entity: run.entity,
      materializationStatus: "pending",
    });
    await CdcEntityState.updateOne(
      { flowId: flowObjectId, entity: run.entity },
      {
        $set: {
          workspaceId: workspaceObjectId,
          flowId: flowObjectId,
          entity: run.entity,
          lastMaterializedSeq,
          lastMaterializedAt: new Date(),
          backlogCount,
        },
      },
      { upsert: true },
    );

    log.info("PostgreSQL CDC materialization completed", {
      flowId: run.flowId,
      entity: run.entity,
      pending: pending.length,
      applied: latest.length,
      backlogCount,
      lastMaterializedSeq,
    });

    return {
      staged: pending.length,
      applied: latest.length,
      lastMaterializedSeq,
    };
  }

  private async createWriter(entityTableName: string) {
    return createDestinationWriter(
      {
        destinationDatabaseId: new Types.ObjectId(
          this.config.destinationDatabaseId,
        ),
        destinationDatabaseName: this.config.destinationDatabaseName,
        tableDestination: {
          connectionId: new Types.ObjectId(
            this.config.tableDestination.connectionId,
          ),
          schema: this.config.tableDestination.schema,
          tableName: entityTableName,
        },
      },
      "cdc-postgresql-adapter",
    );
  }
}
