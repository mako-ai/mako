---
name: dialect-clickhouse
description: Load when writing or debugging ClickHouse SQL, including backtick identifiers, ClickHouse casts, date bucket functions, string matching, aggregate functions, and engine-specific limitations.
---

# ClickHouse SQL dialect

Use this skill for ClickHouse connections.

## Syntax quick reference

| Feature | ClickHouse syntax | Notes |
| :--- | :--- | :--- |
| Identifiers | `` `column` `` | Backticks are safest for reserved or mixed-case names. |
| Type casts | `toUInt32(x)`, `toString(x)`, `CAST(x, 'Type')` | Prefer typed conversion functions when clear. |
| String concat | `concat(a, b)` | Not PostgreSQL `||`. |
| Pattern match | `LIKE`, `match(value, 'regex')` | `match` uses RE2-style regex. |
| Date bucket | `toStartOfHour(ts)`, `toStartOfDay(ts)`, `toStartOfMonth(ts)` | Use these instead of `date_trunc`. |
| Date format | `formatDateTime(ts, '%Y-%m')` | Similar strftime-style tokens. |
| Conditional aggregate | `countIf(condition)`, `sumIf(value, condition)` | Prefer native combinators for concise analytics. |

Some older ClickHouse versions have limited window function support. If a window query fails, rewrite with grouped subqueries or array functions.

## Example

```sql
SELECT
  toStartOfMonth(created_at) AS month,
  status,
  count() AS order_count,
  sum(total_amount) AS revenue
FROM `orders`
WHERE created_at >= now() - INTERVAL 6 MONTH
GROUP BY month, status
ORDER BY month, status
LIMIT 500;
```
