---
name: dialect-postgresql
description: Load when writing or debugging PostgreSQL or Cloud SQL PostgreSQL SQL queries, including schema-qualified tables, date intervals, casts, JSON, arrays, pattern matching, and LIMIT syntax.
entities:
  - postgres
  - postgresql
  - cloudsql-postgres
  - cloud sql
  - sql
  - jsonb
  - array
  - interval
---

# PostgreSQL SQL dialect

Use this skill for PostgreSQL and Cloud SQL for PostgreSQL connections.

## Syntax quick reference

| Feature | PostgreSQL syntax | Notes |
| :--- | :--- | :--- |
| Identifiers | `"column"`, `"schema"."table"` | Use double quotes for mixed-case or reserved words. |
| Type casts | `value::type` or `CAST(value AS type)` | `::` is idiomatic. |
| String concat | `||` | `CONCAT()` also exists but `||` is portable in Postgres. |
| Pattern match | `ILIKE`, `LIKE`, `~`, `~*` | `ILIKE` is case-insensitive; regex uses `~`. |
| Dates | `CURRENT_DATE - INTERVAL '1 month'` | Use interval literals for relative windows. |
| JSON | `->`, `->>`, `jsonb_extract_path_text` | Use `->>` when comparing text. |
| Arrays | `ANY(array_col)`, `unnest(array_col)` | Prefer explicit casts for array literals when needed. |

## Example

```sql
-- database: production
SELECT
    o.order_id,
    o.order_date,
    o.total_amount,
    c.customer_name,
    c.email,
    c.country
FROM
    sales.orders o
    JOIN sales.customers c ON o.customer_id = c.customer_id
WHERE
    o.order_date >= CURRENT_DATE - INTERVAL '1 month'
    AND o.order_date < CURRENT_DATE
ORDER BY
    o.order_date DESC
LIMIT 500;
```

This retrieves orders from the last month with customer details, using schema-qualified table names.
