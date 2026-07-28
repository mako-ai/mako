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
---

# dbt jobs and production runs

Jobs execute the committed tracked branch. They never include the acting
user's checkout branch or uncommitted drafts.

## Required flow

1. Use ad-hoc `dbt_parse`, `dbt_compile_model`, `dbt_show`, and
   `dbt_run_model` to verify working-tree changes in the user's development
   environment.
2. Commit, review, and merge through the dbt Git workflow.
3. Trigger `dbt_run_job` only after the user explicitly confirms the job and
   the approved plan includes production execution.
4. Poll once with `dbt_get_run`; report terminal node/test outcomes or say the
   run remains active.

Never use a job to test a draft—it silently runs older committed code.

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
