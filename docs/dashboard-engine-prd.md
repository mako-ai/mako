# PRD: AI-Native Dashboard Engine

> In-browser analytics with agent-first creation for Mako

## Summary

Add dashboarding capabilities to Mako powered by DuckDB-WASM running entirely in the browser. Users build dashboards through natural language conversation with the AI agent. Saved consoles (a database connection + a query) serve as data sources — the server-side database handles heavy joins and aggregations, DuckDB-WASM handles interactive cross-filtering and chart-level queries. Dashboards are persisted as JSON specs in MongoDB, rendered with Vega-Lite, and coordinated with Mosaic for cross-filtering.

---

## Motivation

### Current State

Mako is an AI-native SQL client. Users connect databases, write queries (with AI assistance), and see results in a data grid. There is no visualization layer beyond the tabular MUI DataGrid. Users who want charts export data to Looker Studio, Metabase, or spreadsheets.

### Known Pain Points

1. **Context switching** — Users build queries in Mako, then leave to visualize them elsewhere
2. **Looker Studio is slow** — Round-trips to BigQuery on every filter click, even for datasets that fit in memory
3. **No cross-filtering** — Existing BI tools bolt on cross-filtering as an afterthought; most charts don't participate
4. **Chart builder UX is tedious** — Dragging fields into boxes is slower than describing what you want in natural language
5. **Data freshness is manual** — Exporting CSVs or connecting BI tools to live databases creates stale snapshots or slow dashboards

### Desired State

- Users create dashboards from within Mako by talking to the AI agent
- Dashboards use existing saved consoles as data sources (any database Mako supports)
- Sub-second interactivity via DuckDB-WASM — no server round-trips for filtering
- Cross-filtering is a first-class feature: click a bar, filter everything else
- Dashboards are workspace-scoped, shareable with team members
- The agent can build, modify, and explain dashboards through structured tool calls

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  MongoDB (persistence)                                           │
│                                                                 │
│  Dashboard                                                      │
│  ├── dataSources: [{ consoleId, name, timeDimension }]          │
│  ├── relationships: [{ from, to }]                              │
│  ├── widgets: [{ vegaLiteSpec, localSql, layout }]              │
│  └── crossFilter: { enabled, resolution }                       │
│                                                                 │
│  SavedConsole (existing)                                        │
│  ├── connectionId → DatabaseConnection                          │
│  └── content (the SQL / MongoDB query)                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │  API                       │
         │                           │
         │  POST /consoles/:id/export │
         │  → Execute console query   │
         │  → Serialize as Arrow IPC  │
         │  → Return binary stream    │
         └─────────────┬─────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                 │
│  DuckDB-WASM                                                    │
│  ├── Table "order_data"   ← Arrow from console_1                │
│  ├── Table "revenue_kpi"  ← Arrow from console_2                │
│  └── Table "daily_users"  ← Arrow from console_3                │
│                                                                 │
│  Mosaic Coordinator                                             │
│  ├── Selection.crossfilter()                                    │
│  └── Manages queries across all chart clients                   │
│                                                                 │
│  Dashboard Canvas (react-grid-layout)                           │
│  ├── Vega-Lite chart (widget 1) ← Mosaic client                │
│  ├── Vega-Lite chart (widget 2) ← Mosaic client                │
│  ├── KPI card (widget 3)        ← Mosaic client                │
│  └── Data table (widget 4)      ← Mosaic client                │
│                                                                 │
│  Chat (existing)                                                │
│  └── Agent with dashboard tools                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Consoles are the data layer.** A dashboard data source is a reference to a SavedConsole. The console's query runs on the server-side database (BigQuery, Postgres, MongoDB, etc.) where the heavy computation belongs. DuckDB-WASM only handles interactive exploration of the result set.
2. **The agent is the primary builder.** The chat interface is the chart builder. Structured tool calls produce and modify dashboard specs. Direct manipulation (drag, resize) is the secondary refinement path.
3. **Dashboards are JSON specs, not code.** Persisted as structured documents in MongoDB. Validated with Zod. Renderable without compilation. Versionable, diffable, migratable.
4. **Cross-filtering is built in, not bolted on.** Mosaic's Coordinator and Selection system handles cross-filtering from day one. Every chart participates by default.

---

## Data Pipeline

### Console → Dashboard Flow

The user's workflow has two phases, both driven by the AI agent:

**Phase 1: Build the data (console mode — already exists)**

The user creates consoles that define their data sources. A console is a database connection + a query. The query can be anything the source database supports:

```sql
-- Simple: ingest a whole table
SELECT * FROM orders;

-- Complex: multi-table join with aggregation
SELECT
  o.order_date,
  o.amount,
  c.segment,
  c.region,
  p.category
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
WHERE o.order_date >= '2025-01-01';
```

The server-side database does the heavy lifting: joins across datasets, window functions, CTEs, BigQuery-specific syntax — whatever the source supports.

**Phase 2: Build the dashboard (new)**

The user tells the agent to create a dashboard from one or more saved consoles. The agent registers them as data sources, creates charts, and configures cross-filtering.

### Data Export Endpoint

A new API endpoint executes a console's query and returns the result as Apache Arrow IPC:

```
GET /api/workspaces/:workspaceId/consoles/:consoleId/export
  ?format=arrow          (arrow | json, default: arrow)
  &limit=500000          (row limit safety valve, default: 500000)
  &cache=true            (use server-side cache if fresh, default: true)

Response: application/vnd.apache.arrow.stream (binary)
Headers:
  X-Row-Count: 125000
  X-Export-Duration-Ms: 2340
  X-Cache-Hit: false
```

**Why Arrow IPC, not Parquet:**

- Arrow IPC loads directly into DuckDB-WASM with zero deserialization — the bytes are the in-memory format
- Parquet requires a decode step (DuckDB can do it, but Arrow is faster for this use case)
- Arrow IPC streams naturally over HTTP (no need to buffer the entire file before sending)

**Server-side implementation:**

1. Load the SavedConsole and its DatabaseConnection
2. Execute the query via `databaseConnectionService.executeQuery()`
3. Convert the result rows + field metadata to Apache Arrow RecordBatch
4. Stream as Arrow IPC format
5. Optionally cache the result (keyed by console ID + query hash + connection ID)

**Row limit:** Default 500,000 rows. Configurable per workspace (plan tier). The agent warns users when a query returns more rows than the limit and suggests adding aggregations or filters.

### Client-Side Data Loading

When a dashboard opens:

1. For each data source, check OPFS cache (keyed by console ID + query content hash)
2. If cache miss or stale: fetch from `/consoles/:id/export?format=arrow`
3. Register the Arrow buffer as a DuckDB-WASM table: `db.registerFileBuffer(name, buffer)`
4. Show per-data-source loading progress in the dashboard UI
5. Once all data sources are loaded, initialize the Mosaic Coordinator and render charts

**Cache strategy (Phase 1):**

- OPFS-backed via DuckDB-WASM's persistent storage
- Cache key: `{consoleId}:{sha256(queryContent)}:{connectionId}`
- TTL: 1 hour default, configurable per data source
- Manual refresh button per data source and for the whole dashboard
- Cache metadata stored in IndexedDB (last refresh timestamp, row count, byte size)

### Data Freshness

| Mode               | Trigger                                                     | Phase   |
| ------------------ | ----------------------------------------------------------- | ------- |
| **On open**        | Dashboard load fetches fresh data if cache is stale         | Phase 1 |
| **Manual refresh** | User clicks refresh button                                  | Phase 1 |
| **Auto-refresh**   | Configurable interval (5m, 15m, 1h) while dashboard is open | Phase 2 |
| **Scheduled**      | Inngest job pre-caches data server-side on a cron           | Phase 3 |

---

## Data Model

### Dashboard

```typescript
interface IDashboard {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;

  title: string;
  description?: string;

  dataSources: DashboardDataSource[];
  relationships: TableRelationship[];
  widgets: DashboardWidget[];

  globalFilters: GlobalFilter[];

  crossFilter: {
    enabled: boolean;
    resolution: "intersect" | "union";
  };

  layout: {
    columns: number; // grid columns (default: 12)
    rowHeight: number; // pixels per grid row (default: 80)
  };

  cache: {
    ttlSeconds: number; // default: 3600
    lastRefreshedAt?: Date;
  };

  access: "private" | "workspace";
  createdBy: string; // User ID
  createdAt: Date;
  updatedAt: Date;
}
```

### DashboardDataSource

A reference to a SavedConsole, aliased as a table name in DuckDB-WASM.

```typescript
interface DashboardDataSource {
  id: string; // nanoid, stable within the dashboard
  name: string; // table alias in DuckDB (e.g. "orders", "customers")
  consoleId: Types.ObjectId; // → SavedConsole
  connectionId: Types.ObjectId; // denormalized from console for quick access

  timeDimension?: string; // default time column (e.g. "order_date")
  rowLimit?: number; // override default limit for this source

  cache?: {
    ttlSeconds?: number; // override dashboard-level TTL
    lastRefreshedAt?: Date;
    rowCount?: number;
    byteSize?: number;
  };
}
```

### TableRelationship

Defines a foreign key link between two data sources for cross-filtering. Optional — many dashboards use a single denormalized data source.

```typescript
interface TableRelationship {
  id: string;
  from: {
    dataSourceId: string; // → DashboardDataSource.id
    column: string;
  };
  to: {
    dataSourceId: string;
    column: string;
  };
  type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
}
```

### DashboardWidget

A chart, KPI card, or data table on the dashboard canvas.

```typescript
interface DashboardWidget {
  id: string; // nanoid
  title?: string;

  type: "chart" | "kpi" | "table";

  dataSourceId: string; // → DashboardDataSource.id

  // The SQL query run against the local DuckDB table
  // Simple aggregations, GROUP BYs — the heavy work already happened server-side
  localSql: string;

  // Vega-Lite spec (for type: "chart")
  // Omit data — injected at render time from localSql result
  // Validated with the shared MakoChartSpec Zod schema
  vegaLiteSpec?: MakoChartSpec;

  // KPI config (for type: "kpi")
  kpiConfig?: {
    valueField: string;
    format?: string; // e.g. "$,.0f", ".1%"
    comparisonField?: string; // for delta/sparkline
    comparisonLabel?: string;
  };

  // Table config (for type: "table")
  tableConfig?: {
    columns?: string[]; // subset of columns to show
    pageSize?: number;
  };

  // Cross-filter participation
  crossFilter: {
    enabled: boolean; // default: true
    fields?: string[]; // which fields participate in cross-filter selection
  };

  // Layout position (react-grid-layout)
  layout: {
    x: number;
    y: number;
    w: number; // grid units (out of layout.columns)
    h: number; // grid units
    minW?: number;
    minH?: number;
  };
}
```

### GlobalFilter

Dashboard-level filters (date range picker, dropdown selectors) that apply to all widgets.

```typescript
interface GlobalFilter {
  id: string;
  type: "date-range" | "select" | "multi-select" | "search";
  label: string;

  dataSourceId: string;
  column: string;

  config: {
    // date-range
    defaultRange?: { start: string; end: string };
    // select / multi-select
    options?: string[]; // static options, or omit to auto-populate from data
    defaultValue?: string | string[];
  };

  layout: {
    order: number; // position in the filter bar
    width?: number; // grid units
  };
}
```

### Why a Single Document

A dashboard with 8 charts, 3 data sources, and 2 filters is ~5-15KB of JSON. Storing it as a single MongoDB document means:

- Atomic reads and writes (no joins, no consistency issues)
- The agent can read the full spec in one tool call to understand context
- Easy to duplicate, export, import, version

If dashboards grow beyond 16MB (MongoDB's document limit), the widget specs can be extracted to a subcollection. This is unlikely for Phase 1.

---

## Chart Spec Schema

### Design Principles

The chart spec schema is the contract between three consumers:

1. **The agent** — produces specs via tool calls. The schema must be constrained enough that LLMs generate valid output reliably.
2. **The renderer** — consumes specs to produce Vega-Lite views. The schema must map cleanly to `vega-embed` input.
3. **The auto-spec generator** — produces default charts from column type heuristics. The schema must be easy to construct programmatically.

Vega-Lite's full TypeScript type (`TopLevelSpec`) has 500+ types and deep nesting. Exposing all of it to the agent would produce hallucinated fields and invalid combinations. Instead, we define `MakoChartSpec` — a **focused Zod schema** covering the subset of Vega-Lite that handles ~95% of analytical charts. The schema is strict on structure but permissive on Vega-Lite's encoding options.

### The Schema

Lives in a shared location importable by both frontend (tool definitions, rendering) and the auto-spec generator: `app/src/lib/chart-spec.ts`.

```typescript
import { z } from "zod";

// --- Primitives ---

const FieldType = z.enum(["quantitative", "temporal", "nominal", "ordinal"]);

const AggregateOp = z
  .enum([
    "count",
    "sum",
    "mean",
    "average",
    "median",
    "min",
    "max",
    "distinct",
    "variance",
    "stdev",
    "q1",
    "q3",
  ])
  .optional();

const TimeUnit = z
  .enum([
    "year",
    "quarter",
    "month",
    "week",
    "day",
    "yearmonth",
    "yearmonthdate",
    "yearquarter",
    "monthdate",
    "hours",
    "minutes",
    "seconds",
    "hoursminutes",
    "hoursminutesseconds",
  ])
  .optional();

const SortOrder = z.enum(["ascending", "descending"]).optional();

const StackOption = z
  .union([
    z.enum(["zero", "normalize", "center"]),
    z.literal(false),
    z.literal(null),
  ])
  .optional();

// --- Encoding channel ---

const FieldDef = z.object({
  field: z.string().describe("Column name from the data"),
  type: FieldType.describe("Vega-Lite data type"),
  aggregate: AggregateOp.describe("Aggregation function"),
  timeUnit: TimeUnit.describe("Time unit for temporal fields"),
  bin: z
    .union([z.boolean(), z.object({ maxbins: z.number().optional() })])
    .optional()
    .describe("Bin quantitative values"),
  sort: z
    .union([
      SortOrder,
      z.object({
        field: z.string().optional(),
        op: AggregateOp,
        order: SortOrder,
      }),
    ])
    .optional()
    .describe("Sort order"),
  title: z.string().optional().describe("Axis / legend title override"),
  format: z
    .string()
    .optional()
    .describe("D3 format string (e.g. '$,.0f', '.1%')"),
  axis: z
    .object({
      title: z.string().optional(),
      format: z.string().optional(),
      labelAngle: z.number().optional(),
      grid: z.boolean().optional(),
      tickCount: z.number().optional(),
    })
    .optional()
    .describe("Axis configuration"),
  scale: z
    .object({
      type: z
        .enum(["linear", "log", "sqrt", "symlog", "pow", "time", "utc"])
        .optional(),
      domain: z.array(z.any()).optional(),
      range: z.array(z.any()).optional(),
      zero: z.boolean().optional(),
      nice: z.boolean().optional(),
    })
    .optional()
    .describe("Scale configuration"),
  stack: StackOption.describe("Stack mode for bar/area charts"),
  legend: z
    .union([
      z.object({
        title: z.string().optional(),
        orient: z.enum(["left", "right", "top", "bottom", "none"]).optional(),
      }),
      z.literal(null),
    ])
    .optional()
    .describe("Legend configuration, null to hide"),
});

const ValueDef = z.object({
  value: z.union([z.string(), z.number()]).describe("Constant value"),
});

const EncodingChannel = z.union([FieldDef, ValueDef]);

// --- Encoding object ---

const Encoding = z
  .object({
    x: EncodingChannel.optional(),
    y: EncodingChannel.optional(),
    x2: EncodingChannel.optional(),
    y2: EncodingChannel.optional(),
    color: EncodingChannel.optional(),
    size: EncodingChannel.optional(),
    opacity: EncodingChannel.optional(),
    shape: EncodingChannel.optional(),
    detail: EncodingChannel.optional(),
    text: EncodingChannel.optional(),
    tooltip: z.union([EncodingChannel, z.array(FieldDef)]).optional(),
    order: EncodingChannel.optional(),
    theta: EncodingChannel.optional(),
    radius: EncodingChannel.optional(),
  })
  .describe("Vega-Lite encoding channels");

// --- Mark ---

const MarkType = z.enum([
  "bar",
  "line",
  "area",
  "point",
  "circle",
  "square",
  "tick",
  "rect",
  "rule",
  "text",
  "arc",
  "trail",
  "boxplot",
]);

const MarkDef = z.union([
  MarkType,
  z.object({
    type: MarkType,
    tooltip: z
      .union([z.boolean(), z.object({ content: z.enum(["data", "encoding"]) })])
      .optional(),
    point: z
      .union([
        z.boolean(),
        z.object({
          filled: z.boolean().optional(),
          size: z.number().optional(),
        }),
      ])
      .optional()
      .describe("Show points on line/area marks"),
    opacity: z.number().min(0).max(1).optional(),
    color: z.string().optional(),
    filled: z.boolean().optional(),
    strokeWidth: z.number().optional(),
    cornerRadiusEnd: z.number().optional(),
    interpolate: z
      .enum([
        "linear",
        "step",
        "step-before",
        "step-after",
        "basis",
        "cardinal",
        "monotone",
      ])
      .optional(),
    line: z.boolean().optional().describe("Show line on area marks"),
    size: z.number().optional(),
    innerRadius: z
      .number()
      .optional()
      .describe("Inner radius for arc/donut charts"),
  }),
]);

// --- Transform ---

const Transform = z.union([
  z.object({
    filter: z.union([
      z.string(),
      z.object({
        field: z.string(),
        oneOf: z.array(z.any()).optional(),
        range: z.array(z.any()).optional(),
        equal: z.any().optional(),
        gt: z.any().optional(),
        gte: z.any().optional(),
        lt: z.any().optional(),
        lte: z.any().optional(),
      }),
    ]),
  }),
  z.object({
    calculate: z.string().describe("Vega expression"),
    as: z.string().describe("New field name"),
  }),
  z.object({
    aggregate: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    groupby: z.array(z.string()),
  }),
  z.object({
    fold: z.array(z.string()).describe("Columns to unpivot"),
    as: z
      .tuple([z.string(), z.string()])
      .optional()
      .describe("Output field names [key, value]"),
  }),
  z.object({
    window: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    frame: z.tuple([z.number().nullable(), z.number().nullable()]).optional(),
    groupby: z.array(z.string()).optional(),
    sort: z
      .array(
        z.object({
          field: z.string(),
          order: SortOrder,
        }),
      )
      .optional(),
  }),
  z.object({
    joinaggregate: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    groupby: z.array(z.string()).optional(),
  }),
]);

// --- Layer spec (for multi-mark charts) ---

const LayerSpec = z.object({
  mark: MarkDef,
  encoding: Encoding.optional(),
});

// --- Top-level chart spec ---

export const MakoChartSpec = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Vega-Lite schema URL. Omit — injected at render time."),
    description: z.string().optional(),
    title: z
      .union([
        z.string(),
        z.object({
          text: z.string(),
          subtitle: z.string().optional(),
          anchor: z.enum(["start", "middle", "end"]).optional(),
        }),
      ])
      .optional(),
    width: z.union([z.number(), z.literal("container")]).optional(),
    height: z.union([z.number(), z.literal("container")]).optional(),
    autosize: z
      .union([
        z.enum(["fit", "fit-x", "fit-y", "pad", "none"]),
        z.object({
          type: z.enum(["fit", "fit-x", "fit-y", "pad", "none"]),
          contains: z.enum(["padding", "content"]).optional(),
          resize: z.boolean().optional(),
        }),
      ])
      .optional(),
    transform: z.array(Transform).optional(),

    // Single-mark chart
    mark: MarkDef.optional(),
    encoding: Encoding.optional(),

    // Multi-mark chart (layers)
    layer: z.array(LayerSpec).optional(),
  })
  .refine(
    spec =>
      spec.mark !== undefined ||
      (spec.layer !== undefined && spec.layer.length > 0),
    {
      message:
        "Spec must have either 'mark' (single chart) or 'layer' (multi-mark chart)",
    },
  );

export type MakoChartSpec = z.infer<typeof MakoChartSpec>;
```

### What the Schema Covers

| Vega-Lite Feature                  | Supported | Notes                                           |
| ---------------------------------- | --------- | ----------------------------------------------- |
| Bar, line, area, point, arc charts | Yes       | All common analytical mark types                |
| Stacked / grouped bars             | Yes       | Via `stack` on encoding                         |
| Multi-line (fold transform)        | Yes       | `fold` unpivots columns into key/value          |
| Donut / pie charts                 | Yes       | `arc` mark with `theta` encoding, `innerRadius` |
| Scatter plots                      | Yes       | `point` mark with x/y quantitative              |
| Box plots                          | Yes       | `boxplot` composite mark                        |
| Time series with aggregation       | Yes       | `timeUnit` on temporal fields                   |
| Calculated fields                  | Yes       | `calculate` transform                           |
| Window functions                   | Yes       | `window` transform for running totals, ranks    |
| Tooltips                           | Yes       | Per-channel or array of fields                  |
| Axis formatting                    | Yes       | D3 format strings, label angles, grid           |
| Color scales                       | Yes       | Via `scale` on color channel                    |
| Layered charts (dual axis, etc.)   | Yes       | `layer` array of mark + encoding                |
| Facets / small multiples           | No        | Phase 2 — adds `row`/`column` encoding          |
| Concatenation (hconcat/vconcat)    | No        | Phase 2 — dashboard layout handles this         |
| Interactive selections / params    | No        | Mosaic handles selections externally            |
| Custom data source                 | No        | Data is always injected at render time          |
| Repeat                             | No        | Rarely needed for agent-generated charts        |

### Schema Reuse

The same `MakoChartSpec` Zod schema is used in three places:

**1. Agent tool parameter (Phase 0 — console chart):**

```typescript
const ModifyChartSpecParameters = z.object({
  vegaLiteSpec: MakoChartSpec.describe("Vega-Lite chart specification"),
  reasoning: z.string().describe("Brief explanation of the chart choice"),
});
```

**2. Agent tool parameter (Phase 1 — dashboard widget):**

```typescript
const AddWidgetParameters = z.object({
  dashboardId: z.string(),
  type: z.enum(["chart", "kpi", "table"]),
  title: z.string().optional(),
  dataSourceId: z.string(),
  localSql: z.string(),
  vegaLiteSpec: MakoChartSpec.optional().describe(
    "Chart spec (for chart type)",
  ),
  // ...
});
```

**3. Rendering validation (both phases):**

```typescript
function renderChart(spec: unknown, data: any[], container: HTMLElement) {
  const parsed = MakoChartSpec.safeParse(spec);
  if (!parsed.success) {
    // Show validation error in the chart container instead of crashing
    renderValidationError(parsed.error, container);
    return;
  }
  // Inject data and render
  const fullSpec = { ...parsed.data, data: { values: data } };
  vegaEmbed(container, fullSpec, { actions: false });
}
```

### Why Not Pass the Spec as a JSON String

SQLRooms defines `vegaLiteSpec` as `z.string()` — the LLM produces a JSON string, and validation only happens when `vega-embed` tries to render it. This has two problems:

1. **Late failure.** A malformed spec renders as a blank chart or a cryptic Vega error. With Zod validation, the agent gets a structured error it can fix before the user sees anything.
2. **No schema hints for the LLM.** When the tool parameter is a typed object (not a string), the AI SDK serializes the Zod schema as JSON Schema in the tool definition. The LLM sees the exact fields, types, and enums it can use — producing more accurate specs. A `z.string()` gives the LLM no structural guidance.

By using `MakoChartSpec` directly as the tool parameter (not wrapped in `z.string()`), the Vercel AI SDK's `zodSchema()` converts it to JSON Schema automatically, and the LLM's structured output mode constrains generation to valid specs.

### Extending the Schema

When new chart types or features are needed:

1. Add the new mark type / encoding channel / transform to the Zod schema
2. The tool definition updates automatically (Zod → JSON Schema)
3. The renderer validates automatically (same `safeParse` call)
4. Update the agent system prompt to mention the new capability

No separate schema maintenance. One source of truth.

---

## Mosaic Integration

### Why Mosaic

[Mosaic](https://idl.uw.edu/mosaic/) (UW Interactive Data Lab, MIT license) provides the cross-filtering coordination layer. It solves the hardest 30% of the problem:

- **Selection algebra** — `intersect`, `union`, `single`, with cross-filter exclusion (brushing chart A filters B and C but not A)
- **Query optimization** — batches queries, caches results, pre-aggregates common filter patterns
- **DuckDB-native** — connects to DuckDB-WASM via Arrow with zero-copy data transfer
- **Renderer-agnostic** — the coordinator doesn't care what renders the charts

### Integration Approach

Use `@uwdata/mosaic-core` for the coordinator and selection system. Use `vega-lite` + `vega` + `vega-embed` for chart rendering. Wire them together with a thin React wrapper — do NOT use Mosaic's `vgplot` (which is vanilla JS and hard to integrate with React component lifecycle).

```
@uwdata/mosaic-core          → Coordinator, Selection, Param
  └── connects to DuckDB-WASM via wasmConnector

vega-lite + vega-embed        → Chart rendering from specs
  └── mounted in React via useRef + useEffect

React wrapper <MosaicChart>   → Bridges Mosaic client protocol with React
  └── implements Mosaic client interface (query, queryResult, filterBy)
  └── translates Mosaic filter predicates into Vega-Lite signal updates
```

### MosaicChart React Component

Each chart widget is wrapped in a `<MosaicChart>` component that:

1. Registers as a Mosaic client with the coordinator on mount
2. Exposes a `filterBy` selection (the shared cross-filter)
3. Implements `query()` — returns a SQL query incorporating the current filter predicate
4. Implements `queryResult()` — receives filtered data, updates the Vega-Lite view
5. On user interaction (click, brush) — emits a selection clause to the coordinator
6. Unregisters from the coordinator on unmount

### Cross-Filter Flow

```
User clicks a bar in Chart A (segment = "Enterprise")
  → Chart A emits Selection clause: { source: chartA, predicate: "segment = 'Enterprise'" }
  → Mosaic Coordinator receives clause
  → For Chart B: predicate includes Chart A's clause (cross-filter)
  → For Chart A: predicate EXCLUDES its own clause (shows full distribution with highlight)
  → Coordinator calls chartB.query(predicate) → SQL with WHERE clause
  → DuckDB-WASM executes → returns filtered data
  → Chart B re-renders with filtered data
  → All in <50ms for datasets under 1M rows
```

---

## Agent Tools

The agent creates and modifies dashboards through structured tool calls. Tools are defined with Zod schemas and registered in the agent-v2 system alongside existing console and flow tools.

### Tool: `create_dashboard`

Creates a new empty dashboard with initial data sources.

```typescript
const CreateDashboardParameters = z.object({
  title: z.string().describe("Dashboard title"),
  description: z.string().optional().describe("Brief description"),
  dataSources: z
    .array(
      z.object({
        consoleId: z
          .string()
          .describe("ID of the saved console to use as data source"),
        name: z
          .string()
          .describe(
            "Table alias in the dashboard (e.g. 'orders', 'customers')",
          ),
        timeDimension: z
          .string()
          .optional()
          .describe("Default time column for this data source"),
      }),
    )
    .min(1)
    .describe("Data sources from saved consoles"),
});

// Returns: { dashboardId, dataSources: [{ id, name, consoleId, columns }] }
```

### Tool: `add_widget`

Adds a chart, KPI, or table widget to the dashboard.

```typescript
const AddWidgetParameters = z.object({
  dashboardId: z.string(),
  type: z.enum(["chart", "kpi", "table"]),
  title: z.string().optional(),
  dataSourceId: z
    .string()
    .describe("ID of the data source within the dashboard"),
  localSql: z.string().describe("SQL query against the local DuckDB table"),
  vegaLiteSpec: MakoChartSpec.optional().describe(
    "Chart spec (for chart type). Uses the shared MakoChartSpec Zod schema.",
  ),
  kpiConfig: z
    .object({
      valueField: z.string(),
      format: z.string().optional(),
      comparisonField: z.string().optional(),
      comparisonLabel: z.string().optional(),
    })
    .optional()
    .describe("KPI configuration (for kpi type)"),
  tableConfig: z
    .object({
      columns: z.array(z.string()).optional(),
      pageSize: z.number().optional(),
    })
    .optional()
    .describe("Table configuration (for table type)"),
  layout: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .describe("Grid position and size"),
});

// Returns: { widgetId, rendered: true }
```

### Tool: `modify_widget`

Modifies an existing widget's properties.

```typescript
const ModifyWidgetParameters = z.object({
  dashboardId: z.string(),
  widgetId: z.string(),
  title: z.string().optional(),
  localSql: z.string().optional(),
  vegaLiteSpec: MakoChartSpec.optional(),
  kpiConfig: z
    .object({
      /* same as above */
    })
    .optional(),
  tableConfig: z
    .object({
      /* same as above */
    })
    .optional(),
  layout: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
});

// Returns: { widgetId, modified: true }
```

### Tool: `remove_widget`

```typescript
const RemoveWidgetParameters = z.object({
  dashboardId: z.string(),
  widgetId: z.string(),
});
```

### Tool: `link_tables`

Defines a relationship between two data sources for cross-filtering.

```typescript
const LinkTablesParameters = z.object({
  dashboardId: z.string(),
  from: z.object({
    dataSourceId: z.string(),
    column: z.string(),
  }),
  to: z.object({
    dataSourceId: z.string(),
    column: z.string(),
  }),
  type: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]),
});
```

### Tool: `set_time_dimension`

Sets or changes the default time column for a data source.

```typescript
const SetTimeDimensionParameters = z.object({
  dashboardId: z.string(),
  dataSourceId: z.string(),
  column: z
    .string()
    .describe("The datetime column to use as default time dimension"),
});
```

### Tool: `add_global_filter`

Adds a dashboard-level filter (date range picker, dropdown).

```typescript
const AddGlobalFilterParameters = z.object({
  dashboardId: z.string(),
  type: z.enum(["date-range", "select", "multi-select", "search"]),
  label: z.string(),
  dataSourceId: z.string(),
  column: z.string(),
  defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
});
```

### Tool: `get_dashboard_state`

Returns the full dashboard spec so the agent can understand current state before making changes.

```typescript
const GetDashboardStateParameters = z.object({
  dashboardId: z.string(),
});

// Returns: full dashboard JSON spec + data source column metadata
```

### Tool: `get_data_preview`

Runs a SQL query against a dashboard's local DuckDB data and returns a preview. Useful for the agent to understand the data before creating charts.

```typescript
const GetDataPreviewParameters = z.object({
  dashboardId: z.string(),
  dataSourceId: z.string(),
  sql: z
    .string()
    .optional()
    .describe("SQL to run. Defaults to SELECT * LIMIT 10"),
});

// Returns: { columns: [...], rows: [...], rowCount }
```

### Client-Side vs Server-Side Tools

| Tool                  | Execution | Why                                                    |
| --------------------- | --------- | ------------------------------------------------------ |
| `create_dashboard`    | Server    | Creates MongoDB document                               |
| `add_widget`          | Client    | Modifies local dashboard state, re-renders immediately |
| `modify_widget`       | Client    | Same — instant visual feedback                         |
| `remove_widget`       | Client    | Same                                                   |
| `link_tables`         | Client    | Modifies local state + reconfigures Mosaic             |
| `set_time_dimension`  | Client    | Modifies local state                                   |
| `add_global_filter`   | Client    | Modifies local state + adds filter UI                  |
| `get_dashboard_state` | Client    | Reads from local Zustand store                         |
| `get_data_preview`    | Client    | Queries local DuckDB-WASM                              |

Client-side tools follow the existing pattern in `Chat.tsx` — handled in `onToolCall`, results returned via `addToolOutput`. The dashboard is auto-saved to the server after each modification (debounced).

### Agent System Prompt (Dashboard Mode)

```
You are a dashboard builder for Mako. You help users create interactive
data dashboards from their saved queries.

Available data sources are loaded from saved consoles. Each data source
is a table in DuckDB with the columns listed below.

When creating charts:
- Use Vega-Lite JSON specs for the vegaLiteSpec parameter
- Write simple SQL for localSql — the data is already prepared by the
  console query. Use GROUP BY, aggregations, and date_trunc for charts.
- Place widgets on a 12-column grid. Standard sizes:
  - Full width chart: { x: 0, y: 0, w: 12, h: 4 }
  - Half width chart: { x: 0, y: 0, w: 6, h: 4 }
  - KPI card: { x: 0, y: 0, w: 3, h: 2 }
- Enable cross-filtering by default on all charts
- Set the time dimension when a data source has datetime columns

When the user asks to modify a chart, use modify_widget with only the
changed fields. Call get_dashboard_state first if you need context.

DATA SOURCES:
{dataSourceSchemas}
```

---

## API Routes

### New Routes

All routes are workspace-scoped, mounted at `/api/workspaces/:workspaceId/dashboards`.

```
GET    /                          List dashboards
POST   /                          Create dashboard
GET    /:id                       Get dashboard by ID
PUT    /:id                       Update dashboard (full spec)
PATCH  /:id                       Partial update (widgets, layout, etc.)
DELETE /:id                       Delete dashboard
POST   /:id/duplicate             Duplicate dashboard
```

### Console Export Route

Added to existing console routes at `/api/workspaces/:workspaceId/consoles`.

```
GET    /:id/export                Export console query result as Arrow IPC
  ?format=arrow|json
  &limit=500000
```

### Middleware

Same pattern as other workspace routes:

```typescript
const dashboardRoutes = new Hono();

dashboardRoutes.use("*", unifiedAuthMiddleware);
dashboardRoutes.use("*", requireWorkspace);

dashboardRoutes.get("/", async c => {
  /* list dashboards */
});
dashboardRoutes.post("/", async c => {
  /* create dashboard */
});
// ...
```

---

## Frontend Components

### Component Tree

```
<App>
  └── <MainApp>
      ├── <Sidebar>
      │   └── "Dashboards" nav item (new)
      ├── <LeftPane>
      │   └── <DashboardExplorer> (new — list/create/delete dashboards)
      ├── <CenterPane>
      │   └── <DashboardCanvas> (new — replaces Editor when viewing a dashboard)
      │       ├── <DashboardToolbar>
      │       │   ├── Title + edit
      │       │   ├── Global filters bar
      │       │   ├── Refresh button
      │       │   └── Share / settings
      │       ├── <GridLayout> (react-grid-layout)
      │       │   ├── <WidgetContainer>
      │       │   │   ├── <MosaicChart> (Vega-Lite + Mosaic client)
      │       │   │   ├── <KpiCard>
      │       │   │   └── <DataTable>
      │       │   └── ... more widgets
      │       └── <DashboardLoadingOverlay> (per-data-source progress)
      └── <RightPane>
          └── <Chat> (existing — with dashboard tools added)
```

### New Zustand Store: `dashboardStore.ts`

```typescript
interface DashboardStoreState {
  // Dashboard list
  dashboards: IDashboard[];
  loading: boolean;

  // Active dashboard
  activeDashboardId: string | null;
  activeDashboard: IDashboard | null;

  // DuckDB instance
  db: AsyncDuckDB | null;
  dataSourceStatus: Record<string, "loading" | "ready" | "error">;

  // Mosaic
  coordinator: Coordinator | null;
  selection: Selection | null;

  // Actions
  fetchDashboards: (workspaceId: string) => Promise<void>;
  createDashboard: (
    workspaceId: string,
    dashboard: Partial<IDashboard>,
  ) => Promise<IDashboard>;
  openDashboard: (workspaceId: string, dashboardId: string) => Promise<void>;
  saveDashboard: () => Promise<void>;

  // Widget mutations (used by agent tools)
  addWidget: (widget: DashboardWidget) => void;
  modifyWidget: (widgetId: string, changes: Partial<DashboardWidget>) => void;
  removeWidget: (widgetId: string) => void;

  // Data source management
  loadDataSource: (dataSource: DashboardDataSource) => Promise<void>;
  refreshDataSource: (dataSourceId: string) => Promise<void>;
  refreshAllDataSources: () => Promise<void>;

  // Relationships
  addRelationship: (rel: TableRelationship) => void;
  removeRelationship: (relId: string) => void;

  // Cleanup
  closeDashboard: () => void;
}
```

Follows existing patterns: `create()` with `persist()` and `immer()` middleware, localStorage persistence for UI state (active dashboard ID), server persistence for dashboard specs.

### DuckDB-WASM Initialization

DuckDB-WASM is loaded lazily — only when a dashboard is opened. Code-split via dynamic import to avoid adding ~10MB to the initial bundle.

```typescript
async function initDuckDB(): Promise<AsyncDuckDB> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}
```

### Navigation

Dashboards are a new left-pane mode alongside databases, consoles, connectors, and flows:

```typescript
// uiStore.ts — extend LeftPane type
type LeftPane =
  | "databases"
  | "consoles"
  | "connectors"
  | "flows"
  | "dashboards";
```

URL structure: `/workspaces/:workspaceId/dashboards/:dashboardId`

When a dashboard is active, the center pane shows `<DashboardCanvas>` instead of `<Editor>`. The right pane remains `<Chat>` with dashboard-mode tools.

---

## Prior Art

### Patterns Adopted

| Project                                                         | What we took                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **[Mosaic](https://idl.uw.edu/mosaic/)**                        | Coordinator + Selection cross-filtering architecture, DuckDB-WASM integration via Arrow                        |
| **[SQLRooms](https://sqlrooms.org/)**                           | Agent tool pattern for chart generation (Vega-Lite spec + SQL as tool output), Zustand store composability     |
| **[Observable Framework](https://observablehq.com/framework/)** | Data loaders → DuckDB-WASM pipeline, Parquet/Arrow as transfer format                                          |
| **[Vega-Lite](https://vega.github.io/vega-lite/)**              | Declarative chart grammar as the agent's output format — well-defined JSON spec with massive LLM training data |
| **[Rill](https://www.rilldata.com/)**                           | Metrics-first dashboard with default time dimension, opinionated layout                                        |
| **[Static BI](https://github.com/unytics/static_bi)**           | DuckDB-WASM + ECharts + cross-filtering as proof of concept for the architecture                               |
| **[Retool](https://retool.com/)**                               | JSON spec → renderer pattern (Toolscript), with code escape hatch for power users                              |

### Evaluated and Rejected

| Project                        | Why not wholesale                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQLRooms**                   | UI library mismatch (Tailwind/shadcn vs MUI). AI runs client-side (API keys in browser) vs our server-side agent. No cross-filtering. No multi-tenant auth. No server-side data sources. Useful as design reference, not as dependency. |
| **Observable Framework**       | Static site generator, not embeddable. Code-based (Markdown), not agent-driven. No drag-and-drop or interactive builder.                                                                                                                |
| **Apache Superset / Metabase** | Server-side rendering, no DuckDB-WASM. Heavy infrastructure (Redis, Celery, Postgres). Not embeddable as a feature in an existing app.                                                                                                  |
| **Perspective (FINOS)**        | All-in-one widget — hard to decompose. Own query engine (not DuckDB). Opinionated UI that can't be customized to match Mako's design.                                                                                                   |
| **Recharts**                   | SVG-based, no brushing primitives, re-renders entire DOM on state change. Wrong for cross-filtering dashboards.                                                                                                                         |

### Key Lessons

1. **Vega-Lite is the right agent output format.** Well-defined JSON grammar, massive training data, formal spec validation. LLMs produce valid Vega-Lite more reliably than ECharts config or custom JSON schemas.
2. **Separate data preparation from visualization.** Observable Framework and Rill both separate the "get the data" step from the "render the chart" step. Our console → DuckDB pipeline follows this pattern.
3. **Cross-filtering needs a coordinator.** Static BI and Mosaic both prove that cross-filtering requires centralized state management — you can't just have charts listen to each other. Mosaic's Coordinator is the production-grade solution.
4. **Don't build a semantic layer on day one.** Malloy, Cube, and MetricFlow are powerful but complex. The console query IS the semantic layer for Phase 1. Users (or the agent) define what "revenue" means in SQL.
5. **Agent-first beats form-first.** SQLRooms' `createVegaChartTool` validates that LLMs can reliably produce chart specs from natural language. No existing tool has made this the primary creation path for dashboards.

---

## UX Flow

### Creating a Dashboard

```
User: "Create a dashboard from my order_analysis query"

Agent:
  1. Calls get_dashboard_state or lists available consoles
  2. Calls create_dashboard with the console reference
  3. Calls get_data_preview to understand the columns
  4. Asks: "I see columns: order_date, amount, segment, region, category.
           What would you like to see first?"

User: "Revenue by month, and a breakdown by segment"

Agent:
  1. Calls add_widget (bar chart: revenue by month)
  2. Calls add_widget (pie chart: revenue by segment)
  3. Calls set_time_dimension (order_date)
  4. "I've added two charts with cross-filtering enabled.
     Click any segment in the pie chart to filter the bar chart."

User: "Add a KPI showing total revenue and month-over-month change"

Agent:
  1. Calls add_widget (KPI card with comparison)
  2. "Added a KPI card showing total revenue with MoM delta."

User: "Make the bar chart a line chart instead"

Agent:
  1. Calls modify_widget (change mark type in vegaLiteSpec)
  2. "Changed to a line chart."
```

### Dashboard Interactions

| Interaction                    | Mechanism                                              |
| ------------------------------ | ------------------------------------------------------ |
| Cross-filter (click bar/slice) | Mosaic Selection → all charts re-query DuckDB          |
| Global date range filter       | GlobalFilter component → Mosaic Param → all charts     |
| Drag to reposition widget      | react-grid-layout → updates widget.layout → auto-save  |
| Resize widget                  | react-grid-layout → updates widget.layout → auto-save  |
| Hover tooltip                  | Vega-Lite native tooltip                               |
| Brush time range               | Vega-Lite interval selection → Mosaic Selection clause |
| Click to drill down            | Phase 2 — navigate to filtered detail view             |

---

## Implementation Phases

### Phase 0 — Console Chart View (Stepping Stone)

A lightweight precursor that adds chart visualization to the existing console results panel. No DuckDB, no Mosaic, no new data pipeline — just render the query results already in memory as a Vega-Lite chart. Ships the core rendering library, the Zod-typed chart spec schema, and the agent tool pattern that Phase 1 builds on.

**What it is:** A third view mode in `ResultsTable.tsx` alongside Table and JSON. The user runs a query, sees results in the grid, clicks the Chart toggle, and gets an auto-generated visualization. The agent can then modify the chart spec via a new tool.

**Scope:**

- [ ] Add `vega`, `vega-lite`, `vega-embed` dependencies (code-split, lazy-loaded)
- [ ] Define the `MakoChartSpec` Zod schema (see [Chart Spec Schema](#chart-spec-schema) below)
- [ ] Add `"chart"` to the `viewMode` toggle in `ResultsTable.tsx` (new icon: `BarChart3` from lucide)
- [ ] `<ResultsChart>` component: takes `results.results` (array of objects) + `results.fields`, renders a validated `MakoChartSpec` via `vega-embed`
- [ ] Auto-spec generation: deterministic heuristics to produce a sensible default chart from column types:

| Column Pattern                            | Default Chart                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| 1 temporal + 1 numeric                    | Line chart (x: time, y: numeric)                                              |
| 1 temporal + N numeric                    | Multi-line chart (x: time, y: each numeric as a layer)                        |
| 1 categorical + 1 numeric                 | Bar chart (x: category, y: numeric)                                           |
| 1 categorical + 1 numeric + 1 categorical | Grouped/stacked bar (x: cat1, y: numeric, color: cat2)                        |
| 2 numeric                                 | Scatter plot (x: first, y: second)                                            |
| 1 temporal + 1 numeric + 1 categorical    | Line chart with color (x: time, y: numeric, color: category)                  |
| Fallback                                  | Bar chart of first categorical × first numeric, or table if no viable pairing |

Column type detection uses the existing `fields` metadata (when available from the driver) plus sampling the first 100 rows for type inference (already done in `ResultsTable` for numeric alignment).

- [ ] Store the active `MakoChartSpec` in `consoleStore` per tab (alongside the existing `tabResults`)
- [ ] Agent tool: `modify_chart_spec` — a client-side tool in console mode that uses `MakoChartSpec` as its parameter schema (see [Agent Tools — Chart Spec](#agent-tool-modify_chart_spec) below)
- [ ] When the agent modifies the spec, validate with Zod before rendering, auto-switch to chart view
- [ ] Respect dark/light theme (Vega-Lite theme config matching MUI palette)
- [ ] Chart toolbar: download as PNG/SVG, reset to auto-generated spec

**What it is NOT:**

- No DuckDB-WASM (data stays as JSON in memory)
- No cross-filtering (single chart, single query result)
- No dashboard canvas or layout grid
- No persistence of chart specs (ephemeral, per-session)
- No data re-querying (the chart renders whatever the last query returned)

**Why this first:**

1. Ships Vega-Lite to production — validates the rendering library, theme integration, and bundle size impact before the full dashboard engine
2. Ships the Zod-typed chart spec — validates that the schema is expressive enough for real charts and constraining enough for reliable agent output
3. Ships the agent → chart spec tool pattern — validates that LLMs produce good Vega-Lite from natural language
4. Immediately useful — every SQL client has chart view; Mako doesn't
5. Low risk — ~500 lines of new code, no backend changes, no new dependencies beyond Vega
6. The `<ResultsChart>` component, `MakoChartSpec` schema, and auto-spec heuristics are directly reused in Phase 1 dashboard widgets

### Phase 1 — Foundation (MVP)

- [ ] `Dashboard` Mongoose schema in `workspace-schema.ts`
- [ ] Dashboard CRUD routes (`/api/workspaces/:workspaceId/dashboards`)
- [ ] Console export endpoint (Arrow IPC serialization)
- [ ] DuckDB-WASM initialization (lazy, code-split)
- [ ] Arrow IPC loading into DuckDB-WASM tables
- [ ] `dashboardStore.ts` (Zustand + Immer)
- [ ] `<DashboardCanvas>` component with `react-grid-layout`
- [ ] `<MosaicChart>` React wrapper (Mosaic client + Vega-Lite rendering)
- [ ] Mosaic Coordinator setup with `Selection.crossfilter()`
- [ ] Agent tools: `create_dashboard`, `add_widget`, `modify_widget`, `remove_widget`, `get_dashboard_state`, `get_data_preview`
- [ ] Dashboard mode in Chat (system prompt, tool registration)
- [ ] `<DashboardExplorer>` in left pane (list, create, delete)
- [ ] Basic widget types: chart (Vega-Lite), KPI card, data table
- [ ] Auto-save on widget mutation (debounced PUT to API)
- [ ] OPFS-based data caching with manual refresh

### Phase 2 — Interactivity & Filters

- [ ] Global filters (date range picker, select, multi-select)
- [ ] `add_global_filter` agent tool
- [ ] `link_tables` and `set_time_dimension` agent tools
- [ ] Table relationship configuration UI
- [ ] Brush selection on time-series charts
- [ ] Auto-refresh interval (configurable per dashboard)
- [ ] Widget inspector panel (click widget → see/edit spec, SQL, config)
- [ ] Duplicate widget
- [ ] Dashboard duplication

### Phase 3 — Polish & Sharing

- [ ] Dashboard sharing (workspace-level access control)
- [ ] Presentation mode (hide chrome, full-screen grid)
- [ ] Export to PNG/PDF (server-side rendering via Playwright or client-side canvas capture)
- [ ] Dashboard templates (starter dashboards for common patterns)
- [ ] Undo/redo for widget mutations
- [ ] Widget-level loading states and error boundaries
- [ ] Data source column metadata in agent context (types, cardinality, sample values)
- [ ] Agent-suggested charts based on data profile

### Phase 4 — Scale & Advanced

- [ ] Server-side data caching (Inngest scheduled pre-fetch)
- [ ] Embed dashboards via iframe (public URL with token auth)
- [ ] Real-time collaboration (broadcast cross-filter state via WebSocket)
- [ ] Code widget escape hatch (sandboxed React component via Sandpack)
- [ ] Mobile-responsive layout (separate mobile breakpoint in grid)
- [ ] Dashboard versioning and rollback
- [ ] Computed columns in DuckDB (user-defined expressions)

---

## Dependencies

### New npm Packages (Frontend)

| Package               | Version | Size (gzip) | Purpose                   |
| --------------------- | ------- | ----------- | ------------------------- |
| `@duckdb/duckdb-wasm` | ^1.32.0 | ~10MB       | In-browser OLAP engine    |
| `@uwdata/mosaic-core` | ^0.21.1 | ~50KB       | Cross-filter coordinator  |
| `vega`                | ^5.30.0 | ~300KB      | Vega runtime              |
| `vega-lite`           | ^5.21.0 | ~400KB      | Declarative chart grammar |
| `vega-embed`          | ^6.26.0 | ~20KB       | Vega-Lite → DOM renderer  |
| `react-grid-layout`   | ^1.5.0  | ~50KB       | Dashboard grid layout     |
| `apache-arrow`        | ^18.0.0 | ~150KB      | Arrow IPC deserialization |

Total additional bundle: ~11MB (mostly DuckDB-WASM). Code-split so it only loads when entering the dashboard module.

### New npm Packages (API)

| Package        | Version | Purpose                                         |
| -------------- | ------- | ----------------------------------------------- |
| `apache-arrow` | ^18.0.0 | Arrow IPC serialization for the export endpoint |

### Existing Packages Reused

| Package                | Already in app | Used for                        |
| ---------------------- | -------------- | ------------------------------- |
| `zustand`              | ^5.0.5         | dashboardStore                  |
| `immer`                | ^10.1.1        | Immutable state updates         |
| `@monaco-editor/react` | ^4.6.0         | SQL/spec editing in inspector   |
| `@mui/material`        | ^7.1.0         | Widget chrome, filters, toolbar |
| `@ai-sdk/react`        | 3.0.0-beta     | Chat with dashboard tools       |
| `zod`                  | ^3.25.76       | Tool parameter validation       |
| `axios`                | ^1.6.2         | API calls                       |
| `lucide-react`         | ^0.511.0       | Icons                           |

---

## Open Questions

1. **Arrow serialization on the API** — The existing `executeQuery` returns JSON rows. Adding Arrow serialization means converting `any[]` rows + field metadata to Arrow RecordBatches. Should this be a new method on `databaseConnectionService`, or a separate serialization utility?

2. **DuckDB-WASM memory limits** — Browser tabs typically get 1-4GB. With a 500K row limit per data source and multiple sources, memory pressure is real. Should we enforce a total dashboard memory budget? Show a warning when approaching limits?

3. **Cross-origin isolation** — DuckDB-WASM with SharedArrayBuffer (multi-threaded) requires COOP/COEP headers. These can break OAuth popups and third-party scripts. Should we run single-threaded (slower but no header requirements) or add the headers and handle OAuth in a separate window?

4. **Vega-Lite version pinning** — LLMs are trained on Vega-Lite v5 syntax. Upgrading to v6 (if released) could break agent-generated specs. Should we pin to v5 and validate specs before rendering?

5. **Dashboard-console coupling** — If a user edits a console's query after it's used as a dashboard data source, the dashboard's data changes on next refresh. Is this desired behavior, or should dashboards snapshot the query at creation time?

6. **Agent mode switching** — The agent currently has `console` and `flow` modes. Adding `dashboard` mode means three-way switching. Should it auto-detect from context (user is viewing a dashboard → dashboard mode), or require explicit selection?

7. **Widget ID stability** — The agent references widgets by ID. If IDs are nanoids, the agent needs to call `get_dashboard_state` to discover them. Should widgets also have user-visible names for easier reference in conversation?

8. **Mosaic coordinator lifecycle** — One coordinator per dashboard? Per browser tab? Shared across dashboards? The coordinator holds DuckDB connections and cached query state — lifecycle management affects memory and cleanup.
