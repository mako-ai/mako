/**
 * Wall-clock budget for waiting on a BigQuery job.
 *
 * The poll loops used to count only their own sleeps (`waitedMs +=
 * pollIntervalMs`) and never the `jobs.getQueryResults` calls between them.
 * BigQuery holds each of those calls open for up to `timeoutMs` (10 seconds
 * by default) while the job runs, so a "5 minute" budget polled 300 times at
 * ~11 seconds each: 55 minutes of wall clock before the query was abandoned.
 * On 2026-09-14/15 one app's deploy re-ran a slow binding that way 39 times
 * (~1,000 slot-hours) and starved every other job in its reservation.
 *
 * The budget is a deadline, and each poll asks BigQuery to answer before it.
 */

/** BigQuery's own default and ceiling we use for one getQueryResults wait. */
export const BIGQUERY_RESULTS_WAIT_CAP_MS = 10_000;

export interface BigQueryPollBudget {
  /** True once the deadline has passed. */
  expired(): boolean;
  /** Milliseconds to sleep before the next poll, never past the deadline. */
  sleepMs(pollIntervalMs: number): number;
  /**
   * `timeoutMs` for the next getQueryResults call: how long BigQuery may hold
   * the request, never past the deadline and never above the cap.
   */
  requestTimeoutMs(): number;
}

export function createBigQueryPollBudget(
  maxWaitMs: number,
  now: () => number = Date.now,
): BigQueryPollBudget {
  const deadline = now() + maxWaitMs;
  const remaining = () => Math.max(0, deadline - now());
  return {
    expired: () => remaining() === 0,
    sleepMs: pollIntervalMs => Math.min(pollIntervalMs, remaining()),
    requestTimeoutMs: () =>
      Math.max(1, Math.min(BIGQUERY_RESULTS_WAIT_CAP_MS, remaining())),
  };
}
