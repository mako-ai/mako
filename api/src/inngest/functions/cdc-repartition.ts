import { inngest } from "../client";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { loggers } from "../../logging";

const log = loggers.inngest();

interface RepartitionEventData {
  workspaceId: string;
  flowId: string;
  entities: string[];
  deleteDestination?: boolean;
}

/**
 * Background, observable in-place repartition of CDC destination tables.
 *
 * Triggered by a layout change (partition/cluster). Each entity is rewritten as
 * its own durable `step.run`, so a long copy on a large table can't time out the
 * request or block the others, and a transient failure retries that step alone.
 *
 * Flow:
 *  1. pause the flow stream (consumer holds events while tables swap),
 *  2. repartition each entity in place (copy + swap) — per-entity status is
 *     persisted on `CdcEntityState.repartition` for the UI,
 *  3. resume the stream,
 *  4. re-trigger materialization for repartitioned entities (queued events apply
 *     to the new table; merge is idempotent), and backfill any entity that had
 *     no existing table.
 *
 * `onFailure` resumes the stream and marks still-running entities failed so a
 * crash can never leave the flow stuck paused.
 */
export const cdcRepartitionFunction = inngest.createFunction(
  {
    id: "cdc-repartition",
    name: "CDC Repartition",
    retries: 2,
    timeouts: { finish: "2h" },
    concurrency: [{ scope: "fn", key: "event.data.flowId", limit: 1 }],
    singleton: { key: "event.data.flowId", mode: "skip" },
    onFailure: async ({ event }) => {
      const data = ((
        event as { data?: { event?: { data?: RepartitionEventData } } }
      )?.data?.event?.data ?? {}) as Partial<RepartitionEventData>;
      if (data.workspaceId && data.flowId) {
        await cdcBackfillService.recoverRepartition(
          data.workspaceId,
          data.flowId,
        );
      }
      log.error(
        "cdc-repartition failed; resumed stream + marked entities failed",
        { flowId: data.flowId },
      );
    },
    triggers: { event: "cdc/repartition" },
  },
  async ({ event, step }) => {
    const { workspaceId, flowId, deleteDestination } =
      event.data as RepartitionEventData;
    const entities = Array.isArray(event.data?.entities)
      ? (event.data.entities as unknown[]).filter(
          (e): e is string => typeof e === "string" && e.length > 0,
        )
      : [];
    if (entities.length === 0) {
      return { repartitioned: [], missing: [], failed: [] };
    }

    const { previousStreamState } = (await step.run("pause-stream", () =>
      cdcBackfillService.pauseStreamForRepartition(workspaceId, flowId),
    )) as { previousStreamState: string };

    const repartitioned: string[] = [];
    const missing: string[] = [];
    const failed: string[] = [];

    for (const entity of entities) {
      const safeId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
      const result = (await step.run(`repartition-${safeId}`, () =>
        cdcBackfillService.repartitionEntity({ workspaceId, flowId, entity }),
      )) as { outcome: "repartitioned" | "missing" | "failed" };
      if (result.outcome === "repartitioned") repartitioned.push(entity);
      else if (result.outcome === "missing") missing.push(entity);
      else failed.push(entity);
    }

    // Resume before follow-ups so live materialization isn't held longer than
    // the swaps themselves.
    await step.run("resume-stream", () =>
      cdcBackfillService.resumeStreamForRepartition(
        workspaceId,
        flowId,
        previousStreamState,
      ),
    );

    if (repartitioned.length > 0) {
      await step.run("materialize-repartitioned", () =>
        cdcBackfillService.triggerEntityMaterialization(
          workspaceId,
          flowId,
          repartitioned,
        ),
      );
    }

    if (missing.length > 0) {
      await step.run("backfill-missing", () =>
        cdcBackfillService.backfillMissingEntities(
          workspaceId,
          flowId,
          missing,
          deleteDestination,
        ),
      );
    }

    log.info("cdc-repartition complete", {
      flowId,
      repartitioned,
      missing,
      failed,
    });
    return { repartitioned, missing, failed };
  },
);
