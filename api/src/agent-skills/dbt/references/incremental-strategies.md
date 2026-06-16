# Incremental models

Use `incremental` materialization when a table is too large to rebuild every
run. The model only processes new/changed rows after the first build.

## Skeleton

```sql
{{ config(
    materialized='incremental',
    unique_key='event_id',
    on_schema_change='append_new_columns'
) }}

select
    event_id,
    user_id,
    event_type,
    occurred_at
from {{ source('app', 'events') }}

{% if is_incremental() %}
  -- this filter only applies on incremental runs; `this` is the existing table
  where occurred_at > (select coalesce(max(occurred_at), '1970-01-01') from {{ this }})
{% endif %}
```

Rules:

- `is_incremental()` is false on the first run and after `--full-refresh`.
- Always use a monotonically increasing column (timestamp, sequence id) in the
  incremental filter; add a small lookback window (`occurred_at > ... - interval '3 days'`)
  when late-arriving data is possible.
- `unique_key` enables merge/upsert semantics; without it, rows are appended.

## Strategy per adapter

| Adapter | Default | Notes |
|---|---|---|
| dbt-postgres | `append` (no unique_key) / `delete+insert` | `merge` available on PG 15+ |
| dbt-bigquery | `merge` | `insert_overwrite` with `partition_by` is much cheaper for date-partitioned facts |
| dbt-clickhouse | `default` (append) | `delete+insert` and `insert_overwrite` available; ReplacingMergeTree often replaces the need for merge |
| dbt-redshift | `append` / `delete+insert` | no real merge until RA3 merge support |
| dbt-mysql | `delete+insert` | dbt-mysql is on dbt-core 1.7; avoid newer config keys |
| dbt-sqlserver | `merge` | |

Set explicitly when it matters:

```sql
{{ config(materialized='incremental', incremental_strategy='delete+insert', unique_key='id') }}
```

## Full refresh

A job command `run --select my_model --full-refresh` rebuilds the table from
scratch. Recommend a scheduled weekly full refresh for models with mutable
history when using append-only strategies.
