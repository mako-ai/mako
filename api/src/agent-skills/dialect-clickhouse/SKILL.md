---
name: dialect-clickhouse
description: Writing or debugging ClickHouse SQL — backtick identifiers, toType casts, concat(), match(), and date helpers like toStartOfMonth/formatDateTime.
entities:
  - clickhouse
  - sql
  - dialect
  - tostartofmonth
  - formatdatetime
---

# ClickHouse dialect

Check `sqlDialect` in tool results before writing SQL. For `clickhouse` use the
following syntax.

| Aspect | Syntax |
| :--- | :--- |
| Identifiers | `` `column` `` (backticks) |
| Type casts | `toUInt32(x)`, `CAST(x, 'Type')` |
| String concat | `concat()` |
| Pattern match | `LIKE`, `match()` (regex) |

## Notes

- Date helpers: `toStartOfMonth(ts)`, `toStartOfWeek(ts)`, `formatDateTime(ts, '%Y-%m')`.
- Window functions may be unavailable on older ClickHouse versions — prefer
  `GROUP BY` aggregations when unsure.
- Casting is function-based (`toUInt32`, `toFloat64`, `toDate`, etc.) rather
  than the Postgres `::` operator.

## Worked example

```sql
SELECT
  product,
  formatDateTime(toStartOfMonth(order_date), '%Y-%m') AS month,
  sum(amount) AS total_sales
FROM orders
WHERE order_status = 'completed'
GROUP BY product, month
ORDER BY product, month
LIMIT 500;
```

Always include `LIMIT 500` unless the user explicitly asks for more.
