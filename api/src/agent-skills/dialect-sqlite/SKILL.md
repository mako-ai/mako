---
name: dialect-sqlite
description: Writing or debugging SQLite or Cloudflare D1 SQL — no schemas, dynamic typing, date/time functions, string concat, booleans, UPSERT, and a worked example.
entities:
  - sqlite
  - cloudflare-d1
  - d1
  - sql
  - dialect
  - strftime
---

# SQLite dialect (including Cloudflare D1)

Check `sqlDialect` in tool results before writing SQL. For `sqlite` and
`cloudflare-d1` use the following syntax. SQLite has several unique
requirements.

| Feature | SQLite syntax | Notes |
| :--- | :--- | :--- |
| **No schemas** | Tables are directly in the database | No `schema.table` prefix needed |
| **Data types** | Dynamic typing with affinities | TEXT, INTEGER, REAL, BLOB, NULL |
| **Date/time** | `date()`, `time()`, `datetime()`, `julianday()`, `strftime()` | No native DATE type |
| **Date formatting** | `strftime('%Y-%m', created_at)` | Similar to C `strftime` |
| **Date arithmetic** | `datetime('now', '-7 days')` | Modifiers like `'-1 month'`, `'+1 year'` |
| **String concat** | `\|\|` operator | NOT `+` or `CONCAT()` |
| **Boolean** | `0` and `1` | No TRUE/FALSE keywords |
| **UPSERT** | `INSERT OR REPLACE` or `INSERT ... ON CONFLICT` | Different from PostgreSQL |
| **Case sensitivity** | Identifiers case-insensitive | Use double quotes for case-sensitive |

## Worked example

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

Always include `LIMIT 500` unless the user explicitly asks for more.
