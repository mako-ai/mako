# Semantic layer: metrics with MetricFlow

Mako's dbt runtime (dbt Core 1.12) ships MetricFlow. A project that declares
**semantic models** and **metrics** gets each business number defined once:
`list_metrics` shows what exists, `query_metric` returns the rows, and
`compile_metric` returns the SQL for a binding or a console. MetricFlow
writes the aggregation, the joins and the time grain, so no agent or app
re-derives them.

MetricFlow renders SQL for PostgreSQL (incl. Cloud SQL), Redshift and
BigQuery connections. On other warehouses the YAML still parses, but
`compile_metric` and `query_metric` refuse.

## When to add a metric

- A number people ask for by name (revenue, active customers, churn rate).
- A number more than one app, console or agent computes.
- A ratio or a cumulative number: these are the ones hand-written SQL gets
  wrong (average of ratios, fan-out across a join).

Check `lookup_term` and `list_metrics` first: extend a definition that
exists, never add a second one.

## The three pieces

All of it is YAML under `models/` (any `.yml` file; one
`models/semantic/` folder keeps it together). After editing run `dbt_parse`:
the semantic manifest is rebuilt on every parse, and a metric that does not
validate fails the parse with the reason.

### 1. A time spine (once per project)

A model with one row per day. Cumulative metrics and joins to time need it.

```sql
-- models/semantic/metricflow_time_spine.sql  (PostgreSQL)
{{ config(materialized='table') }}
select cast(d as date) as date_day
from generate_series('2015-01-01'::date, '2035-12-31'::date, interval '1 day') as d
```

```sql
-- BigQuery
{{ config(materialized='table') }}
select date_day
from unnest(generate_date_array('2015-01-01', '2035-12-31')) as date_day
```

On Redshift `generate_series` does not run inside a table build: generate
the days with the `dbt_utils.date_spine` macro instead.

```yaml
models:
  - name: metricflow_time_spine
    time_spine:
      standard_granularity_column: date_day
    columns:
      - name: date_day
        granularity: day
```

### 2. Semantic models (one per fact or dimension model)

A semantic model describes one dbt model: its **entities** (join keys), its
**dimensions** (what to group and filter by) and its **measures** (what to
aggregate). Point it at a mart, not at staging.

```yaml
semantic_models:
  - name: orders
    description: One row per order.
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: ordered_at # the date metrics are reported on
    entities:
      - name: order
        type: primary
        expr: order_id
      - name: customer
        type: foreign # joins to the semantic model whose
        expr: customer_id # primary entity is `customer`
    dimensions:
      - name: ordered_at
        type: time
        type_params:
          time_granularity: day
      - name: status
        type: categorical
    measures:
      - name: order_total
        agg: sum
        expr: amount
      - name: order_count
        agg: count
        expr: order_id
      - name: customers_with_orders
        agg: count_distinct
        expr: customer_id

  - name: customers
    description: One row per customer.
    model: ref('dim_customers')
    entities:
      - name: customer
        type: primary
        expr: customer_id
    dimensions:
      - name: region
        type: categorical
      - name: plan
        type: categorical
```

Rules that matter:

- Entity `type`: `primary` (one row per value), `unique`, `foreign` (many
  rows per value). Two semantic models join when they share an entity
  **name**; MetricFlow only joins from the many side to the one side, so a
  metric never fans out.
- `expr` is the column (or a SQL expression) when it differs from `name`.
- Measure `agg`: `sum`, `count`, `count_distinct`, `average`, `min`, `max`,
  `median`, `sum_boolean`, `percentile`.

#### Balances and MRR: `non_additive_dimension`

A measure that is a balance (MRR, ARR, seats, stock, an account balance)
sums across customers but NOT across time: adding 30 daily snapshots of MRR
gives 30 times the MRR. Declare the time dimension it must not be summed
over, and which snapshot of each period to keep:

```yaml
semantic_models:
  - name: subscription_snapshots
    description: One row per account and day.
    model: ref('fct_subscription_daily')
    primary_entity: subscription_snapshot # no single-column key: name one
    defaults:
      agg_time_dimension: snapshot_date
    entities:
      - name: account
        type: foreign
        expr: account_id
    dimensions:
      - name: snapshot_date
        type: time
        type_params:
          time_granularity: day
    measures:
      - name: mrr
        agg: sum
        expr: mrr_amount
        non_additive_dimension:
          name: snapshot_date
          window_choice: max # the LAST snapshot day of each period (min: the first)
          # window_groupings: [account]  → the last snapshot PER account in
          # the period instead: an account whose rows stop mid-month still
          # counts with its last value. Leave it out for end-of-period MRR.

metrics:
  - name: mrr
    label: MRR
    description: Monthly recurring revenue at the end of the period.
    type: simple
    type_params:
      measure: mrr
```

`query_metric({ metrics: ["mrr"], groupBy: ["metric_time__month"] })` then
returns the MRR of the last snapshot day of each month, not the sum of its
days. Without `non_additive_dimension` the same query adds every day up.

### 3. Metrics

```yaml
metrics:
  - name: revenue # simple: one measure
    label: Revenue
    description: Sum of order amounts.
    type: simple
    type_params:
      measure: order_total

  - name: orders
    label: Orders
    type: simple
    type_params:
      measure: order_count

  - name: average_order_value # ratio: sum / sum, never avg of ratios
    label: Average order value
    type: ratio
    type_params:
      numerator: revenue
      denominator: orders

  - name: enterprise_revenue # a filter in the definition
    label: Enterprise revenue
    type: simple
    type_params:
      measure: order_total
    filter: |
      {{ Dimension('customer__plan') }} = 'enterprise'

  - name: active_customers
    label: Active customers
    type: simple
    type_params:
      measure: customers_with_orders

  - name: revenue_per_customer # derived: an expression over metrics
    label: Revenue per customer
    type: derived
    type_params:
      expr: revenue / active_customers
      metrics:
        - name: revenue
        - name: active_customers

  - name: cumulative_revenue # cumulative: all time to date
    label: Cumulative revenue
    type: cumulative
    type_params:
      measure: order_total
      cumulative_type_params:
        period_agg: last # the value at the END of each week, month, …

  - name: revenue_last_7_days # cumulative: trailing window
    label: Revenue, trailing 7 days
    type: cumulative
    type_params:
      measure: order_total
      cumulative_type_params:
        window: 7 days
```

More metric types and options, one example each:

```yaml
metrics:
  - name: revenue_mtd # cumulative, restarting each month (grain_to_date)
    label: Revenue, month to date
    type: cumulative
    type_params:
      measure: order_total
      cumulative_type_params:
        grain_to_date: month # also week, quarter, year. Not with `window`.
        period_agg: last

  - name: revenue_growth_mom # derived over the same metric, shifted in time
    label: Revenue growth, month over month
    type: derived
    type_params:
      expr: (revenue - revenue_prev_month) / revenue_prev_month
      metrics:
        - name: revenue
        - name: revenue
          offset_window: 1 month # the value one month earlier
          alias: revenue_prev_month # the name `expr` calls it by
        # offset_to_grain: month   → the value at the start of the month
        # filter: |                → a filter on this input alone
        #   {{ Dimension('customer__plan') }} = 'enterprise'

  - name: orders_per_day # periods without data report 0, not a missing row
    label: Orders per day
    type: simple
    type_params:
      measure:
        name: order_count
        join_to_timespine: true # one row per period, from the time spine
        fill_nulls_with: 0 #      and 0 where the period has no orders

  - name: visit_to_buy_rate # conversion: a base event followed by another
    label: Visit to purchase rate, 7 days
    type: conversion
    type_params:
      conversion_type_params:
        base_measure:
          name: visits # counted on the semantic model of visits
        conversion_measure:
          name: buys # counted on the semantic model of purchases
        entity: user # both semantic models carry this entity
        calculation: conversion_rate # or `conversions` for the count
        window: 7 days # a purchase counts within 7 days of the visit
        constant_properties: # optional: must be equal on both events
          - base_property: product
            conversion_property: product
```

- `offset_window` and `offset_to_grain` need the time spine and a
  `metric_time` group-by in the query.
- `fill_nulls_with` alone turns a NULL into the value; with
  `join_to_timespine: true` the empty periods become rows too.
- A conversion metric needs two semantic models that share the `entity`, each
  with a time dimension. It can only be grouped by dimensions of the base
  event.

A cumulative metric is computed per day. Grouped by a coarser grain
(`metric_time__month`) it reports ONE day of each period, chosen by
`period_agg`: `first` (the default), `last` or `average`. A running total
almost always wants `last`: without it, a month shows the total as of its
first day.

Always give a metric a `label` and a `description`: `list_metrics` and
`lookup_term` match on them.

## Naming in queries

- `metric_time` is the time axis every metric shares: `metric_time__day`,
  `__week`, `__month`, `__quarter`, `__year`.
- A dimension is named through the entity that reaches it:
  `customer__region` (entity `customer`, dimension `region`).
- In a filter (a metric's `filter:` or the `where` of a query) dimensions go
  through templates: `{{ Dimension('customer__region') }} = 'EU'`,
  `{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'`,
  `{{ Entity('customer') }} = 42`.

- A filter can test another metric per entity with the `Metric` template:
  `{{ Metric('revenue', group_by=['customer']) }} > 1000` keeps the customers
  whose revenue is over 1000.

`list_metrics({ metrics: ["revenue"] })` lists the exact group-by names a
metric accepts, with the smallest grain of each time dimension. A grain
finer than that does not exist: a metric on a monthly model takes
`metric_time__month`, not `metric_time__day`. Metrics that share no
dimension cannot be grouped in one query; `list_metrics` says which split.

## Saved queries

A saved query names a metric query the project wants to keep: metrics,
group-bys, filters.

```yaml
saved_queries:
  - name: weekly_revenue_by_region
    description: Revenue per region and week, enterprise plan.
    query_params:
      metrics:
        - revenue
      group_by:
        - TimeDimension('metric_time', 'week')
        - Dimension('customer__region')
      where:
        - "{{ Dimension('customer__plan') }} = 'enterprise'"
```

`list_metrics` returns the saved queries with their metrics, group-bys and
filters. To run one, pass them to `query_metric` with the group-bys in query
form: `groupBy: ["metric_time__week", "customer__region"]`.

## Limits

What `query_metric` and `compile_metric` do and refuse at run time:

- **Rows.** `query_metric` appends `LIMIT 500` when the query names no
  `limit`. When 500 rows come back the result carries `limited: true` and
  `rowLimit: 500`: more rows exist and totals over the result are wrong.
  Pass `limit` (up to 10000) with `orderBy`, or cut the rows with `where`,
  `startTime`/`endTime`, fewer group-bys or a coarser grain. The table shows
  50 rows by default, `maxRows` up to 200. The `sql` returned is the SQL
  that ran, LIMIT included; `compile_metric` returns it without.
- **Time.** In the product, compiling may take 60 s and the query 60 s. Over
  MCP both share 45 s. A query that needs longer: `compile_metric`, put the
  SQL in a console, `run_console`.
- **Dates.** `startTime` and `endTime` are a date (`2026-01-01`) or a
  datetime without a timezone (`2026-01-01T00:00:00`). An offset (`+02:00`,
  `Z`) is refused: `metric_time` has no timezone. `startTime` after
  `endTime` is refused. Both bounds are inclusive and widened to whole
  periods of the grain grouped by.
- **`where` is raw SQL.** Only the templates are resolved; the rest is
  copied into the statement. Each filter is wrapped in parentheses and the
  filters are ANDed, so `a or b` in one filter stays one condition. The
  compiled statement must pass the read-only check (one SELECT/WITH, no
  second statement, no write keyword), for `compile_metric` as for
  `query_metric`.
- **Connection.** The SQL runs on the warehouse of the dbt environment that
  built the manifest: its read connection when the environment names one
  (`read_connection_id` in `dbt/environments.yml`, or Read connection in the
  project settings), else the connection dbt builds with. It always runs
  read-only. The result says which: `connectionRole: "read" | "build"`.
- **BigQuery bytes.** A metric query that would bill more than the agent
  byte cap (500 GiB unless the connection or operator changed it) is refused before it runs.
  Narrow the time range, or partition the model on its time dimension.
- **BigQuery time types.** Metrics queried together must have time
  dimensions of ONE type. A DATE-based and a TIMESTAMP-based `metric_time`
  fail to join: `No matching signature for operator = for argument types:
  DATETIME, TIMESTAMP`. Give every `agg_time_dimension` the same type in the
  semantic models (`expr: date(created_at)`), or query the metrics
  separately.
- **Result values.** Timestamps come back as ISO 8601
  (`2026-10-12T00:00:00Z`; a DATETIME has no `Z`). Floats are rounded to 15
  significant digits, which removes binary noise (`1574958.9400000046` →
  `1574958.94`).
- **Errors.** An unknown group-by answers with every valid group-by of the
  metrics and the smallest grain of `metric_time`. An unknown environment or
  projectId answers with the valid ones.

## Workflow

1. `list_metrics` / `lookup_term` — does the metric already exist?
2. Add or edit the YAML (and the time spine if the project has none).
3. `dbt_parse` — fix what it reports.
4. Build the models the semantic models read (`dbt_run_model`), time spine
   included.
5. Try it before merging: `list_metrics`, `compile_metric` and
   `query_metric` take `environment`. Pass the environment you ran
   `dbt_parse` and built the models in (your personal dev one) and they read
   that run's definitions and relations.
6. Without `environment` the tools read the last **production** build (a
   project with no production build yet uses its latest run), so everyone
   else sees the new metric after the change is merged and prod has built.
   Tell the user this.

## Linking a metric to the ontology registry

`lookup_term` attaches a metric to a registry term when the term's name,
label or one of its synonyms equals the metric's name or label (case,
spaces and underscores ignored). Name the metric after the governed term, or
add the metric's name to the term's `synonyms` in `dbt/ontology/terms.yml`.
