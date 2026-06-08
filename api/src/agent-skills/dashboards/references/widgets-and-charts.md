# Widget & chart guidelines

## Chart guidelines

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

## Layout guidelines

Place widgets on a 12-column grid using the `layouts` field with **only** an
`lg` breakpoint. Smaller breakpoints (md/sm/xs) are auto-reflowed for you — a
row of widgets wraps and tiles cleanly on narrower screens — so never emit
md/sm/xs yourself.

**Use grid-friendly widths that evenly tile a row** so the reflow stays
balanced. Within a single row, prefer equal widths whose total is 12: e.g. 4
KPIs at w:3 each, 3 cards at w:4 each, 2 charts at w:6 each, or 1 full-width
widget at w:12. Avoid leaving an awkward remainder in a row (e.g. three w:5
cards).

**IMPORTANT — Minimum sizes are enforced. Widgets smaller than the minimums below will be automatically enlarged:**
- Charts (line, bar, area, point, etc.): minimum w: 4, h: 3
- Donut/pie charts (arc mark): minimum w: 3, h: 3
- KPI cards: minimum w: 2, h: 1
- Data tables: minimum w: 4, h: 3

**Recommended sizes (use these as defaults):**
- Line / bar / area chart (full width): { lg: { x: 0, y: 0, w: 12, h: 5 } }
- Line / bar / area chart (half width): { lg: { x: 0, y: 0, w: 6, h: 5 } }
- Donut / pie chart: { lg: { x: 0, y: 0, w: 4, h: 4 } }
- Horizontal bar / ranking: { lg: { x: 0, y: 0, w: 6, h: 5 } }
- KPI card: { lg: { x: 0, y: 0, w: 3, h: 2 } }
- Data table: { lg: { x: 0, y: 0, w: 12, h: 5 } }

**Never use w: 1 or h: 1 — these produce unreadable widgets.** Charts should
always have h >= 4 for readability. Prefer full-width (w: 12) for time-series
charts and tables.

Stack widgets vertically by incrementing the y value. Avoid overlapping layouts.

When repositioning or resizing existing widgets, always read their current
`layouts` from `get_dashboard_state` first. Use the actual x, y, w, h values —
never guess or assume layout positions.

## Widget examples

**Area chart (time series):**
```
localSql: SELECT date_trunc('month', date) AS month, SUM(amount) AS revenue FROM "orders" GROUP BY 1 ORDER BY 1
vegaLiteSpec: {
  mark: { type: "area", line: true, opacity: 0.3 },
  encoding: {
    x: { field: "month", type: "temporal", timeUnit: "yearmonth", title: "Month" },
    y: { field: "revenue", type: "quantitative", title: "Revenue" },
    tooltip: [
      { field: "month", type: "temporal", timeUnit: "yearmonth" },
      { field: "revenue", type: "quantitative", format: "$,.0f" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 8, h: 5 } }
```

**Bar chart (weekly counts):**
```
localSql: SELECT date_trunc('week', created_at) AS week, COUNT(*) AS new_users FROM "users" GROUP BY 1 ORDER BY 1
vegaLiteSpec: {
  mark: { type: "bar", cornerRadiusEnd: 4 },
  encoding: {
    x: { field: "week", type: "temporal", timeUnit: "yearmonthdate", title: "Week" },
    y: { field: "new_users", type: "quantitative", title: "New Users" },
    tooltip: [
      { field: "week", type: "temporal" },
      { field: "new_users", type: "quantitative" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 12, h: 5 } }
```

**Grouped/stacked bar (category breakdown):**
```
localSql: SELECT date_trunc('month', date) AS month, type, SUM(amount) AS total FROM "transactions" GROUP BY 1, 2 ORDER BY 1
vegaLiteSpec: {
  mark: { type: "bar" },
  encoding: {
    x: { field: "month", type: "temporal", timeUnit: "yearmonth" },
    y: { field: "total", type: "quantitative", title: "Amount" },
    color: { field: "type", type: "nominal" },
    tooltip: [
      { field: "month", type: "temporal" },
      { field: "type", type: "nominal" },
      { field: "total", type: "quantitative", format: "$,.0f" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 12, h: 5 } }
```

**Multi-series line chart (one line per category):**
```
localSql: SELECT day, country, rate FROM ds_xxx ORDER BY day, country
vegaLiteSpec: {
  mark: { type: "line", strokeWidth: 2 },
  encoding: {
    x: { field: "day", type: "temporal", title: "Date" },
    y: { field: "rate", type: "quantitative", title: "Rate (%)" },
    color: { field: "country", type: "nominal", title: "Country" },
    tooltip: [
      { field: "day", type: "temporal", format: "%Y-%m-%d" },
      { field: "country", type: "nominal" },
      { field: "rate", type: "quantitative", format: ".1f" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 12, h: 5 } }
```

**Horizontal bar (ranking / funnel):**
```
localSql: SELECT category, COUNT(*) AS count FROM "events" GROUP BY category
vegaLiteSpec: {
  mark: { type: "bar", cornerRadiusEnd: 4 },
  encoding: {
    x: { field: "count", type: "quantitative", title: "Count" },
    y: { field: "category", type: "nominal", sort: { field: "count", op: "sum", order: "descending" }, axis: { title: "" } },
    color: { field: "category", type: "nominal", legend: null },
    tooltip: [
      { field: "category", type: "nominal" },
      { field: "count", type: "quantitative" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 6, h: 5 } }
```

**KPI card:**
```
type: "kpi"
localSql: SELECT SUM(amount) AS total FROM "orders"
kpiConfig: { valueField: "total", format: "$,.0f" }
layouts: { lg: { x: 0, y: 0, w: 3, h: 2 } }
```

**Donut chart:**
```
localSql: SELECT status, COUNT(*) AS count FROM "orders" GROUP BY status
vegaLiteSpec: {
  mark: { type: "arc", innerRadius: 50 },
  encoding: {
    theta: { field: "count", type: "quantitative" },
    color: { field: "status", type: "nominal" },
    tooltip: [
      { field: "status", type: "nominal" },
      { field: "count", type: "quantitative" }
    ]
  }
}
layouts: { lg: { x: 0, y: 0, w: 4, h: 4 } }
```
