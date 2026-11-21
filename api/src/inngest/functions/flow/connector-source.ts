/**
 * The connector branch of a flow run: resolve the entities to sync, fan each
 * out to the `sync-backfill-entity` child function (each child gets its own
 * step budget), and — for a CDC backfill — complete the backfill, drain the
 * pending events and start the stream.
 */
import { Types } from "mongoose";
import { Flow, type IFlow } from "../../../database/workspace-schema";
import { withHeartbeat } from "../../../services/flow-execution-tracking";
import { syncConnectorRegistry } from "../../../sync/connector-registry";
import { sourceConnectionManager } from "../../../sync/database-data-source-manager";
import {
  forceDrainCdcFlow,
  markCdcBackfillCompletedForFlow,
  purgeSoftDeletesAfterBackfill,
} from "../../../sync-cdc/backfill";
import {
  compareFlowDataDiff,
  prepareFlowDataDiff,
} from "../../../sync-cdc/data-diff";
import { resolveConfiguredEntities } from "../../../sync-cdc/entity-selection";
import {
  backfillCheckpointScope,
  cdcBackfillCheckpointService,
  syncMachineService,
} from "../../../sync-cdc/sync-state";
import type { FetchState } from "../../../connectors/base/BaseConnector";
import {
  addRowsWritten,
  checkpointRowsWritten,
  syncBackfillEntityFunction,
  type SyncBackfillEntityResult,
} from "../sync-entity";
import {
  completeExecutionStep,
  emitSuccessNotification,
  markFlowSucceeded,
} from "./execution-completion";
import type { FlowRunContext } from "./run-context";

/**
 * Which entities this run syncs: the flow's explicit selection (validated
 * against what the connector offers), narrowed to a backfill's scope when it
 * has one; otherwise everything the connector offers.
 */
export function selectEntitiesToSync(params: {
  availableEntities: string[];
  configuredEntities: string[];
  hasExplicitSelection: boolean;
  backfill: boolean;
  scopedBackfillEntities: string[];
}): string[] {
  const { availableEntities, configuredEntities, hasExplicitSelection } =
    params;
  const { backfill, scopedBackfillEntities } = params;

  if (hasExplicitSelection) {
    // Validate requested entities
    const invalidEntities = configuredEntities.filter(
      e => !availableEntities.includes(e),
    );
    if (invalidEntities.length > 0) {
      throw new Error(
        `Invalid entities: ${invalidEntities.join(", ")}. Available: ${availableEntities.join(", ")}`,
      );
    }
    if (backfill && scopedBackfillEntities.length > 0) {
      const invalidScope = scopedBackfillEntities.filter(
        entity => !configuredEntities.includes(entity),
      );
      if (invalidScope.length > 0) {
        throw new Error(
          `Invalid backfill scope entities: ${invalidScope.join(", ")}. Configured entities: ${configuredEntities.join(", ")}`,
        );
      }
      return scopedBackfillEntities;
    }
    return configuredEntities;
  }

  if (backfill && scopedBackfillEntities.length > 0) {
    const invalidScope = scopedBackfillEntities.filter(
      entity => !availableEntities.includes(entity),
    );
    if (invalidScope.length > 0) {
      throw new Error(
        `Invalid backfill scope entities: ${invalidScope.join(", ")}. Available entities: ${availableEntities.join(", ")}`,
      );
    }
    return scopedBackfillEntities;
  }
  return availableEntities;
}

/** The decrypted source connection and its connector, or a throw. */
async function loadConnector(
  dataSourceId: string,
  workspaceId: string,
  queries?: unknown[],
) {
  const sourceConnection = await sourceConnectionManager.getSourceConnection(
    dataSourceId,
    workspaceId,
  );
  if (!sourceConnection) {
    throw new Error(`Data source not found: ${dataSourceId}`);
  }

  // Inject flow queries into sourceConnection for GraphQL/PostHog connectors
  // The registry maps connection -> config when creating the connector
  if (queries && queries.length > 0) {
    sourceConnection.connection = {
      ...sourceConnection.connection,
      queries,
    };
  }

  const connector =
    await syncConnectorRegistry.getConnectorFor(sourceConnection);
  if (!connector) {
    throw new Error(
      `Failed to create connector for type: ${sourceConnection.type}`,
    );
  }
  return { sourceConnection, connector };
}

export async function runConnectorSourceFlow(
  ctx: FlowRunContext,
  flow: IFlow,
  params: {
    isCdcEnabled: boolean;
    isCdcBackfill: boolean;
    destinationType: string | undefined;
  },
): Promise<{ success: true; message: string }> {
  const { step, logger, flowId, requestedBackfillEntities } = ctx;
  const { backfill } = ctx.data;
  const { executionId, cdcBackfillRunId } = ctx.state;
  const { isCdcEnabled, isCdcBackfill, destinationType } = params;
  const throwIfExecutionCancelled = ctx.throwIfExecutionCancelled;

  // Rows written per entity, for the execution's stats
  const entityStatsMap: Record<string, number | null> = {};

  // Ensure dataSourceId is defined for connector execution
  if (!flow.dataSourceId) {
    throw new Error("Flow dataSourceId is required for connector execution");
  }
  const dataSourceId = flow.dataSourceId;

  // Check if connector supports chunked execution
  const supportsChunking = await step.run(
    "check-chunking-support",
    async () => {
      const { sourceConnection, connector } = await loadConnector(
        dataSourceId.toString(),
        String(flow.workspaceId),
      );
      const supports = connector.supportsResumableFetching();
      logger.info("Connector chunking support check", {
        flowId,
        connectorType: sourceConnection.type,
        supportsChunking: supports,
      });
      return supports;
    },
  );

  if (!supportsChunking) {
    // Every connector supports chunked fetching; the non-chunked legacy
    // path (performSync into MongoDB collections) has been removed.
    throw new Error(
      `Connector for flow ${flowId} does not support chunked fetching, which CDC requires`,
    );
  }

  // Checkpointed backfills apply to any CDC backfill run.
  const checkpointEnabled =
    Boolean(backfill) && isCdcEnabled && Boolean(cdcBackfillRunId);
  const checkpointScope =
    checkpointEnabled && cdcBackfillRunId
      ? backfillCheckpointScope({
          runId: cdcBackfillRunId,
          destinationId: String(flow.destinationDatabaseId),
          tableDestination: flow.tableDestination as unknown as Record<
            string,
            unknown
          >,
        })
      : undefined;
  let checkpointCompletedEntities = new Set<string>();
  if (checkpointScope) {
    const completedEntities = (await step.run(
      "load-cdc-backfill-completed-entities",
      async () => {
        return cdcBackfillCheckpointService.listCompletedEntities({
          workspaceId: String(flow.workspaceId),
          flowId: String(flow._id),
          scope: checkpointScope,
        });
      },
    )) as string[];
    checkpointCompletedEntities = new Set(completedEntities);
    logger.info("Loaded CDC backfill checkpoints", {
      flowId,
      runId: cdcBackfillRunId,
      completedEntities: completedEntities.length,
    });
  }

  // Get entities to sync
  const entitiesToSync = await step.run("get-entities-to-sync", async () => {
    const { connector } = await loadConnector(
      dataSourceId.toString(),
      String(flow.workspaceId),
      flow.queries,
    );

    // Filter entities to skip incomplete/malformed configurations (e.g., empty query bodies)
    const availableEntities = connector
      .getAvailableEntities()
      .filter(e => typeof e === "string" && e.trim().length > 0);
    const { entities: configuredEntities, hasExplicitSelection } =
      resolveConfiguredEntities(flow);
    const scopedBackfillEntities =
      requestedBackfillEntities.length > 0
        ? requestedBackfillEntities
        : backfill &&
            flow.backfillState?.scope?.mode === "subset" &&
            Array.isArray(flow.backfillState.scope.entities)
          ? flow.backfillState.scope.entities
          : [];

    return selectEntitiesToSync({
      availableEntities,
      configuredEntities,
      hasExplicitSelection,
      backfill: Boolean(backfill),
      scopedBackfillEntities,
    });
  });

  // Initialize entity progress so UI can render all entities immediately
  // with "pending" before each entity actually starts.
  if (executionId) {
    await step.run("initialize-entity-progress", async () => {
      const db = Flow.db;
      const collection = db.collection("flow_executions");
      const pendingEntityStatus = Object.fromEntries(
        entitiesToSync.map(entity => [entity, "pending"]),
      );
      const initialEntityStats = Object.fromEntries(
        entitiesToSync.map(entity => [entity, 0]),
      );

      await collection.updateOne(
        { _id: new Types.ObjectId(executionId) },
        {
          $set: {
            lastHeartbeat: new Date(),
            "stats.plannedEntities": entitiesToSync,
            "stats.entityStatus": pendingEntityStatus,
            "stats.entityStats": initialEntityStats,
            "stats.recordsProcessed": 0,
          },
        },
      );
    });
  }

  // Data-diff baseline: a backfill, or a run whose connector, connector code
  // or destination changed since the last one, records per-column non-null
  // counts first (sync-cdc/data-diff.ts). Never fails the run.
  await step.run("data-diff-baseline", () =>
    withHeartbeat(executionId, () =>
      prepareFlowDataDiff({
        flowId: String(flowId),
        entities: entitiesToSync,
        backfill: isCdcBackfill,
      }),
    ),
  );

  // Process each entity via fan-out to child functions.
  // Each child gets its own 1000-step Inngest budget.
  for (const entity of entitiesToSync) {
    const safeEntityStepId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
    await throwIfExecutionCancelled("connector-before-entity", {
      entity,
    });

    if (checkpointScope && checkpointCompletedEntities.has(entity)) {
      logger.info("Skipping entity already completed in checkpointed run", {
        flowId,
        entity,
        runId: cdcBackfillRunId,
      });
      if (destinationType === "bigquery") {
        const checkpoint = await step.run(
          `load-completed-count-${safeEntityStepId}`,
          () =>
            cdcBackfillCheckpointService.loadEntityCheckpoint({
              workspaceId: String(flow.workspaceId),
              flowId: String(flow._id),
              scope: checkpointScope,
              entity,
            }),
        );
        entityStatsMap[entity] = checkpointRowsWritten(checkpoint ?? undefined);
      } else {
        entityStatsMap[entity] = Math.max(entityStatsMap[entity] || 0, 1);
      }
      if (executionId) {
        await step.run(`mark-entity-skipped-${safeEntityStepId}`, async () => {
          const db = Flow.db;
          await db.collection("flow_executions").updateOne(
            { _id: new Types.ObjectId(executionId) },
            {
              $set: {
                lastHeartbeat: new Date(),
                "stats.currentEntity": entity,
                [`stats.entityStatus.${entity}`]: "completed",
              },
              $addToSet: { "stats.syncedEntities": entity },
            },
          );
        });
      }
      continue;
    }

    logger.info("Invoking child function for entity sync", {
      flowId,
      entity,
    });

    const entityPayload = {
      flowId: flowId.toString(),
      entity,
      executionId,
      dataSourceId: dataSourceId.toString(),
      workspaceId: flow.workspaceId.toString(),
      backfill,
      backfillRunId: backfill ? cdcBackfillRunId || executionId : undefined,
      checkpointEnabled,
      cdcBackfillRunId,
      destinationId: flow.destinationDatabaseId.toString(),
      destinationDatabaseName: flow.destinationDatabaseName,
      syncMode: flow.syncMode,
      writeMode: flow.writeMode,
      syncEngine: flow.syncEngine,
      tableDestination: flow.tableDestination,
      deleteMode: flow.deleteMode,
      entityLayouts: flow.entityLayouts,
      isCdcEnabled,
      destinationType: destinationType || "",
      queries: flow.queries,
    };

    let entityCompleted = false;
    let invocationIndex = 0;
    let resumeState: FetchState | undefined;
    let previousWriteCountUnavailable = false;
    while (!entityCompleted) {
      const result = (await step.invoke(
        `sync-entity-${safeEntityStepId}-${invocationIndex}`,
        {
          function: syncBackfillEntityFunction,
          data: {
            ...entityPayload,
            ...(resumeState ? { resumeState } : {}),
            ...(previousWriteCountUnavailable
              ? { previousWriteCountUnavailable }
              : {}),
          },
        },
      )) as SyncBackfillEntityResult;
      entityCompleted = result.completed;
      // A poll that yielded hands back its fetch state; the next invocation
      // resumes from it (backfills resume from their checkpoint instead).
      resumeState = result.state;
      previousWriteCountUnavailable =
        previousWriteCountUnavailable ||
        (destinationType === "bigquery" &&
          isCdcEnabled &&
          result.bigQueryAffectedRows !== true) ||
        result.rowsWritten === null;
      entityStatsMap[entity] = previousWriteCountUnavailable
        ? null
        : result.rowsWritten;
      invocationIndex++;
      if (invocationIndex > 100) {
        throw new Error(
          `Entity ${entity} exceeded 100 continuation invocations`,
        );
      }
    }

    checkpointCompletedEntities.add(entity);
    logger.info("Entity sync completed via child function", {
      flowId,
      entity,
      rowsWritten: entityStatsMap[entity],
    });
  }

  // Post-backfill CDC state machine: complete the backfill, drain pending
  // events, and (re)start the stream. Applies to any CDC backfill run.
  if (isCdcBackfill) {
    await finishCdcBackfill(ctx, flow);
  }

  // Data-diff comparison: counts again and flags columns that lost values,
  // when a baseline is open. Never fails the run.
  await step.run("data-diff-compare", () =>
    withHeartbeat(executionId, async () => {
      const diff = await compareFlowDataDiff({
        flowId: String(flowId),
        executionId,
      });
      return { compared: Boolean(diff), flagged: diff?.flagged.length ?? 0 };
    }),
  );

  await markFlowSucceeded(ctx, "connector-before-success-mark");

  // Complete execution logging
  await completeExecutionStep(ctx, {
    strict: true,
    stats: {
      recordsProcessed: Object.values(entityStatsMap).reduce(addRowsWritten, 0),
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      recordsFailed: 0,
      syncedEntities: entitiesToSync,
      entityStats: entityStatsMap,
      entityStatus: Object.fromEntries(
        Object.keys(entityStatsMap).map(entity => [entity, "completed"]),
      ),
    },
  });

  await emitSuccessNotification(ctx);

  return { success: true, message: "Sync completed successfully" };
}

/** Complete the CDC backfill, drain pending events, start the stream. */
async function finishCdcBackfill(
  ctx: FlowRunContext,
  flow: IFlow,
): Promise<void> {
  const { step, flowId } = ctx;
  const { executionId, cdcBackfillRunId } = ctx.state;

  await step.run("mark-cdc-backfill-complete", async () => {
    await markCdcBackfillCompletedForFlow({
      flowId: String(flowId),
      workspaceId: String(flow.workspaceId),
    });
  });
  await step.run("drain-cdc-pending-events", () =>
    withHeartbeat(executionId, () =>
      forceDrainCdcFlow({
        workspaceId: String(flow.workspaceId),
        flowId: String(flowId),
      }),
    ),
  );
  await step.run("cdc-transition-backfill-complete", async () => {
    await syncMachineService.applyBackfillTransition({
      workspaceId: String(flow.workspaceId),
      flowId: String(flow._id),
      event: {
        type: "COMPLETE",
        reason: "Backfill cursor exhausted",
      },
      context: {
        backfillCursorExhausted: true,
      },
    });
    await syncMachineService.applyStreamTransition({
      workspaceId: String(flow.workspaceId),
      flowId: String(flow._id),
      event: {
        type: "START",
        reason: "Stream activated after backfill",
      },
    });
  });
  // One DELETE per entity table on the destination: can be slow.
  await step.run("purge-soft-deletes-after-backfill", () =>
    withHeartbeat(executionId, () =>
      purgeSoftDeletesAfterBackfill({
        workspaceId: String(flow.workspaceId),
        flowId: String(flowId),
      }),
    ),
  );
  await step.run("finalize-cdc-backfill-run", async () => {
    // markCdcBackfillCompletedForFlow already set status=completed,
    // completedAt, and unset runId. Only reset the failure counter
    // and clear checkpoint data here.
    await Flow.findByIdAndUpdate(flowId, {
      $set: {
        "backfillState.consecutiveFailures": 0,
        "backfillState.infraFailures": 0,
      },
    });
    if (cdcBackfillRunId) {
      await cdcBackfillCheckpointService.clearRun({
        workspaceId: String(flow.workspaceId),
        flowId: String(flow._id),
      });
    }
  });
}
