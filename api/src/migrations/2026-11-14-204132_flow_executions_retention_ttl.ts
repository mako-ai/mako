import { Db } from "mongodb";
import { loggers } from "../logging";
import {
  FLOW_EXECUTION_TERMINAL_STATUSES,
  ensureFlowExecutionTtlIndex,
  flowExecutionRetentionSeconds,
} from "../database/flow-execution-retention";

export const description =
  "Run-history retention: backfill completedAt on finished flow_executions that lack it, then create (or collMod) the partial TTL index on completedAt for terminal statuses (FLOW_EXECUTION_RETENTION_DAYS, default 90)";

const log = loggers.migration();

/**
 * Idempotent: the backfill only touches terminal runs with no `completedAt`
 * (stamped from their last heartbeat, else their start), and the index is
 * matched by key + partial filter, created when missing and `collMod`-ed
 * when its TTL differs from the configured retention. The API reconciles
 * the TTL again on boot, so an env override that differs between the
 * deploy machine and the service converges on the service's value.
 *
 * Note: on the first run, finished runs older than the retention are
 * deleted by the TTL monitor shortly after the index exists.
 */
export async function up(db: Db): Promise<void> {
  const executions = db.collection("flow_executions");

  const backfill = await executions.updateMany(
    {
      status: { $in: [...FLOW_EXECUTION_TERMINAL_STATUSES] },
      completedAt: null,
    },
    [
      {
        $set: {
          completedAt: { $ifNull: ["$lastHeartbeat", "$startedAt"] },
        },
      },
    ],
  );
  log.info("Backfilled completedAt on finished executions", {
    modified: backfill.modifiedCount,
  });

  const result = await ensureFlowExecutionTtlIndex(
    db,
    flowExecutionRetentionSeconds(),
  );
  log.info("flow_executions TTL index", result);
}
