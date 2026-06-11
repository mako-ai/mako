# Dashboard widget SQL and chart specs

### DuckDB SQL Reference

Dashboard data lives in an **in-browser DuckDB** instance. All `localSql` queries run against DuckDB, not the original database. Key differences from PostgreSQL/MySQL:

**Timestamp handling:**
- Columns typed TIMESTAMP may contain **epoch milliseconds as integers** (e.g. `1774421106308`). Check the sample values in the data source schema.
- If sample values are large integers (13 digits), they are epoch milliseconds. Convert with: `to_timestamp(col / 1000.0)` or `epoch_ms(col)`
- Do NOT use `col::TIMESTAMP` on epoch integers — DuckDB interprets that as microseconds, producing wrong dates.
- For relative time: `age(now(), to_timestamp(col / 1000.0))`
- For formatting: `strftime(to_timestamp(col / 1000.0), '%Y-%m-%d %H:%M')`

**Common DuckDB functions:**
- `date_trunc('week', ts)` — truncate to interval
- `strftime(ts, format)` — format timestamp as string
- `epoch_ms(bigint)` — convert epoch milliseconds to timestamp
- `to_timestamp(seconds)` — convert epoch seconds to timestamp
- `age(ts1, ts2)` — interval between timestamps
- `now()` — current timestamp (evaluated at query time)
- `INTERVAL '7 days'` — interval literal

**Type casting:**
- Use `TRY_CAST(x AS type)` instead of `x::type` when the data may have unexpected values
- String to number: `CAST(col AS DOUBLE)` or `TRY_CAST(col AS INTEGER)`
- Always check the column's sample values in the data source schema to understand the actual data format before writing SQL

### Chart Guidelines

When creating chart widgets:
- The `vegaLiteSpec` should NOT include a `data` property — data is injected automatically from the `localSql` query results
- Write simple SQL for `localSql` — the data is already prepared by the data source query. Widget SQL should only SELECT, filter, and GROUP BY columns that already exist in the data source. Use GROUP BY, aggregations, and date_trunc for charts.
- **All data transformations must happen at the source (HARD ENFORCED):** Type casts (e.g., `CAST(col AS INTEGER)`), computed columns, string formatting, and any other value transformations MUST go in the data source extraction query (`create_data_source` / `update_data_source_query`), NOT in widget `localSql`. If a column arrives as VARCHAR but you need it as INTEGER, fix the source query (e.g., `COUNT(*)::int`), do NOT cast in the widget. Widget SQL that transforms values will be rejected by the cross-filter validator.
- **Cross-filter rule (HARD ENFORCED):** Cross-filtered widgets MUST keep canonical dimension field names from the data source. Do NOT alias them (e.g., `listing_canton_code AS canton` is rejected). Do NOT create calculated dimensions (e.g., `strftime(...) AS week_label` is rejected). Use Vega `title`, `legend.title`, `axis.title`, and tooltip labels for presentation instead.
- Metric aliases such as `COUNT(*) AS enquiry_count` are allowed because aggregates are not cross-filter dimensions.
- If you need a derived dimension or a type-corrected field, update the **data source extraction query** so it becomes a canonical field in DuckDB. Do not compute it in widget SQL.
- Available mark types: bar, line, area, point, arc, boxplot, rect, rule, text, tick, trail
- When data has a categorical dimension (e.g., country, status, type) and you want separate lines/areas/bars per category, use `color: { field: "...", type: "nominal" }` encoding. Always include the categorical column in `localSql`.
- Use `fold` transforms only when multiple numeric columns need unpivoting into a single series dimension (wide-to-long format)
- For time series, use `temporal` type on the x-axis with appropriate `timeUnit`
- For donut/pie charts, use `arc` mark with `theta` encoding and `innerRadius`
- Always include tooltips for interactivity
- For multi-series and stacked bar charts, prefer simple long-format specs (single mark + standard encodings). The app renderer auto-enhances rich tooltip behavior for common cases.
- **Layered hover compatibility:** If you must author custom layered hover behavior manually, use `__mako_tooltip` as the hover selection param name for compatibility with the app tooltip renderer.
- For cross-filtered date/time bar charts, do NOT assume `temporal + timeUnit` is correct. First inspect the source field type and how the clicked value will map back into DuckDB predicates.
