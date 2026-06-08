# DuckDB SQL reference

Dashboard data lives in an **in-browser DuckDB** instance. All `localSql`
queries run against DuckDB, not the original database. Key differences from
PostgreSQL/MySQL:

## Timestamp handling

- Columns typed TIMESTAMP may contain **epoch milliseconds as integers** (e.g. `1774421106308`). Check the sample values in the data source schema.
- If sample values are large integers (13 digits), they are epoch milliseconds. Convert with: `to_timestamp(col / 1000.0)` or `epoch_ms(col)`
- Do NOT use `col::TIMESTAMP` on epoch integers — DuckDB interprets that as microseconds, producing wrong dates.
- For relative time: `age(now(), to_timestamp(col / 1000.0))`
- For formatting: `strftime(to_timestamp(col / 1000.0), '%Y-%m-%d %H:%M')`

## Common DuckDB functions

- `date_trunc('week', ts)` — truncate to interval
- `strftime(ts, format)` — format timestamp as string
- `epoch_ms(bigint)` — convert epoch milliseconds to timestamp
- `to_timestamp(seconds)` — convert epoch seconds to timestamp
- `age(ts1, ts2)` — interval between timestamps
- `now()` — current timestamp (evaluated at query time)
- `INTERVAL '7 days'` — interval literal

## Type casting

- Use `TRY_CAST(x AS type)` instead of `x::type` when the data may have unexpected values
- String to number: `CAST(col AS DOUBLE)` or `TRY_CAST(col AS INTEGER)`
- Always check the column's sample values in the data source schema to understand the actual data format before writing SQL
