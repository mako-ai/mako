---
name: dbt
description: Load when building, editing, running, or debugging dbt models, dbt projects, schema.yml tests, sources, seeds, snapshots, incremental models, materializations, or dbt jobs in the Transforms section.
entities:
  - dbt
  - transform
  - transforms
  - model
  - models
  - staging
  - marts
  - schema.yml
  - ref
  - source
  - materialization
  - incremental
  - snapshot
  - seed
  - dbt job
  - dbt run
  - dbt build
  - dbt test
---

# dbt in Mako (Transforms)

Mako runs dbt Core projects whose files live in the workspace database (one
document per file) and execute as subprocesses against the project's warehouse
environments. The agent creates files with `create_dbt_file`, modifies existing
ones with `edit_dbt_file` (anchored `oldString`/`newString` replacement — the
match must be unique; include surrounding lines to disambiguate, `""` deletes,
`replaceAll: true` renames), reserves `modify_dbt_file` (COMPLETE contents) for
full rewrites, and verifies with `dbt_parse` → `dbt_compile_model` →
`dbt_run_model`.

## Project layout

```text
dbt_project.yml        # project config — name, model defaults
models/
  staging/             # 1:1 source cleanup, materialized as views
    schema.yml         # sources + staging model tests
    stg_<src>_<entity>.sql
  marts/               # business-facing models, materialized as tables
    <mart>.sql
seeds/                 # small CSV reference data (dbt seed)
macros/                # Jinja macros
snapshots/             # SCD2 snapshots (see references/snapshots.md)
tests/                 # singular SQL tests
```

## Core concepts

- `{{ ref('model_name') }}` — reference another model. Builds the DAG; never
  hard-code schema-qualified names between models.
- `{{ source('source_name', 'table_name') }}` — reference a raw table declared
  under `sources:` in a schema.yml. Always declare sources before using them.
- Materializations: `view` (default for staging), `table`, `incremental`,
  `ephemeral`. Set per folder in `dbt_project.yml` or per model with
  `{{ config(materialized='table') }}`.

## Staging model conventions

```sql
-- models/staging/stg_shop_orders.sql
with source as (
    select * from {{ source('shop', 'orders') }}
),
renamed as (
    select
        id          as order_id,
        customer_id,
        status,
        total_cents / 100.0 as total_amount,
        created_at
    from source
)
select * from renamed
```

- One staging model per source table, named `stg_<source>_<entity>`.
- Rename to snake_case, cast types, convert cents→currency, no joins.
- Marts join staging models, never raw sources.

## schema.yml — sources + tests

```yaml
version: 2

sources:
  - name: shop
    schema: public          # where the raw tables live
    tables:
      - name: orders
      - name: customers

models:
  - name: stg_shop_orders
    columns:
      - name: order_id
        data_tests:
          - unique
          - not_null
      - name: status
        data_tests:
          - accepted_values:
              values: ['pending', 'paid', 'shipped', 'cancelled']
      - name: customer_id
        data_tests:
          - relationships:
              to: ref('stg_shop_customers')
              field: customer_id
```

`dbt_run_model` runs `dbt build --select <model>`, which executes the model
AND its tests — always add at least `unique` + `not_null` on the primary key.

## Verification loop (mandatory)

1. `dbt_parse` after YAML edits — catches bad refs, undeclared sources,
   malformed schema.yml without touching the warehouse.
2. `dbt_compile_model` — renders the Jinja; read the compiled SQL to confirm
   it targets the right relations.
3. `dbt_run_model` on dev — runs ASYNCHRONOUSLY in the runner and returns a
   `runId` immediately (it does NOT wait for the build). Then call
   `dbt_get_run({ runId, waitMs: 90000 })` ONCE to wait for the result:
   - terminal (`success`/`error`) → surface per-node status, timing, rows
     affected, and test outcomes to the user.
   - still `running`/`queued` after the wait → tell the user the build is
     still in progress (the run card shows live logs/status); do NOT keep
     polling in a tight loop. Poll again only if the user asks.
4. Preview built tables with `sql_execute_query`
   (`select * from <dev_schema>.<model> limit 100`) — only after the run
   reaches `success`.

> ALWAYS invoke these as real tool calls. NEVER write a tool name or its
> arguments (`projectId`, `runId`, `waitMs`, etc.) as message text — e.g. do
> not type `dbt_get_run <projectId> <runId> 60000` into your reply. If you want
> to check a run, emit a `dbt_get_run` tool call; the user already sees live
> progress in the run card. After a run finishes, reply with a short
> human-readable summary, not raw IDs.

## Environments and jobs

- Projects have environments (dev/prod) mapping to a workspace connection +
  target schema. Ad-hoc agent builds resolve their environment PER USER:
  saved per-user dev environment (the UI env pickers persist this setting) >
  personal environment > project default. Omit `environment` unless the user
  explicitly picks one.
- **Single vs multi player — keep this clear:**
  - SINGLE-USER workspace: the shared dev environment IS the user's personal
    target. Drafts and branch verification build against dev; do NOT
    provision `dbt_<user>` schemas unless the user asks for isolation.
  - MULTI-USER workspace: each user tests against their OWN environment.
    `dbt_run_model` auto-provisions a personal one (schema `dbt_<user>`) on
    the first build so teammates never build over each other's schemas.
- **Drafts are per user AND per branch (git-worktree semantics)**:
  uncommitted edits stay with the branch they were made on. Switching
  branches (`dbt_switch_branch`) is always safe — each branch's
  work-in-progress is intact when you switch back, and nothing mixes across
  branches. This means the user can iterate on several branches in parallel.
  Consequences to keep straight:
  - `dbt_git_status` shows ONLY the current branch's pending changes; work
    stashed on another branch is invisible until you switch to it.
  - `dbt_create_branch` is `git checkout -b`: the current dirty tree moves to
    the new branch.
  - Deleting a branch (`dbt_delete_branch`, or `deleteBranch` on close/merge
    of a PR) drops the drafts stashed on it — except a PR merge, which moves
    them to the default branch with the user.
  - `dbt_compare_branches` diffs any branch against a base without switching
    checkouts (ahead/behind, changed files, that branch's PRs). Its
    `fullyMergedIntoBase` flag detects squash/rebase merges too — check it
    before deleting a branch during cleanup.
  - `discardLocalChanges` (on switch/sync) only discards the branch being
    left / the current branch — never other branches' stashes.
- **Which git tree a run builds (repo-bound projects)** — never mix these up:
  - Ad-hoc tools (`dbt_parse`, `dbt_compile_model`, `dbt_show`,
    `dbt_run_model`) build YOUR working tree: your checkout branch + your
    uncommitted drafts on that branch. This is the ONLY way to verify
    uncommitted or feature-branch work.
  - Jobs (`dbt_run_job`, schedules) build the COMMITTED tracked branch only —
    never your checkout or drafts. Triggering a job to test a draft silently
    runs the OLD code; do not do it, and do not "fix" it by committing — the
    job still builds the tracked branch, not your feature branch.
  - **Full refresh of a draft**: pass `fullRefresh: true` to `dbt_run_model`
    (adds `--full-refresh`). Never reach for a full-refresh job to rebuild an
    incremental model you just edited.
- **Prod is protected from ad-hoc runs**: on repo-connected projects the
  prod-like environment refuses ad-hoc warehouse writes (`run`/`build`/
  `seed`/`snapshot`). Deploys go through jobs or CI after the change is
  merged into the tracked branch. Read-only commands (parse/compile/show)
  still work against any environment.
- **Personal environments**: per-user environments (schema `dbt_<user>`, same
  connection as prod). In MULTI-USER workspaces `dbt_run_model`
  auto-provisions the caller's on its first build;
  `dbt_ensure_dev_environment` provisions it explicitly ahead of time. Once
  it exists, `dbt_parse` / `dbt_compile_model` / `dbt_run_model` / `dbt_show`
  default to it. Feature-branch verification builds into the user's dev
  environment (dev itself when solo, personal when in a team); prod stays a
  jobs-only deploy target.
- **Defer (fast iteration)**: ad-hoc builds default to
  `--defer --state <last prod manifest>` when targeting a non-prod environment
  and a prod build exists — unselected `ref()`s resolve to prod relations, so
  ONE model can be rebuilt in a personal schema without first rebuilding its
  whole upstream DAG there. Pass `defer: false` to disable (e.g. when you
  intentionally rebuilt an upstream model in the same schema and want refs to
  use it).
- Jobs are saved command lists (`build`, `test`, `seed`, `snapshot`,
  `source freshness`, `docs generate` + `--select/--exclude/--full-refresh`
  flags) with optional cron schedules. Trigger via `dbt_run_job` only after
  explicit user confirmation, and only for committed work — never to verify
  drafts.

## Iterating on models that feed apps (dev → prod loop)

App data bindings can link to a dbt project (`dbtProjectId` on the binding)
and reference the build schema via the `{{ dbt_schema }}` token instead of a
hardcoded `dbt_prod.` prefix. Published apps, parquet materialization, and
public shares ALWAYS resolve the token to the prod-like environment; only the
draft preview can be switched.

The full safe-iteration loop:

1. Edit models; verify with `dbt_parse` → `dbt_compile_model` →
   `dbt_run_model` (defaults: the user's dev environment — dev itself when
   solo, personal `dbt_<user>` in teams (auto-provisioned on first build) —
   + defer to prod manifest).
2. `app_set_preview_environment` with the personal environment — the app's
   DRAFT preview now reads the freshly built schema. This is per-user view
   state: other editors, the published app, and shared links keep reading
   prod. Verify visually (screenshot) if useful.
3. Promote the dbt change: `dbt_commit_to_branch` → `dbt_open_pull_request` →
   (after review) `dbt_merge_pull_request`; then run the prod job via
   `dbt_run_job` — ONLY with explicit user confirmation.
4. After the prod build succeeds, reset the preview
   (`app_set_preview_environment` with `environment: null`) and, if app code
   changed, publish with `app_save_version`.

## Tier-3 references

Load with `read_skill_resource` when needed:

- `references/incremental-strategies.md` — incremental models, is_incremental(),
  unique_key, strategy per adapter, full refresh.
- `references/snapshots.md` — SCD2 snapshots, timestamp vs check strategy.
- `references/adapter-quirks.md` — Postgres/BigQuery/ClickHouse/MySQL/
  Redshift/SQL Server differences that affect model SQL and configs.
