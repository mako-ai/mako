/**
 * The connector branch of a flow run: resolve the entities to sync, fan each
 * out to the `sync-backfill-entity` child function (each child gets its own
 * step budget), several entities at once (entity-parallelism.ts), and — for a
 * CDC backfill — once every entity is done, complete the backfill, drain the
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
import { resolveConfiguredEntities } from "../../../sync-cdc/entity-selection";
import {
  cdcBackfillCheckpointService,
  syncMachineService,
} from "../../../sync-cdc/sync-state";
import { syncBackfillEntityFunction } from "../sync-entity";
import {
  boxLeaseConfig,
  connectorBoxLeasesEnabled,
} from "../../../connectors/workspace/boxes/config";
import {
  isWorkspaceConnectorType,
  type SandboxedConnector,
} from "../../../connectors/workspace/SandboxedConnector";
import {
  entityRunConcurrencyKey,
  entityStepId,
  resolveEntityParallelism,
  runEntityLanes,
  syncEntityViaChild,
  type EntityInvocationResult,
} from "./entity-parallelism";
import { isCancellationError } from "./failure";
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
  const entityStatsMap: Record<string, number> = {};

  // Ensure dataSourceId is defined for connector execution
  if (!flow.dataSourceId) {
    throw new Error("Flow dataSourceId is required for connector execution");
  }
  const dataSourceId = flow.dataSourceId;

  // Check if connector supports chunked execution
  const connectorInfo = await step.run("check-chunking-support", async () => {
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
    // Older runs memoized a bare boolean here.
    return {
      supportsChunking: supports,
      boxed: isWorkspaceConnectorType(sourceConnection.type),
    };
  });
  const supportsChunking =
    typeof connectorInfo === "boolean"
      ? connectorInfo
      : connectorInfo.supportsChunking;
  const boxed = typeof connectorInfo === "object" && connectorInfo.boxed;

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
  let checkpointCompletedEntities = new Set<string>();
  if (checkpointEnabled && cdcBackfillRunId) {
    const runId = cdcBackfillRunId;
    const completedEntities = (await step.run(
      "load-cdc-backfill-completed-entities",
      async () => {
        return cdcBackfillCheckpointService.listCompletedEntities({
          workspaceId: String(flow.workspaceId),
          flowId: String(flow._id),
          runId,
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

  const parallelismDecision = resolveEntityParallelism({
    entities: entitiesToSync,
    flowOverride: flow.entityParallelism,
    boxed,
    leasesEnabled: connectorBoxLeasesEnabled(),
    maxLeasesPerConnection: boxLeaseConfig().maxPerConnection,
  });
  const { parallelism } = parallelismDecision;
  logger.info("Entity parallelism for this run", {
    flowId,
    entities: entitiesToSync.length,
    parallelism,
    limitedBy: parallelismDecision.limitedBy,
    boxed,
  });

  // Several entities of a workspace connector starting at once on a cold
  // sync box would all install the runtime and the connector into it at
  // the same time. Install once, here, before they start. Best effort:
  // every chunk still installs what it finds missing.
  if (boxed && parallelism > 1) {
    await step.run("prepare-connector-box", async () => {
      try {
        const { connector } = await loadConnector(
          dataSourceId.toString(),
          String(flow.workspaceId),
          flow.queries,
        );
        await (connector as Partial<SandboxedConnector>).prepareSyncBox?.();
      } catch (error) {
        logger.warn("Could not prepare the connector box before the entities", {
          flowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // Each entity runs in the `sync-backfill-entity` child function, which
  // gets its own 1000-step Inngest budget; up to `parallelism` at once.
  // Step ids stay per entity, so they do not depend on which lane ran it.
  const runEntity = async (entity: string) => {
    const safeEntityStepId = entityStepId(entity);
    await throwIfExecutionCancelled("connector-before-entity", {
      entity,
    });

    if (checkpointEnabled && checkpointCompletedEntities.has(entity)) {
      logger.info("Skipping entity already completed in checkpointed run", {
        flowId,
        entity,
        runId: cdcBackfillRunId,
      });
      entityStatsMap[entity] = Math.max(entityStatsMap[entity] || 0, 1);
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
      return;
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
      runConcurrencyKey: entityRunConcurrencyKey({
        flowId: flowId.toString(),
        entity,
        boxed,
      }),
    };

    entityStatsMap[entity] = await syncEntityViaChild({
      entity,
      invoke: stepId =>
        step.invoke(stepId, {
          function: syncBackfillEntityFunction,
          data: entityPayload,
        }) as Promise<EntityInvocationResult>,
      beforeContinuation: invocationIndex =>
        throwIfExecutionCancelled("connector-before-entity-continuation", {
          entity,
          invocationIndex,
        }),
    });

    checkpointCompletedEntities.add(entity);
    logger.info("Entity sync completed via child function", {
      flowId,
      entity,
      rowsWritten: entityStatsMap[entity],
    });
  };

  const { group } = ctx;
  await runEntityLanes({
    entities: entitiesToSync,
    parallelism,
    runEntity,
    isCancellation: error =>
      typeof error === "object" &&
      error !== null &&
      isCancellationError(error as Error),
    // Race mode: Inngest resumes the run as soon as one lane's step settles,
    // so a free lane takes the next entity at once. Default parallelism
    // would wait for every lane's step before resuming (a wave of N).
    parallel: group ? fn => group.parallel({ mode: "race" }, fn) : undefined,
  });

  // Post-backfill CDC state machine: complete the backfill, drain pending
  // events, and (re)start the stream. Applies to any CDC backfill run.
  if (isCdcBackfill) {
    await finishCdcBackfill(ctx, flow);
  }

  await markFlowSucceeded(ctx, "connector-before-success-mark");

  // Complete execution logging
  await completeExecutionStep(ctx, {
    strict: true,
    stats: {
      recordsProcessed: Object.values(entityStatsMap).reduce(
        (sum, value) => sum + value,
        0,
      ),
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
      $set: { "backfillState.consecutiveFailures": 0 },
    });
    if (cdcBackfillRunId) {
      await cdcBackfillCheckpointService.clearRun({
        workspaceId: String(flow.workspaceId),
        flowId: String(flow._id),
        runId: cdcBackfillRunId,
      });
    }
  });
}
