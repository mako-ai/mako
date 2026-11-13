---
name: dbt-jobs
description: Load when creating, editing, scheduling, running, or debugging dbt jobs and production deployments.
entities:
  - dbt job
  - schedule
  - cron
  - production
  - deploy
  - run job
  - source freshness
  - run history
  - failed run
  - skipped run
  - model cost
  - table readers
  - orphan tables
  - full refresh
  - vars
---

# dbt jobs and production runs

Jobs execute the workspace repo's DEFAULT branch (`main`). They never build
the acting user's session branch.

## Required flow

1. Use ad-hoc `dbt_parse`, `dbt_compile_model`, `dbt_show`, and
   `dbt_run_model` to verify session-branch changes in the user's development
   environment.
2. Commit, review, and merge through the dbt Git workflow.
3. Trigger `dbt_run_job` only after the user explicitly confirms the job and
   the approved plan includes production execution.
4. Poll once with `dbt_get_run`; report terminal node/test outcomes or say the
   run remains active.

Never use a job to test a draft—it silently runs older committed code.

## Per-run inputs

`dbt_run_job` takes two optional inputs. They apply to that run only and are
never written to the job or its yml.

- `vars`: dbt vars merged over the environment's vars, e.g. a backfill window
  `{ "start_date": "2026-01-01" }`. Keys are identifiers, at most 50 keys and
  4 KB, JSON values nested at most 5 levels. Refused when a job command
  already declares `--vars`.
- `fullRefresh: true`: adds `--full-refresh` to the job's `run`, `build` and
  `seed` commands. On production this drops and rebuilds every incremental
  table the job selects. Say so, and get the user's confirmation for the
  full refresh itself, not only for the job. Refused when the job has no
  `run`, `build` or `seed` command.

A rejected input returns an error and queues nothing. The run records what it
used: `dbt_get_run` and `dbt_list_runs` return `overrides` and the final
`commands`.

## Run history

- `dbt_list_runs({ projectId })` lists runs newest first: status, trigger,
  timings, `stepCounts` and a 300-character error. Filter with `jobId`,
  `status` (`error` for failures) and `trigger` (`schedule`, `manual`,
  `agent`, `ci`). It returns 20 runs by default and 100 at most; pass
  `nextBefore` back as `before` for older runs. History covers the retention
  window (30 days by default).
- Use it to answer "did it run", "how often does it fail" and "how long does
  it take". Then call `dbt_get_run({ runId })` on the one run whose steps or
  logs matter. Do not page the whole history to find one failure: filter.
- With `jobId` the result carries `skipped`: scheduled ticks that started no
  run, and `lastReason`. `active_run`: the previous run of that job was
  still active. Fix the cause (a schedule shorter than the run, or a queue
  behind another job), not the counter. `disabled_in_file`,
  `unscheduled_in_file` and `definition_missing`: the job file on the
  default branch turned the schedule off or was deleted, and the tick fired
  before Mako had read the push. Nothing to fix.
- `enabled: false` stops scheduled runs only. `dbt_run_job` still runs a
  disabled job when the user asks for it.
- `dbt_run_job` takes `projectId`, `jobId`, `vars` and `fullRefresh`. Any
  other input (`full_refresh`, `overrides`) is refused and nothing runs.
- `definitionSha` on a job run is the commit its `dbt/jobs/<slug>.yml` was
  read from. It equals `sourceSha` when the commands and the models came from
  the same commit.

## Cost, readers, leftovers

Three read-only tools read warehouse metadata. Each runs one bounded
metadata query and never starts a dbt run.

- `dbt_model_cost({ projectId, days?, jobId?, runId?, model? })`: bytes
  billed and slot milliseconds per model per day for Mako's dbt runs. Use it
  to rank models by cost or to price one job, one run or one model. `model`
  takes a dbt unique_id (`model.analytics.fct_orders`) or a bare model name
  (`fct_orders`). Rows add `invocations` (dbt commands that ran the model
  that day) and `avgDurationMs` (mean time of one warehouse job). `rows`
  come most expensive first (bytes billed, then slot milliseconds) and hold
  at most `limit` model-days. Quote `totals`, never a sum of `rows`:
  `totals` and `totalRows` cover the whole window, and `truncated: true`
  says `rows` is cut. A job counts only through the run ids and invocation
  ids of the chosen environment's runs, so a job of the same name in another
  project or workspace adds nothing. Read `notes` before quoting a total.
- `dbt_table_readers({ projectId, relation: { schema, name } })`: who read a
  relation, grouped by Mako source, app and account. Admins and owners only:
  the rows hold account emails. Call it before a model or table is dropped,
  renamed or changed in shape. A read through a downstream view is
  invisible: the warehouse job names that other view. Call the tool again
  for every view built on the relation. `jobsByTextOnly` counts the jobs
  matched on the name in the query text only, which is how a view is found.
  Pass `notes` and `warning` to the user. Read `conclusive` before saying a
  table is unused: it is `false` when only one account was visible or when
  the region was guessed.
- `dbt_list_orphans({ projectId })`: relations in the project's schemas that
  no model, seed or snapshot owns. It drops nothing, and Mako has no tool
  that drops them. The list holds candidates: other tools' tables in the same
  schema, dbt test-audit tables and branch builds appear in it. Each orphan
  carries `confidence` (`high`, `medium`, `low`) and `reasons`, the
  false-positive classes that apply to it. Present `high` rows as likely
  leftovers and quote the reasons of the others. Read `manifestAgeHours`,
  `stale` and `warnings` first: a stale manifest lists models added since by
  mistake. A schema with no remaining model is skipped. `schemasMissing`
  names schemas the manifest writes to that the warehouse lacks. `skipped`
  counts the sources and stored test failures left out. `orphanCount`,
  `orphanBytes` and `confidenceCounts` cover every orphan found. `orphans`
  lists the first `limit` (default 200) by confidence, then size;
  `truncated` and `listed` say when the list is cut. Check
  `dbt_table_readers` on a candidate and let the user decide.

Read every answer's scope before quoting it:

- `supported: false` means the engine has no such metadata, or no successful
  run exists yet. Report the `message`. Do not retry and do not rebuild the
  answer with hand-written SQL.
- `scope: "project"` covers every account in the warehouse project.
- `region` is the warehouse region whose job history was read. Job history
  is per region. `regionSource: "dataset"` or `"connection"` is a known
  region. `regionSource: "default"` is a guess: the dataset's location could
  not be read and the connection sets none. An empty answer from a guessed
  region proves nothing. Say so, and ask for the location to be set on the
  connection.
- `scope: "user"` is the fallback to the connection's own account. Mako's
  own work (dbt runs, app bindings, consoles) is visible; BI tools, analysts
  and other service accounts are not. "No readers" on that scope does not
  mean the table is unused. Pass the `warning` to the user: it names the
  missing permission and the grant command, which only a warehouse admin can
  run.
- Both job-history tools look back 7 days by default and 30 at most.

Model cost matches warehouse jobs to runs through the invocation ids stored
on each run, so it needs no project change. To also label every warehouse job
with the Mako job, run and trigger, add the query-comment macro documented
in the Transforms docs (`transforms.md#run-identity-and-warehouse-labels`).
The macro reads `MAKO_DBT_JOB` (the job id), `MAKO_DBT_JOB_SLUG`,
`MAKO_DBT_RUN` and `MAKO_TRIGGER` and also
labels the job `mako_source: "dbt"`, the source `dbt_table_readers` groups
by. New projects get it from the scaffold; Mako never edits an existing
project's `dbt_project.yml`.

## Job definitions

- Add or change a cron schedule only when the user requests recurring
  execution.
- Deleting a job is destructive and requires explicit approval.
- Keep job commands within the supported dbt command allowlist.
- A full refresh for an edited incremental model belongs on
  `dbt_run_model({ fullRefresh: true })` during development, not on a
  production job.

## Environments

- Ad-hoc builds use the caller's saved or personal development environment.
- Production-like environments reject ad-hoc writes.
- Jobs are the deployment path after committed changes reach the tracked
  branch.
