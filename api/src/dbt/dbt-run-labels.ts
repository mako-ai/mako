/**
 * Run identity for the dbt child process.
 *
 * dbt opens its own warehouse client, so the `mako_*` labels Mako puts on its
 * own queries (services/bigquery-labels.ts) never reach a dbt job. Instead the
 * run's identity is handed to dbt as environment variables, and the project's
 * query-comment macro (`DBT_QUERY_COMMENT_MACRO`) turns them into comment
 * fields and, on BigQuery, job labels. Mako never rewrites a project's
 * `dbt_project.yml`.
 */
import type { IDbtRun } from "../database/workspace-schema";
import { sanitizeBigQueryLabelValue } from "../services/bigquery-labels";

export interface DbtRunLabelInput {
  runId: string;
  trigger: IDbtRun["trigger"];
  /** Job runs only. */
  jobId?: string;
  jobSlug?: string;
}

/** dbt copies `DBT_ENV_CUSTOM_ENV_<NAME>` into every artifact's `metadata.env`. */
export const DBT_CUSTOM_ENV_PREFIX = "DBT_ENV_CUSTOM_ENV_";

/** dbt's own label sanitizer strips surrounding whitespace first; match it. */
function labelValue(raw: string | undefined): string {
  return sanitizeBigQueryLabelValue((raw ?? "").trim());
}

/**
 * Non-secret env for the dbt child, values sanitized as BigQuery labels
 * (lowercase, `[a-z0-9_-]`, at most 63 characters, never empty):
 *
 *  - `MAKO_DBT_JOB`: the job's id. Never the slug: a slug is unique inside
 *    one project only, so two projects or workspaces on one warehouse
 *    project would share a label value and their costs would add up. Job
 *    runs only: an ad-hoc run has no job, so the variable is absent.
 *  - `MAKO_DBT_JOB_SLUG`: the job's slug, for reading. Not an identifier.
 *  - `MAKO_DBT_RUN`: the run id.
 *  - `MAKO_TRIGGER`: schedule, manual, agent or ci.
 *
 * Each is repeated under `DBT_ENV_CUSTOM_ENV_`, which dbt writes into
 * `manifest.json` and `run_results.json` metadata. A value that sanitizes to
 * nothing is left out. Engine-neutral. Pass as `DbtRunRequest.extraEnv`.
 */
export function dbtRunLabelEnv(
  input: DbtRunLabelInput,
): Record<string, string> {
  const values: Record<string, string> = {
    MAKO_DBT_JOB: labelValue(input.jobId),
    // Display only, and only beside the id it names.
    MAKO_DBT_JOB_SLUG: input.jobId ? labelValue(input.jobSlug) : "",
    MAKO_DBT_RUN: labelValue(input.runId),
    MAKO_TRIGGER: labelValue(input.trigger),
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    env[name] = value;
    env[`${DBT_CUSTOM_ENV_PREFIX}${name}`] = value;
  }
  return env;
}

/** Where the scaffold writes the macro in a new project. */
export const DBT_QUERY_COMMENT_MACRO_PATH = "macros/mako_query_comment.sql";

/**
 * The `dbt_project.yml` block that makes dbt call the macro. `job-label: true`
 * is what turns the comment's fields into BigQuery job labels; other adapters
 * ignore it and only write the SQL comment.
 */
export const DBT_QUERY_COMMENT_PROJECT_CONFIG = `query-comment:
  comment: "{{ mako_query_comment(node) }}"
  job-label: true
`;

/**
 * The query-comment macro a project adds (as
 * `macros/mako_query_comment.sql`, with `DBT_QUERY_COMMENT_PROJECT_CONFIG` in
 * `dbt_project.yml`) to turn the run env into query comment fields and
 * BigQuery job labels. It keeps dbt's default fields (app, dbt_version,
 * profile_name, target_name, node_id) and adds, only when dbt runs inside
 * Mako: mako_source, mako_dbt_job, mako_dbt_job_slug, mako_dbt_run,
 * mako_trigger.
 *
 * Verified against dbt-bigquery 1.9.2 `connections.py`: with `job-label:
 * true` the comment is parsed as JSON and every key/value becomes a label
 * after dbt's own sanitizing; `dbt_invocation_id` is always added.
 */
export const DBT_QUERY_COMMENT_MACRO: string = `{% macro mako_query_comment(node) %}
  {%- set comment_dict = {
    "app": "dbt",
    "dbt_version": dbt_version,
    "profile_name": target.get("profile_name"),
    "target_name": target.get("target_name"),
  } -%}
  {%- if node is not none -%}
    {%- do comment_dict.update(node_id=node.unique_id) -%}
  {%- endif -%}
  {#- Set by Mako on every run it starts. Empty outside Mako: no mako_* fields. -#}
  {%- set mako_fields = {
    "mako_dbt_job": env_var("MAKO_DBT_JOB", ""),
    "mako_dbt_job_slug": env_var("MAKO_DBT_JOB_SLUG", ""),
    "mako_dbt_run": env_var("MAKO_DBT_RUN", ""),
    "mako_trigger": env_var("MAKO_TRIGGER", ""),
  } -%}
  {%- if mako_fields["mako_dbt_run"] -%}
    {%- do comment_dict.update(mako_source="dbt") -%}
  {%- endif -%}
  {%- for key, value in mako_fields.items() -%}
    {%- if value -%}
      {%- do comment_dict.update({key: value}) -%}
    {%- endif -%}
  {%- endfor -%}
  {{ return(tojson(comment_dict)) }}
{% endmacro %}
`;
