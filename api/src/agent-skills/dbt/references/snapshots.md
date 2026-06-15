# Snapshots (SCD Type 2)

Snapshots record how mutable source rows change over time. dbt adds
`dbt_valid_from` / `dbt_valid_to` columns; the current row has
`dbt_valid_to IS NULL`.

## Definition (dbt 1.9 YAML style)

`snapshots/orders_snapshot.yml`:

```yaml
snapshots:
  - name: orders_snapshot
    relation: source('shop', 'orders')
    config:
      schema: snapshots
      unique_key: id
      strategy: timestamp
      updated_at: updated_at
```

Legacy SQL block style (still supported, lives in `snapshots/*.sql`):

```sql
{% snapshot orders_snapshot %}
{{ config(
    target_schema='snapshots',
    unique_key='id',
    strategy='timestamp',
    updated_at='updated_at'
) }}
select * from {{ source('shop', 'orders') }}
{% endsnapshot %}
```

## Strategy choice

- `timestamp` (preferred): needs a reliable `updated_at` column.
- `check`: compares listed columns (`check_cols: ['status', 'amount']`) — use
  when there is no trustworthy updated_at; more expensive.

## Operating

- Run via a job command `snapshot` (validated by the command allowlist).
- Snapshots should run on a schedule (e.g. hourly/daily job) — gaps in
  snapshot runs are unrecorded history.
- Downstream models select the current version with
  `where dbt_valid_to is null`, or join on validity ranges for point-in-time
  analysis.
