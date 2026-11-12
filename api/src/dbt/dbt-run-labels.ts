// Owner: WP3 (run inputs). Stub: the signatures are the contract.
import type { IDbtRun } from "../database/workspace-schema";

export interface DbtRunLabelInput {
  runId: string;
  trigger: IDbtRun["trigger"];
  /** Job runs only. */
  jobId?: string;
  jobSlug?: string;
}

/**
 * Non-secret env for the dbt child, values sanitized as BigQuery labels:
 * MAKO_DBT_JOB (job runs only), MAKO_DBT_RUN, MAKO_TRIGGER, and the same
 * under DBT_ENV_CUSTOM_ENV_. Engine-neutral. Pass as `DbtRunRequest.extraEnv`.
 */
export function dbtRunLabelEnv(
  input: DbtRunLabelInput,
): Record<string, string> {
  void input;
  return {};
}

/**
 * The query-comment macro a project adds to turn that env into warehouse job
 * labels. WP4 quotes it in the dbt-jobs skill. Empty until WP3 fills it.
 */
export const DBT_QUERY_COMMENT_MACRO: string = "";
