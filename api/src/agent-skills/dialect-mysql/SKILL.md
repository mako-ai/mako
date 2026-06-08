---
name: dialect-mysql
description: Writing or debugging MySQL SQL — backtick identifiers, CAST, CONCAT, LIKE/REGEXP, and subquery/LIMIT caveats.
entities:
  - mysql
  - sql
  - dialect
  - concat
  - regexp
---

# MySQL dialect

Check `sqlDialect` in tool results before writing SQL. For `mysql` use the
following syntax.

| Aspect | Syntax |
| :--- | :--- |
| Identifiers | `` `column` `` (backticks) |
| Type casts | `CAST(x AS type)` |
| String concat | `CONCAT()` |
| Pattern match | `LIKE`, `REGEXP` |
| Notes | `LIMIT` without `OFFSET` requires no subquery wrapping |

## Worked example

```sql
SELECT
  `product`,
  DATE_FORMAT(`order_date`, '%Y-%m') AS month,
  SUM(`amount`) AS total_sales
FROM orders
WHERE order_status = 'completed'
GROUP BY product, month
ORDER BY product, month
LIMIT 500;
```

Always include `LIMIT 500` unless the user explicitly asks for more.
