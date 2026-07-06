/**
 * Tunables for the resumable long-running query flow.
 *
 * Long queries run as a detached in-process task that outlives the agent tool
 * call (see console-execution.service.ts). The agent's tool returns after a
 * short soft timeout, then auto-polls the DB-persisted status with backoff,
 * and finally escalates to the user. Every threshold here is env-overridable
 * so operators can tune it per deployment without a code change.
 *
 * This module has no service dependencies on purpose: it is imported by both
 * the database layer and the agent tools, so keeping it dependency-free avoids
 * import cycles.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envIntList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isFinite(value) && value > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * How long `run_console` (and the direct execute tools) await a detached run
 * inline before returning `status: "running"`. The query keeps running
 * server-side past this point — it is NOT cancelled.
 */
export const QUERY_SOFT_TIMEOUT_MS = envInt("QUERY_SOFT_TIMEOUT_MS", 90_000);

/**
 * Timeout for the direct, single-shot agent execute tools
 * (`sql_execute_query`, `mongo_execute_query`). These stay short for quick
 * exploration; on timeout the agent is told to run the query via a console for
 * the resumable flow instead.
 */
export const AGENT_DIRECT_QUERY_TIMEOUT_MS = envInt(
  "AGENT_DIRECT_QUERY_TIMEOUT_MS",
  60_000,
);

/**
 * Backoff schedule (ms) the agent uses when auto-polling `check_query_status`.
 * The last value repeats once the schedule is exhausted.
 */
export const QUERY_POLL_BACKOFF_MS = envIntList(
  "QUERY_POLL_BACKOFF_MS",
  [30_000, 60_000, 90_000],
);

/**
 * How long `check_query_status` BLOCKS server-side while a run is still
 * `running` before returning `status: "running"`. The tool long-polls (re-reads
 * the DB-backed run artifact every `QUERY_STATUS_POLL_INTERVAL_MS`) and returns
 * early the moment the run settles.
 *
 * This is the throttle that fixes rapid-fire polling: an LLM cannot actually
 * sleep between tool calls, so without a server-side wait it re-invokes
 * `check_query_status` every ~1s (flooding the chat UI). Blocking here makes
 * each poll naturally take ~one backoff interval regardless of how eagerly the
 * model calls it. It does NOT change the hard execution cap — the query keeps
 * running server-side and is still aborted at `QUERY_HARD_MAX_EXECUTION_MS`.
 */
export const QUERY_STATUS_POLL_WAIT_MS = envInt(
  "QUERY_STATUS_POLL_WAIT_MS",
  QUERY_POLL_BACKOFF_MS[0] ?? 30_000,
);

/**
 * How often the blocking `check_query_status` long-poll re-reads the persisted
 * run artifact while waiting for the run to settle. Small enough to surface a
 * finished result promptly, large enough to avoid hammering the DB.
 */
export const QUERY_STATUS_POLL_INTERVAL_MS = envInt(
  "QUERY_STATUS_POLL_INTERVAL_MS",
  2_000,
);

/**
 * Server-side hard ceiling: a detached run is aborted (task + engine-native
 * cancel) once it exceeds this, so no query can run forever. This is an
 * absolute cap applied uniformly to every engine; it is also used as the
 * BigQuery job poll ceiling so the detached BQ poll respects the same limit.
 */
export const QUERY_HARD_MAX_EXECUTION_MS = envInt(
  "QUERY_HARD_MAX_EXECUTION_MS",
  5 * 60_000,
);
