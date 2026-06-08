---
name: dialect-bigquery
description: Load when writing or debugging BigQuery SQL, including project.dataset.table names, backtick identifiers, date formatting, casts, regex functions, and BigQuery-specific query limits.
entities:
  - bigquery
  - google bigquery
  - sql
  - dataset
  - project.dataset
  - safe_cast
  - regexp_contains
---

# BigQuery SQL dialect

Use this skill for Google BigQuery connections.

## Syntax quick reference

| Feature | BigQuery syntax | Notes |
| :--- | :--- | :--- |
| Identifiers | `` `project.dataset.table` `` or `` `column` `` | Fully qualify tables when project/dataset is known. |
| Type casts | `CAST(x AS type)`, `SAFE_CAST(x AS type)` | Prefer `SAFE_CAST` for dirty data. |
| String concat | `CONCAT(a, b)` | `||` also works in Standard SQL, but `CONCAT()` is explicit. |
| Pattern match | `REGEXP_CONTAINS(value, r'pattern')` | Use raw regex strings with `r''`. |
| Dates | `DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)` | Use BigQuery date/time functions. |
| Formatting | `FORMAT_DATE('%Y-%m', order_date)` | Use `FORMAT_TIMESTAMP` for timestamps. |
| Arrays/structs | `UNNEST(array_col)` | Use aliases when unnesting repeated fields. |

Avoid relying on PostgreSQL-specific casts (`::type`) or interval syntax. Be careful with subqueries and always test the BigQuery dialect returned by inspection tools.

## Example

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

This calculates monthly sales by product using BigQuery backtick identifiers and `FORMAT_DATE`.
