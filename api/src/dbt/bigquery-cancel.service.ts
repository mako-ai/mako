/**
 * Best-effort cancellation of in-flight BigQuery jobs spawned by a dbt run.
 *
 * Killing the dbt subprocess stops the local process, but a BigQuery query it
 * already submitted keeps running (and billing) on the warehouse until it
 * finishes. dbt-bigquery prints the job id for each query it runs, so we scrape
 * the streamed logs for job ids and call `jobs.cancel` on them when the run is
 * cancelled.
 *
 * This is intentionally best-effort: the job id may not have been logged yet at
 * cancel time, the SDK call may race the job's natural completion, and the
 * cancel is fire-and-forget. None of these should block or fail the cancel.
 */

import { BigQuery } from "@google-cloud/bigquery";
import { loggers } from "../logging";
import type { DbtLogLine } from "./runner.service";

const logger = loggers.app();

export interface ParsedBigQueryJob {
  jobId: string;
  location?: string;
}

// BigQuery job ids are alphanumerics plus `_` and `-` (e.g. UUID-ish strings or
// `script_job_*`). Kept conservative so we never grab trailing punctuation.
const JOB_ID_CHARS = "[A-Za-z0-9_-]+";

const JOB_ID_PATTERNS: RegExp[] = [
  // Console URL dbt prints per node: ...&j=bq:US:JOBID&page=queryresults
  new RegExp(`[?&]j=bq:([A-Za-z0-9_-]+):(${JOB_ID_CHARS})`, "g"),
  // REST job path: .../projects/PROJECT/jobs/JOBID
  new RegExp(`/jobs/(${JOB_ID_CHARS})`, "g"),
  // Structured / plain mentions: "job_id": "JOBID", job_id=JOBID, Job ID: JOBID
  new RegExp(`job[_ ]?id["']?\\s*[:=]\\s*["']?(${JOB_ID_CHARS})`, "gi"),
];

/**
 * Extract BigQuery job ids (and locations, when present) from a single log
 * line. Pure + exported so the patterns can be unit-tested without spawning
 * dbt. De-duplicates within the line.
 */
export function extractBigQueryJobIds(line: string): ParsedBigQueryJob[] {
  if (!line) return [];
  const found = new Map<string, ParsedBigQueryJob>();

  // Console URL carries the location explicitly: j=bq:<location>:<jobId>.
  const urlPattern = JOB_ID_PATTERNS[0];
  urlPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(line)) !== null) {
    const [, location, jobId] = match;
    if (jobId) found.set(jobId, { jobId, location });
  }

  for (const pattern of JOB_ID_PATTERNS.slice(1)) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(line)) !== null) {
      const jobId = match[1];
      // Ignore obvious non-job tokens and anything already captured w/ location.
      if (!jobId || jobId.length < 4) continue;
      if (!found.has(jobId)) found.set(jobId, { jobId });
    }
  }

  return [...found.values()];
}

/**
 * Cancel the given BigQuery jobs. Builds one client from the service-account
 * credentials (the same shape dbt's keyfile uses) and issues `cancel()` per
 * job, swallowing per-job errors. No-op when there are no jobs or no
 * credentials.
 */
export async function cancelBigQueryJobs(params: {
  credentials: Record<string, unknown> | undefined;
  projectId?: string;
  defaultLocation?: string;
  jobs: ParsedBigQueryJob[];
  onLog?: (line: DbtLogLine) => void;
}): Promise<void> {
  if (!params.credentials || params.jobs.length === 0) return;

  const projectId =
    params.projectId ?? (params.credentials.project_id as string | undefined);

  let bq: BigQuery;
  try {
    bq = new BigQuery({
      projectId,
      credentials: params.credentials as Record<string, string>,
    });
  } catch (error) {
    logger.warn("Failed to build BigQuery client for job cancel", { error });
    return;
  }

  await Promise.all(
    params.jobs.map(async ({ jobId, location }) => {
      try {
        await bq.job(jobId, { location: location ?? params.defaultLocation }).cancel();
        params.onLog?.({
          ts: new Date(),
          level: "warn",
          line: `Requested BigQuery job cancel: ${jobId}`,
        });
        logger.info("Cancelled BigQuery job for cancelled dbt run", {
          jobId,
          location: location ?? params.defaultLocation,
        });
      } catch (error) {
        // Already done / unknown id / transient — best-effort only.
        logger.warn("BigQuery job cancel failed", { error, jobId });
      }
    }),
  );
}
