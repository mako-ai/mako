/**
 * Retention of run history (`flow_executions`).
 *
 * A finished run expires `FLOW_EXECUTION_RETENTION_DAYS` (default 90) after
 * its `completedAt`, through a TTL index that is PARTIAL on the terminal
 * statuses: a running execution is never a candidate, whatever its dates.
 * Every terminal transition sets `completedAt` (completion, failure,
 * cancellation, abandonment by the cleanup cron or by backfill recovery);
 * a document without it is simply never expired.
 *
 * The schema declaration, the migration and the startup reconcile all read
 * the seconds from here, so they cannot disagree. Mongoose autoIndex cannot
 * change the TTL of an index that already exists, so an override changed
 * after the index was built is applied by `ensureFlowExecutionTtlIndex`
 * (`collMod`), which the API runs on boot.
 *
 * No other collection is keyed to an execution document: execution logs
 * are embedded in it, and `notification_deliveries` has its own 90-day TTL.
 */
import type { Db } from "mongodb";

export const DEFAULT_FLOW_EXECUTION_RETENTION_DAYS = 90;

export const FLOW_EXECUTION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export const FLOW_EXECUTION_TTL_INDEX_NAME = "flow_executions_completed_ttl";

export const FLOW_EXECUTION_TTL_KEY = { completedAt: 1 } as const;

export const FLOW_EXECUTION_TTL_PARTIAL_FILTER = {
  status: { $in: [...FLOW_EXECUTION_TERMINAL_STATUSES] },
};

/**
 * Retention in days from `FLOW_EXECUTION_RETENTION_DAYS`. Anything that is
 * not a positive number falls back to the default rather than to "expire
 * immediately" or "never".
 */
export function flowExecutionRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.FLOW_EXECUTION_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_FLOW_EXECUTION_RETENTION_DAYS;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0
    ? days
    : DEFAULT_FLOW_EXECUTION_RETENTION_DAYS;
}

export function flowExecutionRetentionSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.round(flowExecutionRetentionDays(env) * 24 * 60 * 60);
}

interface ListedIndex {
  name?: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

function isOurIndex(index: ListedIndex): boolean {
  return (
    JSON.stringify(index.key) === JSON.stringify(FLOW_EXECUTION_TTL_KEY) &&
    JSON.stringify(index.partialFilterExpression ?? null) ===
      JSON.stringify(FLOW_EXECUTION_TTL_PARTIAL_FILTER)
  );
}

export type EnsureTtlIndexResult =
  | { action: "created"; expireAfterSeconds: number }
  | { action: "updated"; expireAfterSeconds: number; previous?: number }
  | { action: "unchanged"; expireAfterSeconds: number };

/**
 * Make the TTL index exist with the configured retention. Idempotent:
 * matched by key pattern + partial filter (not by name, so an index built
 * under another name is adopted), created when missing, `collMod`-ed when
 * its `expireAfterSeconds` differs.
 */
export async function ensureFlowExecutionTtlIndex(
  db: Db,
  expireAfterSeconds: number = flowExecutionRetentionSeconds(),
): Promise<EnsureTtlIndexResult> {
  const collection = db.collection("flow_executions");
  let indexes: ListedIndex[] = [];
  try {
    indexes = (await collection.listIndexes().toArray()) as ListedIndex[];
  } catch {
    // NamespaceNotFound: nothing exists yet, so nothing can conflict.
  }

  const existing = indexes.find(isOurIndex);
  if (!existing) {
    await collection.createIndex(FLOW_EXECUTION_TTL_KEY, {
      name: FLOW_EXECUTION_TTL_INDEX_NAME,
      expireAfterSeconds,
      partialFilterExpression: FLOW_EXECUTION_TTL_PARTIAL_FILTER,
    });
    return { action: "created", expireAfterSeconds };
  }

  if (existing.expireAfterSeconds === expireAfterSeconds) {
    return { action: "unchanged", expireAfterSeconds };
  }

  await db.command({
    collMod: "flow_executions",
    index: { name: existing.name, expireAfterSeconds },
  });
  return {
    action: "updated",
    expireAfterSeconds,
    previous: existing.expireAfterSeconds,
  };
}
