import { inngest } from "../client";
import { Flow } from "../../database/workspace-schema";
import {
  performSyncChunk,
  performBulkFlush,
  performRescueAndPrepareStaging,
  performOverwriteTruncate,
  findRecordedRestBigQueryOverwrite,
  getTempCollectionCount,
  discardBulkBuffer,
  performStagingMerge,
  performStagingCleanup,
  SyncLogger,
} from "../../services/sync-executor.service";
import { FetchState } from "../../connectors/base/BaseConnector";
import { Types } from "mongoose";
import {
  backfillCheckpointScope,
  cdcBackfillCheckpointService,
} from "../../sync-cdc/sync-state";
import {
  appendExecutionLog,
  touchExecutionHeartbeat as touchHeartbeat,
  withHeartbeat,
} from "../../services/flow-execution-tracking";
import { resolveBackfillFetchForEntity } from "../../sync-cdc/backfill-fetch-resolver";
import {
  resolvePollCursorForEntity,
  stampPollRunStartedAt,
  type ResolvedPollCursor,
} from "../../sync-cdc/poll-cursor-resolver";
import {
  resolveCdcDestinationAdapter,
  hasStagingSupport,
  resolveEntityPartitioning,
  resolveEntityClustering,
} from "../../sync-cdc/adapters/registry";
import { withBoxMemoryWaits } from "./flow/box-memory-wait";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import {
  assertRestEntityAdmission,
  reserveRestEntityRun,
  settleRestEntityRun,
  type RestEntityOverwriteReservation,
} from "../../sync-cdc/rest-entity-admission";
import type { RestBigQueryOverwriteBatch } from "../../sync-cdc/bigquery-rest-overwrite-snapshot";
import {
  readVerifiedRestBigQueryOverwriteManifest,
  sealRestBigQueryOverwriteManifest,
  settleRestBigQueryOverwriteManifest,
} from "../../sync-cdc/bigquery-rest-overwrite-manifest";
import { readBigQueryRestOverwriteWrites } from "../../sync-cdc/bigquery-staged-intent";

/**
 * Max steps to use before yielding back to the parent for re-invocation.
 * Leaves headroom below the hard 1000-step Inngest limit.
 */
const STEP_BUDGET = 900;

/** Rows in the flush buffer that trigger a mid-entity flush. */
const FLUSH_THRESHOLD_ROWS = 10_000;

/** Rows this run wrote to the destination, carried in the fetch state. */
function rowsWrittenIn(state: FetchState | undefined): number {
  const raw = (state?.metadata as Record<string, unknown> | undefined)
    ?.rowsWrittenTotal;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function withRowsWritten(state: FetchState, rows: number): FetchState {
  return {
    ...state,
    metadata: {
      ...((state.metadata as Record<string, unknown> | undefined) ?? {}),
      rowsWrittenTotal: rows,
    },
  };
}

export interface SyncBackfillEntityPayload {
  flowId: string;
  entity: string;
  executionId?: string;
  dataSourceId: string;
  workspaceId: string;
  backfill?: boolean;
  backfillRunId?: string;
  checkpointEnabled: boolean;
  cdcBackfillRunId?: string;
  destinationId: string;
  destinationDatabaseName?: string;
  syncMode: string;
  writeMode?: "append_dedup" | "append" | "overwrite";
  syncEngine?: string;
  tableDestination: Record<string, unknown>;
  deleteMode?: string;
  entityLayouts?: Record<string, unknown>[];
  isCdcEnabled: boolean;
  destinationType: string;
  queries?: unknown[];
  /**
   * Fetch state of a run that yielded at the step budget without a backfill
   * checkpoint (a poll). The continuation resumes from it instead of
   * re-reading the entity from the start.
   */
  resumeState?: FetchState;
}

export interface SyncBackfillEntityResult {
  completed: boolean;
  rowsWritten: number;
  /** Set when the entity yielded without a checkpoint: pass it back as resumeState. */
  state?: FetchState;
}

export const syncBackfillEntityFunction = inngest.createFunction(
  {
    id: "sync-backfill-entity",
    name: "Sync Backfill Entity",
    concurrency: {
      limit: 1,
      key: "event.data.flowId",
    },
    retries: 3,
    cancelOn: [
      {
        event: "flow.cancel",
        if: "async.data.flowId == event.data.flowId",
      },
    ],
    triggers: { event: "flow/sync-backfill-entity" },
  },
  async ({ event, step, logger }): Promise<SyncBackfillEntityResult> => {
    const data = event.data as SyncBackfillEntityPayload;
    const {
      flowId,
      entity,
      executionId,
      dataSourceId,
      workspaceId,
      backfill,
      checkpointEnabled,
      cdcBackfillRunId,
      destinationId,
      destinationDatabaseName,
      syncMode,
      writeMode,
      syncEngine,
      tableDestination,
      deleteMode,
      entityLayouts,
      isCdcEnabled,
      destinationType,
      queries,
      resumeState,
    } = data;

    // Keep disabled until destination receipts can settle overwrite reservations
    // and the cutover can drain already-admitted work.
    const durableRunId = cdcBackfillRunId || executionId;
    const restAdmissionFor = (runId: string | undefined) => ({
      scope: {
        workspaceId: new Types.ObjectId(workspaceId),
        flowId: new Types.ObjectId(flowId),
        sourceConnectionId: new Types.ObjectId(dataSourceId),
      },
      runId,
    });
    const restEntityAdmission =
      process.env.REST_ENTITY_ADMISSION_ENABLED === "1"
        ? restAdmissionFor(durableRunId || event.id)
        : undefined;
    const safeEntityStepId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
    let stepsUsed = 0;
    // Backfills and scheduled resyncs read the source in full; polls do not.
    // The two run in separate buffer and staging lanes (bulkBufferName).
    const fullRead = Boolean(backfill);

    // When checkpointEnabled is true, cdcBackfillRunId is guaranteed
    // by the caller. Narrow to a non-optional string so downstream
    // step closures don't need non-null assertions.
    // The checkpoint belongs to this backfill run and this destination: a
    // new backfill, or the flow repointed elsewhere, starts fresh.
    let checkpointScope = "";
    if (checkpointEnabled) {
      if (!cdcBackfillRunId) {
        throw new Error(
          "cdcBackfillRunId is required when checkpointEnabled is true",
        );
      }
      checkpointScope = backfillCheckpointScope({
        runId: cdcBackfillRunId,
        destinationId,
        tableDestination,
      });
    }

    const logExec = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      metadata?: Record<string, unknown>,
    ) =>
      void appendExecutionLog({
        executionId,
        flowId,
        level,
        message,
        metadata,
      });

    // ── Mark entity started ──────────────────────────────────────────
    if (executionId) {
      await step.run(`mark-entity-started-${safeEntityStepId}`, async () => {
        const db = Flow.db;
        await db
          .collection("flow_executions")
          .updateOne({ _id: new Types.ObjectId(executionId) }, {
            $set: {
              lastHeartbeat: new Date(),
              "stats.currentEntity": entity,
              [`stats.entityStatus.${entity}`]: "syncing",
              [`stats.entityStats.${entity}`]: 0,
            },
            $push: {
              logs: {
                $each: [
                  {
                    timestamp: new Date(),
                    level: "info",
                    message: `Starting sync for ${entity}`,
                    metadata: { flowId, executionId, entity },
                  },
                ],
                $slice: -200,
              },
            },
          } as any);
      });
      stepsUsed++;
    }

    // ── Load checkpoint ──────────────────────────────────────────────
    let state: FetchState | undefined;
    if (checkpointEnabled) {
      const checkpointState = (await step.run(
        `load-cdc-backfill-checkpoint-${safeEntityStepId}`,
        async () => {
          return cdcBackfillCheckpointService.loadEntityCheckpoint({
            workspaceId,
            flowId,
            scope: checkpointScope,
            entity,
          });
        },
      )) as FetchState | undefined;
      stepsUsed++;
      if (checkpointState) {
        state = checkpointState;
        logger.info("Resuming entity from checkpoint", {
          flowId,
          entity,
          totalProcessed: checkpointState.totalProcessed,
        });
      }
    }

    // A poll that yielded at the step budget resumes where it stopped.
    // Without this, every continuation re-read the entity from its first
    // page: with a stable poll cursor that is the same large read up to 100
    // times.
    if (!checkpointEnabled && !state && resumeState) {
      state = resumeState;
      logger.info("Resuming entity from the previous invocation's state", {
        flowId,
        entity,
        totalProcessed: resumeState.totalProcessed,
      });
    }

    // ── Resolve fetch scope (full vs incremental scheduled resync) ───
    // Decided once per entity and run from values that are stable for the
    // whole run, so a continuation invocation re-derives the same answer.
    // null = connector not covered: historical behaviour, untouched.
    let backfillFetch: Awaited<
      ReturnType<typeof resolveBackfillFetchForEntity>
    > = null;
    if (checkpointEnabled) {
      backfillFetch = (await step.run(
        `resolve-backfill-fetch-${safeEntityStepId}`,
        async () => {
          const decision = await resolveBackfillFetchForEntity({
            flowId,
            dataSourceId,
            workspaceId,
            entity,
          });
          if (decision && !state) {
            logExec(
              "info",
              decision.mode === "incremental"
                ? `${entity}: incremental resync — ${decision.reason}`
                : `${entity}: full fetch — ${decision.reason}`,
              { entity, fetchMode: decision.mode },
            );
          }
          return decision;
        },
      )) as Awaited<ReturnType<typeof resolveBackfillFetchForEntity>>;
      stepsUsed++;
    }

    // ── Resolve the poll cursor (scheduled incremental poll) ─────────
    // The poll's own anchor: the start of the last completed poll/backfill
    // run of this entity, minus an overlap. Webhook writes cannot move it.
    // See sync-cdc/poll-cursor.ts.
    const isIncrementalPoll =
      !backfill &&
      !checkpointEnabled &&
      isCdcEnabled &&
      syncMode === "incremental" &&
      writeMode !== "overwrite";
    let pollCursor: ResolvedPollCursor | undefined;
    if (isIncrementalPoll) {
      pollCursor = (await step.run(
        `resolve-poll-cursor-${safeEntityStepId}`,
        async () => {
          const resolved = await resolvePollCursorForEntity({
            flowId,
            entity,
            executionId,
          });
          logExec("info", `${entity}: incremental poll — ${resolved.reason}`, {
            entity,
            pollSince: resolved.since,
          });
          return resolved;
        },
      )) as ResolvedPollCursor;
      stepsUsed++;
    }

    const trackedAdmission =
      writeMode === "overwrite" ? undefined : restEntityAdmission;
    const restRun = trackedAdmission
      ? await step.run(
          `reserve-rest-entity-run-${safeEntityStepId}`,
          async () => {
            const source = await sourceConnectionManager.getSourceConnection(
              dataSourceId,
              workspaceId,
            );
            if (!source) {
              throw new Error(`Data source not found: ${dataSourceId}`);
            }
            if (source.type !== "rest") return null;
            if (!source.active) {
              throw new Error(`Data source '${source.name}' is not active`);
            }
            if (!durableRunId) {
              throw new Error("REST admission requires a durable run ID");
            }
            const run = { runId: durableRunId, entity };
            await reserveRestEntityRun(Flow.db, trackedAdmission.scope, run);
            return run;
          },
        )
      : null;
    if (trackedAdmission) stepsUsed++;

    // ── Resolve bulk path options ────────────────────────────────────
    const cdcAdapter =
      isCdcEnabled && destinationType && (tableDestination as any)?.connectionId
        ? resolveCdcDestinationAdapter({
            destinationType,
            flowId: String(flowId),
            workspaceId,
            destinationDatabaseId: destinationId,
            destinationDatabaseName,
            tableDestination: {
              connectionId: String((tableDestination as any).connectionId),
              schema: (tableDestination as any).schema || "public",
              tableName: (tableDestination as any).tableName || "",
            },
          })
        : undefined;
    const useBulkPath = isCdcEnabled && hasStagingSupport(cdcAdapter);
    let flushIndex = 0;
    let bulkSyncOptions: Record<string, unknown> | undefined;
    let restOverwrite: RestEntityOverwriteReservation | undefined;
    let restoredRows: number | undefined;

    if (useBulkPath) {
      const isBigQueryOverwrite =
        cdcAdapter.destinationType === "bigquery" && writeMode === "overwrite";
      const continuationAdmission =
        isBigQueryOverwrite && durableRunId
          ? (restEntityAdmission ?? restAdmissionFor(durableRunId))
          : undefined;
      const bulkEntityLayout = (entityLayouts || []).find(
        (l: any) => l.entity === entity || l.entity === entity.split(":")[0],
      );

      const bulkLogger: SyncLogger = {
        log: (level: string, message: string, metadata?: any) => {
          const logData = { flowId, entity, executionId, ...metadata };
          switch (level) {
            case "info":
              logger.info(message, logData);
              logExec("info", message, logData);
              break;
            case "warn":
              logger.warn(message, logData);
              logExec("warn", message, logData);
              break;
            case "error":
              logger.error(message, logData);
              logExec("error", message, logData);
              break;
            default:
              logger.debug(message, logData);
              break;
          }
        },
      };

      bulkSyncOptions = {
        dataSourceId,
        destinationId,
        destinationDatabaseName,
        flowId,
        workspaceId,
        syncEngine,
        entity,
        isIncremental: syncMode === "incremental",
        fullRead,
        tableDestination,
        deleteMode,
        writeMode,
        // A flow's queries name its entities (GraphQL): the flush and the
        // merge resolve the schema from a connector that must see them too.
        queries,
        entityPartitioning: resolveEntityPartitioning(
          bulkEntityLayout as any,
          (tableDestination as any)?.partitioning,
        ),
        entityClustering: resolveEntityClustering(
          bulkEntityLayout as any,
          (tableDestination as any)?.clustering,
        ),
        logger: bulkLogger,
      };

      const prepareStepId = `prepare-staging-${safeEntityStepId}`;
      const prepared = await step.run(prepareStepId, () =>
        withHeartbeat(executionId, async () => {
          let admission: typeof restEntityAdmission;
          if (restEntityAdmission || continuationAdmission) {
            const source = await sourceConnectionManager.getSourceConnection(
              dataSourceId,
              workspaceId,
            );
            if (!source) {
              throw new Error(`Data source not found: ${dataSourceId}`);
            }
            if (
              trackedAdmission &&
              (source.type === "rest") !== Boolean(restRun)
            ) {
              throw new Error("REST source type changed during entity sync");
            }
            admission =
              source.type === "rest" ? restEntityAdmission : undefined;
            if (continuationAdmission) {
              const recorded = await findRecordedRestBigQueryOverwrite({
                ...bulkSyncOptions,
                restEntityAdmission: continuationAdmission,
              } as any);
              if (recorded) {
                const manifest =
                  await readVerifiedRestBigQueryOverwriteManifest(
                    Flow.db,
                    recorded,
                  );
                if (manifest) {
                  return {
                    overwrite: recorded.overwrite,
                    sealedRows: manifest.sourceRows,
                  };
                }
                if (source.type !== "rest") {
                  throw new Error("REST source type changed during overwrite");
                }
                admission = continuationAdmission;
              }
            }
            if (admission) {
              await assertRestEntityAdmission(Flow.db, admission, entity);
            }
          }

          const retainedOverwrite = Boolean(admission && isBigQueryOverwrite);
          if (retainedOverwrite && !durableRunId) {
            throw new Error(
              "BigQuery REST overwrite requires a durable run ID",
            );
          }

          const truncateOptions = {
            ...bulkSyncOptions,
            restEntityAdmission: admission,
          } as any;
          const prepareStaging = async () => {
            // Rescue keyed rows from an earlier invocation before dropping
            // staging. Append and overwrite re-fetch those rows from the last
            // flushed position, so rescuing them would write them twice.
            const { rescued } = await performRescueAndPrepareStaging(
              bulkSyncOptions as any,
              { dedupOnly: true },
            );
            if (rescued > 0) {
              logExec(
                "info",
                `Rescued ${rescued} orphaned staging rows into live table before fresh start`,
                { entity, rescued },
              );
            }

            // Checkpoints only advance with an empty buffer. Re-fetch any
            // rows still buffered from the last flushed position.
            const discarded = await discardBulkBuffer(flowId, entity, fullRead);
            if (discarded > 0) {
              logExec(
                "info",
                `Discarded ${discarded} unflushed ${entity} buffer rows; they are fetched again from the last flushed position`,
                { entity, discarded },
              );
            }
          };

          // Overwrite mode: clear the live table exactly once, here, before
          // any flush of this run writes. Do NOT call this from the
          // flush-merge/flush-final steps below — they re-run
          // performPrepareStaging per flush cycle, and re-truncating there
          // would wipe rows already written by earlier flushes (bug B1, see
          // docs/sync-modes-hardening-plan.md). A resumed invocation (state
          // carried over from a checkpoint or the previous invocation)
          // already truncated in its first invocation.
          if (retainedOverwrite) {
            const reservation = await performOverwriteTruncate(
              truncateOptions,
              {
                resume: Boolean(state),
                prepareStaging,
              },
            );
            if (!reservation) {
              throw new Error("BigQuery REST overwrite reservation is missing");
            }
            return { overwrite: reservation.overwrite };
          }
          await prepareStaging();
          if (!state) await performOverwriteTruncate(truncateOptions);
        }),
      );
      if (continuationAdmission && prepared) {
        restOverwrite = {
          scope: continuationAdmission.scope,
          overwrite: prepared.overwrite,
        };
        bulkSyncOptions.restOverwriteReservation = restOverwrite;
        if ("sealedRows" in prepared) {
          const sealedRows = prepared.sealedRows;
          restoredRows = sealedRows;
          state = withRowsWritten(
            {
              ...state,
              totalProcessed: sealedRows,
              hasMore: false,
              iterationsInChunk: 0,
            },
            sealedRows,
          );
        }
      }
      stepsUsed++;
    }

    // ── Chunk loop ───────────────────────────────────────────────────
    let chunkIndex = 0;
    let completed = restoredRows !== undefined;
    let totalWrittenForEntity = rowsWrittenIn(state);
    // The last state whose fetched rows are all in the destination: where a
    // resume may start. The buffer is empty here (discarded at start).
    let resumePoint: FetchState | undefined = state;

    const retainedBatch = (
      bufferRows: number,
    ): RestBigQueryOverwriteBatch | undefined => {
      if (!restOverwrite) return;
      const sourceRowsBefore = resumePoint?.totalProcessed ?? 0;
      const sourceRowsAfter = state?.totalProcessed ?? 0;
      if (
        !Number.isSafeInteger(sourceRowsBefore) ||
        sourceRowsBefore < 0 ||
        !Number.isSafeInteger(sourceRowsAfter) ||
        sourceRowsAfter - sourceRowsBefore !== bufferRows
      ) {
        throw new Error(
          "BigQuery REST overwrite buffer does not match the source range",
        );
      }
      if (bufferRows === 0) return;
      return {
        reservation: restOverwrite,
        sourceRowsBefore,
        expectedRows: bufferRows,
      };
    };

    // Save the resume cursor. Only call it when every row before `state`
    // reached the destination: the bulk path flushes its buffer first.
    const saveCheckpoint = async (stepId: string) => {
      if (!checkpointEnabled || !state) return;
      const checkpointState = state;
      await step.run(stepId, async () => {
        await cdcBackfillCheckpointService.saveEntityCheckpoint({
          workspaceId,
          flowId,
          scope: checkpointScope,
          entity,
          fetchState: checkpointState,
        });
      });
      stepsUsed++;
    };

    // A flush or merge step resolves the entity's schema in the connector
    // box. When the box's memory gate refuses it, the step sleeps and runs
    // again, as a chunk does. On 19 Nov 2026 a refused schema resolution
    // failed a 16-hour backfill. Each wait costs 2 steps.
    const boxStep = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      const { result, waits } = await withBoxMemoryWaits(step, id, fn, {
        onWait: (wait, refusal) => {
          logger.warn("Connector box low on memory; step waits", {
            flowId,
            entity,
            stepId: id,
            wait,
            availableMb: refusal.availableMb,
            retryInMs: refusal.retryInMs,
          });
          logExec("warn", refusal.message, {
            flowId,
            entity,
            executionId,
            wait,
          });
        },
      });
      stepsUsed += 2 * waits;
      return result;
    };

    // Flush the bulk buffer to the live table when it holds at least
    // `minRows`, then record the merged rows in `state` and save the cursor.
    // Returns true when the buffer is empty afterwards: only then does the
    // saved cursor cover every fetched row.
    const flushBuffer = async (
      label: string,
      minRows: number,
    ): Promise<boolean> => {
      if (!useBulkPath || !bulkSyncOptions) return true;
      const tempCount = await step.run(
        `count-temp-${safeEntityStepId}-${label}`,
        () =>
          withHeartbeat(executionId, async () => {
            const count = await getTempCollectionCount(
              flowId,
              entity,
              fullRead,
            );
            logger.info("Temp collection row count", {
              flowId,
              entity,
              tempCount: count,
              chunkIndex,
            });
            return count;
          }),
      );
      stepsUsed++;
      const restBigQueryOverwrite = retainedBatch(tempCount);
      if (tempCount === 0) {
        resumePoint = state;
        return true;
      }
      if (tempCount < minRows) return false;

      const rescuedInFlush = await boxStep(
        `flush-merge-${safeEntityStepId}-${flushIndex}`,
        () =>
          withHeartbeat(executionId, async () => {
            logExec(
              "info",
              `Flushing ${entity} buffer batch ${flushIndex} to live (${tempCount} rows in temp)`,
              { entity, flushIndex, tempCount },
            );
            // Retry-safe: a failed attempt may have loaded batches into
            // staging. Dropping staging puts them back in the flush buffer
            // (BULK_STAGED_FIELD); keyed (dedup) merges also merge them
            // first — see performRescueAndPrepareStaging.
            const { rescued } = await performRescueAndPrepareStaging(
              bulkSyncOptions as any,
              { dedupOnly: true },
            );
            if (rescued > 0) {
              logExec(
                "warn",
                `Rescued ${rescued} ${entity} staging rows left by a failed flush attempt`,
                { entity, flushIndex, rescued },
              );
            }
            await performBulkFlush(bulkSyncOptions as any, () =>
              touchHeartbeat(executionId),
            );
            return rescued;
          }),
      );
      stepsUsed++;
      // The merge is its own step, like merge-final: a retry of a failed
      // merge re-runs it against the staging table that is still there,
      // instead of re-entering the flush step, which drops staging.
      //
      // The cursor is saved in this same step, right after the merge: a
      // cancel between two steps would otherwise merge the rows and resume
      // before them, writing them twice in append mode. It is saved only
      // when the buffer is empty: a flush that stopped early leaves rows
      // there, and a cursor past them would skip them on a resume.
      const writtenBefore =
        totalWrittenForEntity + (Number(rescuedInFlush) || 0);
      const flushedState = state;
      const applied = (await boxStep(
        `flush-apply-${safeEntityStepId}-${flushIndex}`,
        () =>
          withHeartbeat(executionId, async () => {
            const result = await performStagingMerge(bulkSyncOptions as any, {
              mergePath: "flush",
              restBigQueryOverwrite,
            });
            await performStagingCleanup(bulkSyncOptions as any);
            const left = await getTempCollectionCount(flowId, entity, fullRead);
            if (restBigQueryOverwrite && left > 0) {
              throw new Error(
                "BigQuery REST overwrite left buffered source rows",
              );
            }
            const written = writtenBefore + result.written;
            if (left > 0) {
              logExec(
                "warn",
                `${entity}: ${left} rows stayed in the flush buffer; the resume cursor stays at the last complete flush`,
                { entity, flushIndex, left },
              );
            } else if (checkpointEnabled && flushedState) {
              await cdcBackfillCheckpointService.saveEntityCheckpoint({
                workspaceId,
                flowId,
                scope: checkpointScope,
                entity,
                fetchState: withRowsWritten(flushedState, written),
              });
            }
            return { written, left };
          }),
      )) as { written?: unknown; left?: unknown } | null;
      stepsUsed++;
      flushIndex++;

      // A step memoized by an earlier deploy returned nothing (null): it
      // merged, but saved no cursor and counted nothing. Keep the count and
      // the resume point as they were; the next complete flush saves.
      const written = Number(applied?.written);
      const left = Number(applied?.left);
      if (!Number.isFinite(written) || !Number.isFinite(left)) return false;
      totalWrittenForEntity = written;
      if (state) state = withRowsWritten(state, totalWrittenForEntity);
      if (left > 0) return false;
      resumePoint = state;
      return true;
    };

    while (!completed) {
      if (stepsUsed >= STEP_BUDGET) {
        // Flush before yielding: the next invocation resumes from the saved
        // cursor (or the returned state) and finds an empty buffer.
        const bufferEmpty = await flushBuffer("yield", 1);
        // Direct writes: save here. The bulk path saved in its flush; a
        // buffer still holding rows keeps the last complete flush's cursor.
        if (!useBulkPath) {
          await saveCheckpoint(
            `save-checkpoint-before-yield-${safeEntityStepId}`,
          );
        } else if (!bufferEmpty) {
          logger.warn("Yielding with rows left in the flush buffer", {
            flowId,
            entity,
          });
        }
        logger.info(
          `Entity ${entity} yielding to parent after ${stepsUsed} steps (chunk ${chunkIndex})`,
          { flowId, entity, stepsUsed, chunkIndex },
        );
        // A poll resumes from the state it returns: hand back the last
        // fully written one, never a state past rows still buffered.
        const yieldState = useBulkPath ? resumePoint : state;
        return {
          completed: false,
          rowsWritten: totalWrittenForEntity,
          ...(!checkpointEnabled && yieldState ? { state: yieldState } : {}),
        };
      }

      // A box memory gate that refuses the chunk (too many runs in the
      // connector box) sleeps and retries it, without failing the run.
      const { result: chunkResult, waits: memoryWaits } =
        await withBoxMemoryWaits(
          step,
          `sync-${entity}-chunk-${chunkIndex}`,
          // Up to 10 connector pages fetched and written in one step.
          () =>
            withHeartbeat(executionId, async () => {
              logger.info("Executing chunk", { flowId, entity, chunkIndex });

              const syncLogger: SyncLogger = {
                log: (level: string, message: string, metadata?: any) => {
                  const logData = {
                    flowId,
                    entity,
                    chunkIndex,
                    executionId,
                    ...metadata,
                  };
                  switch (level) {
                    case "debug":
                      logger.debug(message, logData);
                      logExec("debug", message, logData);
                      break;
                    case "info":
                      logger.info(message, logData);
                      logExec("info", message, logData);
                      break;
                    case "warn":
                      logger.warn(message, logData);
                      logExec("warn", message, logData);
                      break;
                    case "error":
                      logger.error(message, logData);
                      logExec("error", message, logData);
                      break;
                    default:
                      logger.info(message, logData);
                      logExec("info", message, logData);
                      break;
                  }
                },
              };

              let resolvedTableDest: Record<string, unknown> =
                tableDestination as Record<string, unknown>;
              if (tableDestination && entityLayouts) {
                const entityLayout = (entityLayouts || []).find(
                  (l: any) =>
                    l.entity === entity || l.entity === entity.split(":")[0],
                );
                if (entityLayout) {
                  const p = resolveEntityPartitioning(
                    entityLayout as any,
                    (tableDestination as any)?.partitioning,
                  );
                  const c = resolveEntityClustering(
                    entityLayout as any,
                    (tableDestination as any)?.clustering,
                  );
                  resolvedTableDest = {
                    ...tableDestination,
                    partitioning: p ? { enabled: true, ...p } : undefined,
                    clustering: c ? { enabled: true, ...c } : undefined,
                  };
                }
              }

              const chunkEntityLayout = (entityLayouts || []).find(
                (l: any) =>
                  l.entity === entity || l.entity === entity.split(":")[0],
              );
              const result = await performSyncChunk({
                dataSourceId,
                destinationId,
                destinationDatabaseName,
                flowId,
                workspaceId,
                restEntityAdmission: restOverwrite
                  ? {
                      scope: restOverwrite.scope,
                      runId: restOverwrite.overwrite.runId,
                    }
                  : restEntityAdmission,
                restBigQueryOverwritePrepared: Boolean(restOverwrite),
                restRunTracked: trackedAdmission ? Boolean(restRun) : undefined,
                syncEngine,
                backfillRunId: backfill
                  ? cdcBackfillRunId || executionId
                  : undefined,
                entity,
                isIncremental: syncMode === "incremental",
                ...(backfillFetch
                  ? {
                      backfillFetch:
                        backfillFetch.mode === "incremental"
                          ? { mode: "incremental", since: backfillFetch.since }
                          : { mode: "full" },
                    }
                  : {}),
                ...(pollCursor
                  ? {
                      pollCursor: {
                        since: pollCursor.since,
                        overlapMs: pollCursor.overlapMs,
                      },
                    }
                  : {}),
                state,
                fullRead,
                maxIterations: 10,
                logger: syncLogger,
                step,
                queries,
                tableDestination: resolvedTableDest,
                deleteMode,
                writeMode,
                // Layout hints flow to the CDC adapter so every destination can
                // apply its native physical layout (indexes / partitioning).
                entityPartitioning: resolveEntityPartitioning(
                  chunkEntityLayout as any,
                  (tableDestination as any)?.partitioning,
                ),
                entityClustering: resolveEntityClustering(
                  chunkEntityLayout as any,
                  (tableDestination as any)?.clustering,
                ),
              } as any);

              const written = Number.isFinite(result.totalWritten)
                ? result.totalWritten
                : result.state.totalProcessed;
              const fetched = Number.isFinite(result.totalFetched)
                ? result.totalFetched
                : result.state.totalProcessed;

              if (executionId) {
                try {
                  await Flow.db
                    .collection("flow_executions")
                    .updateOne({ _id: new Types.ObjectId(executionId) }, {
                      $set: {
                        lastHeartbeat: new Date(),
                        "stats.currentEntity": entity,
                        [`stats.entityStatus.${entity}`]:
                          result.completed && !useBulkPath
                            ? "completed"
                            : "syncing",
                        [`stats.entityStats.${entity}`]: written,
                      },
                      ...(result.completed && !useBulkPath
                        ? { $addToSet: { "stats.syncedEntities": entity } }
                        : {}),
                      $push: {
                        logs: {
                          $each: [
                            {
                              timestamp: new Date(),
                              level: "info",
                              message:
                                result.completed && useBulkPath
                                  ? `${entity} fetch completed (${fetched} fetched, ${written} written so far); flushing the rest`
                                  : result.completed
                                    ? `${entity} sync completed (${written} written, ${fetched} fetched)`
                                    : `${entity} sync in progress (${written} written, ${fetched} fetched)`,
                              metadata: {
                                flowId,
                                executionId,
                                entity,
                                chunkIndex,
                                totalProcessed: written,
                                totalWritten: written,
                                totalFetched: fetched,
                                hasMore: !result.completed,
                              },
                            },
                          ],
                          $slice: -200,
                        },
                      },
                    } as any);
                } catch {
                  // non-critical
                }
              }

              return result;
            }),
          {
            onWait: (wait, refusal) => {
              logger.warn("Connector box low on memory; chunk waits", {
                flowId,
                entity,
                chunkIndex,
                wait,
                availableMb: refusal.availableMb,
                retryInMs: refusal.retryInMs,
              });
              logExec("warn", refusal.message, {
                flowId,
                entity,
                chunkIndex,
                executionId,
                wait,
              });
            },
          },
        );
      stepsUsed += 1 + 2 * memoryWaits;

      state = chunkResult.state;
      completed = chunkResult.completed;
      // Bulk path: the chunk only buffers, so this is what the flushes so far
      // merged (carried in the state); direct writes count as they land.
      totalWrittenForEntity = Number.isFinite(chunkResult.totalWritten)
        ? chunkResult.totalWritten
        : chunkResult.state.totalProcessed;

      // Direct writes are in the destination when the chunk step returns.
      if (!useBulkPath && chunkIndex % 10 === 9) {
        await saveCheckpoint(
          `save-cdc-backfill-checkpoint-${safeEntityStepId}-${chunkIndex}`,
        );
      }
      chunkIndex++;

      if (!completed) {
        await flushBuffer(String(chunkIndex), FLUSH_THRESHOLD_ROWS);
      }

      if (chunkIndex > 1000) {
        throw new Error(
          `Too many chunks (${chunkIndex}) for entity ${entity}. Possible infinite loop.`,
        );
      }
    }

    const totalFetched = state?.totalProcessed ?? totalWrittenForEntity;
    logger.info("Completed chunked sync for entity", {
      flowId,
      entity,
      totalChunks: chunkIndex,
      totalFetched,
      totalWrittenForEntity,
      fetchWriteDelta: totalFetched - totalWrittenForEntity,
      useBulkPath,
    });

    // ── Flush remaining + merge for bulk path ─────────────────────────
    if (useBulkPath && bulkSyncOptions && restoredRows === undefined) {
      const finalRowsInTemp = await step.run(
        `count-temp-final-${safeEntityStepId}`,
        () =>
          withHeartbeat(executionId, async () => {
            const count = await getTempCollectionCount(
              flowId,
              entity,
              fullRead,
            );
            logger.info("Final temp collection row count before flush", {
              flowId,
              entity,
              tempCount: count,
            });
            return count;
          }),
      );
      const restBigQueryOverwrite = retainedBatch(finalRowsInTemp);

      if (finalRowsInTemp > 0) {
        const rescuedInFinal = await boxStep(
          `flush-final-${safeEntityStepId}`,
          () =>
            withHeartbeat(executionId, async () => {
              logExec(
                "info",
                `Flushing ${entity} remaining buffer to staging (${finalRowsInTemp} rows)`,
                { entity, tempCount: finalRowsInTemp },
              );
              // Retry-safe for the same reason as the flush-merge step above.
              const { rescued } = await performRescueAndPrepareStaging(
                bulkSyncOptions as any,
                { dedupOnly: true },
              );
              if (rescued > 0) {
                logExec(
                  "warn",
                  `Rescued ${rescued} ${entity} staging rows left by a failed flush attempt`,
                  { entity, rescued },
                );
              }
              await performBulkFlush(bulkSyncOptions as any, () =>
                touchHeartbeat(executionId),
              );
              return rescued;
            }),
        );

        const mergedFinal = await boxStep(
          `merge-final-${safeEntityStepId}`,
          () =>
            withHeartbeat(executionId, async () => {
              logExec("info", `Merging ${entity} staging table to live`, {
                entity,
              });
              const mergeResult = await performStagingMerge(
                bulkSyncOptions as any,
                { mergePath: "final", restBigQueryOverwrite },
              );
              await performStagingCleanup(bulkSyncOptions as any);
              logExec(
                "info",
                `✅ ${entity} bulk backfill complete (buffer → Parquet → staging → live, ${mergeResult.written} rows merged)`,
                { entity, mergedRows: mergeResult.written },
              );
              logger.info("Final merge result", {
                flowId,
                entity,
                mergedRows: mergeResult.written,
                totalFetched,
              });
              return mergeResult.written;
            }),
        );
        totalWrittenForEntity +=
          (Number(rescuedInFinal) || 0) + (Number(mergedFinal) || 0);
      }

      if (restOverwrite) {
        const reservation = restOverwrite;
        if (
          !state ||
          state.hasMore ||
          state.totalProcessed !== totalWrittenForEntity
        ) {
          throw new Error(
            "BigQuery REST overwrite requires a complete source read",
          );
        }
        const finalState = state;
        const sourceRows = finalState.totalProcessed;
        await step.run(`seal-rest-bigquery-overwrite-${safeEntityStepId}`, () =>
          withHeartbeat(executionId, async () => {
            const left = await getTempCollectionCount(flowId, entity, fullRead);
            if (left > 0) {
              throw new Error(
                "BigQuery REST overwrite left buffered source rows",
              );
            }
            if (
              !(await cdcAdapter.hasCompletedRestOverwriteTruncate?.(
                reservation,
              ))
            ) {
              throw new Error(
                "BigQuery REST overwrite receipts did not settle",
              );
            }
            const writes = await readBigQueryRestOverwriteWrites(reservation);
            const manifest = {
              reservation,
              sourceRows,
              replacementFingerprints: writes.map(write => write.fingerprint),
              ...(checkpointEnabled
                ? { fetchState: withRowsWritten(finalState, sourceRows) }
                : {}),
            };
            if (!(await sealRestBigQueryOverwriteManifest(Flow.db, manifest))) {
              throw new Error(
                "BigQuery REST overwrite receipts did not settle",
              );
            }
          }),
        );
      }
    }

    const reportBulkCompletion = async () => {
      if (!useBulkPath || !bulkSyncOptions || !executionId) return;
      try {
        await Flow.db.collection("flow_executions").updateOne(
          { _id: new Types.ObjectId(executionId) },
          {
            $set: {
              lastHeartbeat: new Date(),
              [`stats.entityStatus.${entity}`]: "completed",
              [`stats.entityStats.${entity}`]: totalWrittenForEntity,
            },
            $addToSet: { "stats.syncedEntities": entity },
          },
        );
        logExec(
          "info",
          `${entity} sync completed (${totalWrittenForEntity} written, ${totalFetched} fetched)`,
          {
            entity,
            totalWritten: totalWrittenForEntity,
            totalFetched,
          },
        );
      } catch {
        // non-critical
      }
    };
    if (restRun && useBulkPath) {
      await step.run(
        `verify-rest-entity-buffer-${safeEntityStepId}`,
        async () => {
          if ((await getTempCollectionCount(flowId, entity, fullRead)) > 0) {
            throw new Error("REST entity run left buffered source rows");
          }
        },
      );
    }
    if (!restOverwrite && !restRun) await reportBulkCompletion();

    // ── Mark checkpoint completed ────────────────────────────────────
    const completedCheckpoint =
      checkpointEnabled && state
        ? {
            workspaceId,
            flowId,
            scope: checkpointScope,
            entity,
            fetchState: state,
            rowsWritten: totalWrittenForEntity,
            ...(backfillFetch?.runStartedAt
              ? {
                  runStartedAt: backfillFetch.runStartedAt,
                  fetchMode: backfillFetch.mode,
                }
              : {}),
          }
        : undefined;
    if (completedCheckpoint && !restOverwrite && !restRun) {
      await step.run(
        `complete-cdc-backfill-checkpoint-${safeEntityStepId}`,
        () =>
          cdcBackfillCheckpointService.markEntityCompleted(completedCheckpoint),
      );
    }

    // ── Stamp the poll cursor ────────────────────────────────────────
    // Only after every row of this run reached the live table: the next poll
    // re-reads from this run's start (minus the overlap).
    const pollRunStartedAt = pollCursor?.runStartedAt;
    if (pollRunStartedAt && !restRun) {
      await step.run(`stamp-poll-cursor-${safeEntityStepId}`, async () => {
        await stampPollRunStartedAt({
          workspaceId,
          flowId,
          entity,
          runStartedAt: pollRunStartedAt,
        });
      });
    }

    if (trackedAdmission && restRun) {
      await step.run(`settle-rest-entity-run-${safeEntityStepId}`, () =>
        settleRestEntityRun(
          Flow.db,
          trackedAdmission.scope,
          restRun,
          async session => {
            if (completedCheckpoint) {
              await cdcBackfillCheckpointService.markEntityCompleted({
                ...completedCheckpoint,
                session,
              });
            }
            if (pollRunStartedAt) {
              await stampPollRunStartedAt({
                workspaceId,
                flowId,
                entity,
                runStartedAt: pollRunStartedAt,
                session,
              });
            }
          },
        ),
      );
      await reportBulkCompletion();
    }

    if (restOverwrite) {
      const reservation = restOverwrite;
      // Persist the checkpoint and release the reservation together. A retry
      // after a committed release must not count the same rows again.
      await step.run(
        `release-rest-bigquery-overwrite-${safeEntityStepId}`,
        () =>
          withHeartbeat(executionId, async () => {
            const db = Flow.db;
            const recorded = await findRecordedRestBigQueryOverwrite({
              ...bulkSyncOptions,
              restEntityAdmission: {
                scope: reservation.scope,
                runId: reservation.overwrite.runId,
              },
            } as any);
            const manifest = recorded
              ? await readVerifiedRestBigQueryOverwriteManifest(db, recorded)
              : undefined;
            if (
              !manifest ||
              manifest.sourceRows !== totalWrittenForEntity ||
              !(await settleRestBigQueryOverwriteManifest(
                db,
                manifest,
                completedCheckpoint
                  ? async session => {
                      if (!manifest.fetchState) {
                        throw new Error(
                          "BigQuery REST overwrite is missing its sealed checkpoint",
                        );
                      }
                      await cdcBackfillCheckpointService.markEntityCompleted({
                        ...completedCheckpoint,
                        fetchState: manifest.fetchState,
                        session,
                      });
                    }
                  : undefined,
              ))
            ) {
              throw new Error(
                "BigQuery REST overwrite receipts did not settle",
              );
            }
          }),
      );
      await reportBulkCompletion();
    }

    return { completed: true, rowsWritten: totalWrittenForEntity };
  },
);
