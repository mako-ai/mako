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

  - name: revenue_last_7_days # cumulative: trailing window
    label: Revenue, trailing 7 days
    type: cumulative
    type_params:
      measure: order_total
      cumulative_type_params:
        window: 7 days
```

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

`list_metrics({ metrics: ["revenue"] })` lists the exact group-by names a
metric accepts.

## Workflow

1. `list_metrics` / `lookup_term` — does the metric already exist?
2. Add or edit the YAML (and the time spine if the project has none).
3. `dbt_parse` — fix what it reports.
4. Build the models the semantic models read (`dbt_run_model`), time spine
   included.
5. `compile_metric` on the new metric reads the manifest of the last
   **production** build (a project with no production build yet uses its
   latest run), so a new metric shows up there after the change is merged
   and prod has built. Tell the user this.

## Linking a metric to the ontology registry

`lookup_term` attaches a metric to a registry term when the term's name,
label or one of its synonyms equals the metric's name or label (case,
spaces and underscores ignored). Name the metric after the governed term, or
add the metric's name to the term's `synonyms` in `dbt/ontology/terms.yml`.
