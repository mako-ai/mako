/**
 * BigQuery job priority: INTERACTIVE (the default) or BATCH.
 *
 * Mako's sync writes (CDC MERGEs, staging merges, hard deletes, purges,
 * database-flow writes) share a reservation with people's reads (app
 * bindings, consoles, agents, notebooks). In November 2026 CDC MERGEs used
 * 54% of realadvisor-prod's slots at 63 jobs a minute, and reads queued 200+ s
 * behind them. BigQuery starts an INTERACTIVE job before a queued BATCH one,
 * so sync writes run at BATCH and reads keep INTERACTIVE.
 *
 * A job's priority comes from, in order: the `priority` query option, the
 * enclosing `withBigQueryJobPriority` context (for driver helpers such as
 * upsertBatch that start their own jobs), then INTERACTIVE.
 *
 * `BQ_SYNC_WRITE_PRIORITY=INTERACTIVE` rolls sync writes back to INTERACTIVE.
 * It is read here and nowhere else.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type BigQueryJobPriority = "INTERACTIVE" | "BATCH";

const storage = new AsyncLocalStorage<BigQueryJobPriority>();

/** The priority for a sync or CDC write: BATCH unless the env says otherwise. */
export function syncWritePriority(): BigQueryJobPriority {
  const raw = (process.env.BQ_SYNC_WRITE_PRIORITY || "").trim().toUpperCase();
  return raw === "INTERACTIVE" ? "INTERACTIVE" : "BATCH";
}

/** Run `fn` with this priority on every BigQuery query job it starts. */
export function withBigQueryJobPriority<T>(
  priority: BigQueryJobPriority,
  fn: () => T,
): T {
  return storage.run(priority, fn);
}

/** Run `fn` as a sync write: `withBigQueryJobPriority(syncWritePriority())`. */
export function asSyncWrite<T>(fn: () => T): T {
  return withBigQueryJobPriority(syncWritePriority(), fn);
}

/** The priority for one job: the explicit option, the context, INTERACTIVE. */
export function resolveBigQueryJobPriority(
  explicit?: BigQueryJobPriority,
): BigQueryJobPriority {
  return explicit ?? storage.getStore() ?? "INTERACTIVE";
}

/**
 * How long a BATCH job may sit in PENDING before the caller stops waiting:
 * BQ_BATCH_PENDING_MAX_WAIT_MS, else 30 minutes, at most 6 hours. This wait
 * is on top of the job's run budget, which counts from the job's start.
 */
export function batchPendingMaxWaitMs(): number {
  const fromEnv = Number.parseInt(
    process.env.BQ_BATCH_PENDING_MAX_WAIT_MS || "",
    10,
  );
  return Number.isFinite(fromEnv) && fromEnv >= 1000
    ? Math.min(fromEnv, 6 * 60 * 60 * 1000)
    : 30 * 60 * 1000;
}
