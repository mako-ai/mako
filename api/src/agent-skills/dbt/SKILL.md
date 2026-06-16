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
environments. The agent edits files with `create_dbt_file` / `modify_dbt_file`
and verifies with `dbt_parse` → `dbt_compile_model` → `dbt_run_model`.

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
3. `dbt_run_model` on dev — reports per-node status, timing, rows affected,
   and test outcomes. Surface these to the user.
4. Preview built tables with `sql_execute_query`
   (`select * from <dev_schema>.<model> limit 100`).

## Environments and jobs

- Projects have environments (dev/prod) mapping to a workspace connection +
  target schema. Ad-hoc agent builds ALWAYS default to dev.
- Jobs are saved command lists (`build`, `test`, `seed`, `snapshot`,
  `source freshness`, `docs generate` + `--select/--exclude/--full-refresh`
  flags) with optional cron schedules. Trigger via `dbt_run_job` only after
  explicit user confirmation.

## Tier-3 references

Load with `read_skill_resource` when needed:

- `references/incremental-strategies.md` — incremental models, is_incremental(),
  unique_key, strategy per adapter, full refresh.
- `references/snapshots.md` — SCD2 snapshots, timestamp vs check strategy.
- `references/adapter-quirks.md` — Postgres/BigQuery/ClickHouse/MySQL/
  Redshift/SQL Server differences that affect model SQL and configs.
