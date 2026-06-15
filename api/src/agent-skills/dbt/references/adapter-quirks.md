# Adapter quirks

Mako maps connection types to dbt adapters (api/src/dbt/adapter-map.ts):
postgresql / cloudsql-postgres → dbt-postgres, redshift → dbt-redshift,
bigquery → dbt-bigquery, clickhouse → dbt-clickhouse, mysql → dbt-mysql,
mssql → dbt-sqlserver. MongoDB, SQLite, Cloudflare D1/KV are NOT dbt targets.

## Postgres / Cloud SQL Postgres

- `schema` in profiles = the target schema; dev/prod separation is by schema.
- Quoting: dbt lowercases identifiers by default — avoid mixed-case columns.
- `merge` incremental strategy needs PG ≥ 15; otherwise use `delete+insert`.

## BigQuery

- "schema" means dataset; `targetSchema` is the dataset name.
- Always prefer `insert_overwrite` + `partition_by` for large date-partitioned
  facts; `merge` scans the whole table.
- Use `partition_by={'field': 'created_at', 'data_type': 'timestamp'}` and
  `cluster_by` in config for big tables.
- No `interval` arithmetic like Postgres: use `timestamp_sub(current_timestamp(), interval 3 day)`.

## ClickHouse

- Models default to `MergeTree`; set `engine`, `order_by` via config:
  `{{ config(materialized='table', engine='MergeTree()', order_by='(event_date, user_id)') }}`.
- Views are real (not materialized views); incremental uses append-style
  strategies. Consider `ReplacingMergeTree` for dedup semantics instead of
  merge upserts.
- No multi-statement transactions — failed table builds can leave partial
  state; prefer full-refresh on small models.
- Joins are memory-hungry: filter before joining, prefer `IN` over join for
  semi-joins.

## Redshift

- Late-binding views (`bind: false`) avoid dependency breakage when upstream
  tables are rebuilt.
- `dist`/`sort` keys via config: `{{ config(dist='customer_id', sort='created_at') }}`.
- VARCHAR lengths are byte lengths; multibyte text needs headroom.

## MySQL

- dbt-mysql lags on dbt-core 1.7 (separate venv in the Mako runner image) —
  avoid dbt ≥1.8-only features (e.g. new YAML snapshot format, `data_tests:`
  key; use legacy `tests:` in schema.yml for MySQL projects).
- No schemas: the target "schema" IS the database name.
- Window function support requires MySQL 8+.

## SQL Server

- Adapter is dbt-sqlserver via ODBC Driver 18; `trust_cert` is enabled in the
  rendered profile.
- Use `TOP` instead of `LIMIT` in raw SQL previews; dbt handles materialization
  SQL itself.
- Index/clustering via `{{ config(as_columnstore=true) }}` (default for tables).
