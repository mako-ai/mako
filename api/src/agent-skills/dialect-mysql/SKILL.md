---
name: dialect-mysql
description: Load when writing or debugging MySQL SQL, including backtick identifiers, casts, date arithmetic, CONCAT, REGEXP, LIMIT/OFFSET, and MySQL-specific query syntax.
entities:
  - mysql
  - sql
  - date_format
  - date_sub
  - regexp
  - concat
---

# MySQL SQL dialect

Use this skill for MySQL connections.

## Syntax quick reference

| Feature | MySQL syntax | Notes |
| :--- | :--- | :--- |
| Identifiers | `` `column` ``, `` `database`.`table` `` | Use backticks for reserved or mixed-case names. |
| Type casts | `CAST(x AS type)` | No PostgreSQL `::type`. |
| String concat | `CONCAT(a, b)` | `||` is boolean OR unless SQL mode changes. |
| Pattern match | `LIKE`, `REGEXP` | `REGEXP_LIKE` exists in MySQL 8+. |
| Dates | `DATE_SUB(CURDATE(), INTERVAL 30 DAY)` | Use MySQL interval functions. |
| Formatting | `DATE_FORMAT(created_at, '%Y-%m')` | Good for monthly buckets. |
| Pagination | `LIMIT 500`, `LIMIT 500 OFFSET 1000` | MySQL also supports `LIMIT offset, count`. |

## Example

```sql
SELECT
  DATE_FORMAT(created_at, '%Y-%m') AS month,
  status,
  COUNT(*) AS order_count,
  SUM(total_amount) AS revenue
FROM `orders`
WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
GROUP BY month, status
ORDER BY month, status
LIMIT 500;
```
