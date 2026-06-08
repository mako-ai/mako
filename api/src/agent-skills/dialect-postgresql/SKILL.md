---
name: dialect-postgresql
description: Writing or debugging PostgreSQL (or Cloud SQL Postgres / Redshift) SQL — identifier quoting, type casts, string concat, pattern matching, and a worked query example.
entities:
  - postgresql
  - postgres
  - cloudsql-postgres
  - redshift
  - sql
  - dialect
---

# PostgreSQL dialect

Check `sqlDialect` in tool results before writing SQL. For PostgreSQL
(`postgresql`, `cloudsql-postgres`, `redshift`) use the following syntax.

| Aspect | Syntax |
| :--- | :--- |
| Identifiers | `"column"` (double quotes) |
| Type casts | `value::type` |
| String concat | `\|\|` |
| Pattern match | `ILIKE`, `~` (regex) |
| Notes | Arrays and JSON/JSONB operators available |

## Worked example

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

Retrieves orders from the last month with customer details, using
schema-qualified table names. Always include `LIMIT 500` unless the user
explicitly asks for more.
