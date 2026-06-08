---
name: dialect-sqlite
description: Load when writing or debugging SQLite or Cloudflare D1 SQL, including no-schema table names, dynamic typing, date/time functions, strftime, boolean values, UPSERT, and LIMIT syntax.
entities:
  - sqlite
  - cloudflare d1
  - d1
  - sql
  - strftime
  - datetime
  - upsert
---

# SQLite and Cloudflare D1 SQL dialect

SQLite, including Cloudflare D1, has unique syntax requirements.

## Syntax quick reference

| Feature | SQLite syntax | Notes |
| :--- | :--- | :--- |
| No schemas | Tables are directly in database | No `schema.table` prefix needed. |
| Identifiers | `"column"` | Identifiers are case-insensitive unless quoted. |
| Data types | Dynamic typing with affinities | TEXT, INTEGER, REAL, BLOB, NULL. |
| Date/time | `date()`, `time()`, `datetime()`, `julianday()`, `strftime()` | No native DATE type. |
| Date formatting | `strftime('%Y-%m', created_at)` | Similar to C strftime. |
| Date arithmetic | `datetime('now', '-7 days')` | Use modifiers like `'-1 month'`, `'+1 year'`. |
| String concat | `||` | Do not use `+` or `CONCAT()`. |
| Boolean | `0` and `1` | No native TRUE/FALSE storage class. |
| UPSERT | `INSERT OR REPLACE` or `INSERT ... ON CONFLICT` | Different from PostgreSQL. |

## Example

```sql
-- database: my-d1-database
SELECT
    id,
    username,
    email,
    created_at
FROM users
WHERE datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 500;
```
