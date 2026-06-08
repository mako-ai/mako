---
name: dialect-bigquery
description: Writing or debugging BigQuery SQL — backtick identifiers, CAST, CONCAT, REGEXP_CONTAINS, FORMAT_DATE, and a worked monthly-aggregation example.
entities:
  - bigquery
  - sql
  - dialect
  - format_date
  - regexp_contains
---

# BigQuery dialect

Check `sqlDialect` in tool results before writing SQL. For `bigquery` use the
following syntax.

| Aspect | Syntax |
| :--- | :--- |
| Identifiers | `` `column` `` (backticks) |
| Type casts | `CAST(x AS type)` |
| String concat | `CONCAT()` |
| Pattern match | `REGEXP_CONTAINS()` |
| Notes | No `LIMIT` allowed inside subqueries |

## Worked example

```sql
-- project: my_proj, dataset: analytics
SELECT
  product,
  FORMAT_DATE('%Y-%m', order_date) AS month,
  SUM(amount) AS total_sales
FROM `my_proj.analytics.orders`
WHERE order_status = 'completed'
  AND order_date >= '2024-01-01' AND order_date < '2025-01-01'
GROUP BY product, month
ORDER BY product, month
LIMIT 500;
```

Calculates monthly sales by product using BigQuery's backtick identifiers and
`FORMAT_DATE`. Always include `LIMIT 500` unless the user explicitly asks for
more.
