# Charts in Mako apps

Read this before adding any chart to an app. It is short on purpose; the
`dataviz` skill (if available to you) covers form and color theory in depth —
this is the Mako-specific part.

## Library

Use **recharts** (28 of the workspace's apps already do; agents and reviewers
know it). Add it to the app's `package.json` (`"recharts": "^2"`), run
`npm install`, commit `package-lock.json`. Do not pull in d3 for a bar chart;
reach for `d3-geo` only for maps. Pure CSS/SVG bars are fine for a single
small comparison inside a card.

```tsx
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

<div style={{ height: 280 }}>
  <ResponsiveContainer width="100%" height="100%">
    <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis dataKey="country" tickLine={false} axisLine={false} />
      <YAxis tickFormatter={fmtCompact} tickLine={false} axisLine={false} width={48} />
      <Tooltip formatter={(v: number) => fmtEur(v)} />
      <Bar dataKey="revenue" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>
</div>
```

`ResponsiveContainer` needs a parent with an explicit height.

## Color

Use the theme tokens the SDK/scaffold declare — never hex literals:
`var(--chart-1)` … `var(--chart-5)` for series, `var(--muted-foreground)` for
axes and labels, `var(--border)` for grid lines. They flip correctly in dark
mode. One series → one hue (`--chart-1`); highlight by dimming the others
(opacity 0.35), not by adding colors. Categorical series get `--chart-1..5`
in order; more than five series is a table or a filter, not a chart.

## Data shape

- Aggregate in SQL when you can (`GROUP BY` in the binding); aggregate in the
  browser with `useDuckDB("select country, sum(x) x from <binding> group by 1")`
  when the binding is shared with a table that needs the raw rows.
- Sort bars by value unless the axis is ordinal (months, funnel stages).
- **Dates come from bindings as strings**: `DATE` → `"YYYY-MM-DD"`,
  `TIMESTAMP` → ISO 8601 (SDK ≥ 2.2). Parse with `new Date(s)` for time axes;
  format with `Intl.DateTimeFormat`. Never assume a number.
- Money: `Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 })`;
  compact axis ticks: `{ notation: "compact" }`.

## States

Render all three explicitly, in the same card frame: `loading` (skeleton or
"Loading…"), `error` (the message from `useQuery` — it is already readable),
and empty (`rows.length === 0` → one line saying so). A chart that silently
draws nothing looks like a broken binding.

## Verify

Look at it: run the app (`npm run dev` locally or `app_open_app`), then
`app_browse` / your own browser. Check axis labels are not clipped, the tooltip
formats like the table, and the top bar's value label is inside the card.
Report what you saw, with the numbers, not that "the chart renders".
