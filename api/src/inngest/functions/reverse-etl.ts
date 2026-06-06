import { Types } from "mongoose";
import { inngest } from "../client";
import {
  DatabaseConnection,
  OutboundLedger,
  ReverseFlow,
  ReverseFlowRun,
  type IDatabaseConnection,
  type IReverseFlowRowOutcome,
} from "../../database/workspace-schema";
import {
  getNextScheduledConsoleRunAt,
  normalizeScheduledConsoleSchedule,
} from "../../services/scheduled-query-schedule.service";
import { emitReverseEtlTerminalEvent } from "../../services/flow-run-notification.emit";
import { getOutboundConnector } from "../../services/reverse-etl/outbound";
import {
  assertSchema,
  contentHash,
  mapRow,
} from "../../services/reverse-etl/mapping-engine";
import {
  readReverseEtlSourcePage,
  type ReverseEtlSourceState,
} from "../../services/reverse-etl/source-reader";
import type { ReverseFlowSpec } from "../../schemas/reverse-flow.schema";
import { loggers } from "../../logging";

const logger = loggers.inngest();

type Counters = {
  rowsRead: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
  ambiguous: number;
  rowOutcomes: IReverseFlowRowOutcome[];
};

function emptyCounters(): Counters {
  return {
    rowsRead: 0,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    ambiguous: 0,
    rowOutcomes: [],
  };
}

function mergeCounters(target: Counters, source: Counters): Counters {
  target.rowsRead += source.rowsRead;
  target.rowsCreated += source.rowsCreated;
  target.rowsUpdated += source.rowsUpdated;
  target.rowsSkipped += source.rowsSkipped;
  target.rowsFailed += source.rowsFailed;
  target.ambiguous += source.ambiguous;
  target.rowOutcomes.push(...source.rowOutcomes);
  target.rowOutcomes = target.rowOutcomes.slice(0, 500);
  return target;
}

export const reverseEtlSchedulerFunction = inngest.createFunction(
  {
    id: "reverse-etl-scheduler",
    name: "Run Reverse ETL Flows",
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const now = new Date();
    const dueFlows = await step.run("fetch-due-reverse-flows", async () => {
      const flows = await ReverseFlow.find({
        status: "active",
        "spec.schedule.enabled": true,
        "scheduledRun.nextAt": { $lte: now },
      })
        .select("_id workspaceId spec scheduledRun")
        .lean();

      return flows.map(flow => ({
        id: flow._id.toString(),
        workspaceId: flow.workspaceId.toString(),
        nextAt: flow.scheduledRun?.nextAt ?? null,
        schedule: flow.spec.schedule,
      }));
    });

    for (const flow of dueFlows) {
      if (!flow.schedule?.cron || !flow.schedule?.timezone) continue;
      const nextAt = getNextScheduledConsoleRunAt(
        normalizeScheduledConsoleSchedule(flow.schedule),
        now,
      );
      const updateResult = await step.run(`claim-${flow.id}`, async () =>
        ReverseFlow.updateOne(
          {
            _id: new Types.ObjectId(flow.id),
            "scheduledRun.nextAt": flow.nextAt,
          },
          { $set: { "scheduledRun.nextAt": nextAt } },
        ),
      );
      if (updateResult.modifiedCount === 0) continue;

      await inngest.send({
        name: "reverse_etl/execute",
        data: {
          workspaceId: flow.workspaceId,
          reverseFlowId: flow.id,
          triggerType: "schedule",
        },
      });
    }

    return { checked: dueFlows.length };
  },
);

export const reverseEtlExecutorFunction = inngest.createFunction(
  {
    id: "reverse-etl-executor",
    name: "Execute Reverse ETL Flow",
    retries: 3,
    concurrency: {
      key: "event.data.reverseFlowId",
      limit: 1,
    },
    cancelOn: [{ event: "reverse_etl/cancel", match: "data.reverseFlowId" }],
  },
  { event: "reverse_etl/execute" },
  async ({ event, step }) => {
    const workspaceId = String(event.data.workspaceId);
    const reverseFlowId = String(event.data.reverseFlowId);
    const triggerType =
      event.data.triggerType === "manual" ? "manual" : "schedule";
    const triggeredBy =
      typeof event.data.triggeredBy === "string"
        ? event.data.triggeredBy
        : undefined;

    const run = await step.run("create-run", async () => {
      const flow = await ReverseFlow.findOne({
        _id: new Types.ObjectId(reverseFlowId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();
      if (!flow) throw new Error("Reverse flow not found");

      const created = await ReverseFlowRun.create({
        workspaceId: new Types.ObjectId(workspaceId),
        reverseFlowId: new Types.ObjectId(reverseFlowId),
        specVersion: flow.version,
        status: "queued",
        triggerType,
        triggeredBy,
        triggeredAt: new Date(),
        inngestRunId: event.id,
      });
      return { id: created._id.toString() };
    });

    const startedAt = new Date();
    let isFinalized = false;
    await step.run("mark-running", async () => {
      await ReverseFlowRun.updateOne(
        { _id: new Types.ObjectId(run.id) },
        { $set: { status: "running", startedAt } },
      );
    });

    try {
      const loaded = (await step.run("load-spec", async () => {
        const flowDoc = await ReverseFlow.findOne({
          _id: new Types.ObjectId(reverseFlowId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!flowDoc || flowDoc.status !== "active") {
          throw new Error("Reverse flow is not active");
        }
        const connectionDoc = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(flowDoc.spec.source.connectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!connectionDoc) {
          throw new Error("Reverse flow source connection not found");
        }
        return {
          flow: flowDoc.toObject({ getters: true }),
          connection: connectionDoc.toObject({
            getters: true,
          }) as IDatabaseConnection,
        };
      })) as {
        flow: { spec: ReverseFlowSpec; version: number };
        connection: IDatabaseConnection;
      };

      const outboundConnector = await getOutboundConnector(
        loaded.flow.spec.destination.connectorId,
      );
      const outboundSchema = await outboundConnector.resolveOutboundSchema(
        loaded.flow.spec.destination.entity,
      );

      const counters = emptyCounters();
      let state: ReverseEtlSourceState = {
        offset: 0,
        totalProcessed: 0,
        hasMore: true,
        lastTrackingValue: loaded.flow.spec.incremental?.lastValue,
      };
      let pageIndex = 0;
      let maxTrackingValue: string | undefined;

      while (state.hasMore) {
        const pageResult = await step.run(`page-${pageIndex}`, async () => {
          const page = await readReverseEtlSourcePage({
            connection: loaded.connection,
            spec: loaded.flow.spec,
            state,
          });
          assertSchema(loaded.flow.spec, page.columns, outboundSchema);

          const pageCounters = emptyCounters();
          pageCounters.rowsRead = page.rows.length;
          const recordsToWrite: {
            sourcePk: string;
            payload: Record<string, unknown>;
            remoteId?: string;
            hash: string;
          }[] = [];

          for (const row of page.rows) {
            const sourcePk = String(
              row[loaded.flow.spec.source.primaryKey] ?? "",
            );
            if (!sourcePk) {
              pageCounters.rowsFailed++;
              pageCounters.rowOutcomes.push({
                sourcePk: "",
                status: "failed",
                error: "Missing source primary key",
              });
              continue;
            }

            const mapped = mapRow(loaded.flow.spec, row);
            if (mapped.errors.length > 0) {
              pageCounters.rowsFailed++;
              pageCounters.rowOutcomes.push({
                sourcePk,
                status: "failed",
                error: mapped.errors[0],
              });
              continue;
            }

            const hash = contentHash(mapped.payload);
            const ledger = await OutboundLedger.findOne({
              reverseFlowId: new Types.ObjectId(reverseFlowId),
              sourcePk,
            }).lean();
            if (ledger?.contentHash === hash) {
              pageCounters.rowsSkipped++;
              pageCounters.rowOutcomes.push({
                sourcePk,
                status: "skipped",
                remoteId: ledger.remoteId,
              });
              continue;
            }
            recordsToWrite.push({
              sourcePk,
              payload: mapped.payload,
              remoteId: ledger?.remoteId,
              hash,
            });
          }

          if (recordsToWrite.length > 0) {
            const write = await outboundConnector.writeBatch({
              entity: loaded.flow.spec.destination.entity,
              records: recordsToWrite.map(record => ({
                sourcePk: record.sourcePk,
                payload: record.payload,
                remoteId: record.remoteId,
              })),
              writeMode: loaded.flow.spec.destination.allowCreate
                ? loaded.flow.spec.destination.writeMode
                : "update",
              updateFieldStrategy:
                loaded.flow.spec.destination.updateFieldStrategy,
              match: loaded.flow.spec.destination.match,
              dryRun: false,
            });
            const hashByPk = new Map(
              recordsToWrite.map(record => [record.sourcePk, record.hash]),
            );
            for (const result of write.results) {
              if (result.status === "created") pageCounters.rowsCreated++;
              if (result.status === "updated") pageCounters.rowsUpdated++;
              if (result.status === "skipped") pageCounters.rowsSkipped++;
              if (result.status === "ambiguous") pageCounters.ambiguous++;
              if (result.status === "failed") pageCounters.rowsFailed++;

              pageCounters.rowOutcomes.push({
                sourcePk: result.sourcePk,
                status: result.status,
                remoteId: result.remoteId,
                error: result.error,
              });

              if (
                (result.status === "created" || result.status === "updated") &&
                result.remoteId
              ) {
                await OutboundLedger.updateOne(
                  {
                    reverseFlowId: new Types.ObjectId(reverseFlowId),
                    sourcePk: result.sourcePk,
                  },
                  {
                    $set: {
                      workspaceId: new Types.ObjectId(workspaceId),
                      reverseFlowId: new Types.ObjectId(reverseFlowId),
                      sourcePk: result.sourcePk,
                      remoteId: result.remoteId,
                      contentHash: hashByPk.get(result.sourcePk),
                      lastSyncedAt: new Date(),
                      lastRunId: new Types.ObjectId(run.id),
                    },
                  },
                  { upsert: true },
                );
              }

              if (result.status === "failed" && result.retryable) {
                throw new Error(
                  result.error || "Retryable Reverse ETL write failed",
                );
              }
            }
          }

          return {
            counters: pageCounters,
            state: page.state,
            maxTrackingValue: page.maxTrackingValue,
          };
        });

        mergeCounters(counters, pageResult.counters);
        state = pageResult.state;
        if (pageResult.maxTrackingValue) {
          maxTrackingValue = pageResult.maxTrackingValue;
        }
        pageIndex++;
      }

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const status =
        counters.rowsFailed > 0 || counters.ambiguous > 0
          ? "partial"
          : "success";

      await step.run("finalize-run", async () => {
        await ReverseFlowRun.updateOne(
          { _id: new Types.ObjectId(run.id) },
          {
            $set: {
              status,
              completedAt,
              durationMs,
              rowsRead: counters.rowsRead,
              rowsCreated: counters.rowsCreated,
              rowsUpdated: counters.rowsUpdated,
              rowsSkipped: counters.rowsSkipped,
              rowsFailed: counters.rowsFailed,
              ambiguous: counters.ambiguous,
              rowOutcomes: counters.rowOutcomes,
            },
          },
        );

        const schedule = loaded.flow.spec.schedule;
        const nextAt =
          schedule.enabled && schedule.cron
            ? getNextScheduledConsoleRunAt(
                normalizeScheduledConsoleSchedule(schedule),
                completedAt,
              )
            : undefined;

        await ReverseFlow.updateOne(
          { _id: new Types.ObjectId(reverseFlowId) },
          {
            $set: {
              "scheduledRun.lastAt": completedAt,
              "scheduledRun.lastStatus": status,
              "scheduledRun.lastError": undefined,
              "scheduledRun.consecutiveFailures": 0,
              ...(nextAt ? { "scheduledRun.nextAt": nextAt } : {}),
              ...(maxTrackingValue
                ? { "spec.incremental.lastValue": maxTrackingValue }
                : {}),
            },
            $inc: { "scheduledRun.runCount": 1 },
          },
        );
      });
      isFinalized = true;

      await step.run("emit-reverse-etl-terminal-notification", async () => {
        await emitReverseEtlTerminalEvent({
          workspaceId,
          reverseFlowId,
          runId: run.id,
          triggerType,
        });
      });

      return {
        runId: run.id,
        reverseFlowId,
        workspaceId,
        status,
        rowsRead: counters.rowsRead,
      };
    } catch (error) {
      logger.error("Reverse ETL execution failed", {
        workspaceId,
        reverseFlowId,
        error,
      });
      if (!isFinalized) {
        await step.run("finalize-run-error", async () => {
          const completedAt = new Date();
          const message =
            error instanceof Error ? error.message : "Reverse ETL failed";
          await ReverseFlowRun.updateOne(
            { _id: new Types.ObjectId(run.id) },
            {
              $set: {
                status: "error",
                completedAt,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                error: { message },
              },
            },
          );
          await ReverseFlow.updateOne(
            { _id: new Types.ObjectId(reverseFlowId) },
            {
              $set: {
                "scheduledRun.lastAt": completedAt,
                "scheduledRun.lastStatus": "error",
                "scheduledRun.lastError": message,
              },
              $inc: {
                "scheduledRun.runCount": 1,
                "scheduledRun.consecutiveFailures": 1,
              },
            },
          );
        });
      }
      await step.run(
        "emit-reverse-etl-terminal-notification-error",
        async () => {
          await emitReverseEtlTerminalEvent({
            workspaceId,
            reverseFlowId,
            runId: run.id,
            triggerType,
          });
        },
      );
      throw error;
    }
  },
);
