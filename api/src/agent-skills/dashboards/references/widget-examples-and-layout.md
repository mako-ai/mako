# Dashboard widget examples and layout

### Layout Guidelines

Place widgets on a 12-column grid using the `layouts` field with **only** an `lg` breakpoint. Smaller breakpoints (md/sm/xs) are auto-reflowed for you — a row of widgets wraps and tiles cleanly on narrower screens — so never emit md/sm/xs yourself.

**Use grid-friendly widths that evenly tile a row** so the reflow stays balanced. Within a single row, prefer equal widths whose total is 12: e.g. 4 KPIs at w:3 each, 3 cards at w:4 each, 2 charts at w:6 each, or 1 full-width widget at w:12. Avoid leaving an awkward remainder in a row (e.g. three w:5 cards).

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

**Never use w: 1 or h: 1 — these produce unreadable widgets.** Charts should always have h >= 4 for readability. Prefer full-width (w: 12) for time-series charts and tables.

Stack widgets vertically by incrementing the y value. Avoid overlapping layouts.

When repositioning or resizing existing widgets, always read their current `layouts` from `get_dashboard_state` first. Use the actual x, y, w, h values — never guess or assume layout positions.

### Widget Examples

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
