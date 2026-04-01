# PRD: User-Defined Sandboxed Connectors

> Vibe-coded data integrations for Mako

## Summary

Let users build, test, and deploy connectors for any third-party API from within Mako's UI. Connector source code lives in the database, is editable on the fly with AI assistance, and executes in sandboxed E2B environments. Users write TypeScript, import any npm package, and Mako handles scheduling, retries, schema management, and writes to any connected database.

---

## Motivation

### Current State

Connectors today are committed to the repository (`api/src/connectors/*`), tightly coupled to the host (Mongoose, encryption, Axios, SDKs), discovered at boot via two filesystem-scanning registries, and always write to MongoDB. Adding a connector requires: write TypeScript matching a 12+ method `BaseConnector` interface, commit, deploy.

### Known Pain Points

1. **Dual registries** — `connectorRegistry` (API) vs `syncConnectorRegistry` (sync) with different input types and config shapes
2. **Config shape mismatch** — different config key names between sync and API paths
3. **Query injection** — GraphQL/PostHog queries live on the Flow, not the Connector, breaking separation
4. **MongoDB-only writes** — connectors cannot target SQL databases
5. **Webhook lookup bug** — `Flow.findOne({ enabled: true })` but Flow has `schedule.enabled`, not top-level `enabled`
6. **Non-chunked timeout risk** — default `fetchEntityChunk` throws; full sync runs in one Inngest step

### Desired State

- Users create connectors from within Mako's UI with AI assistance
- Connectors execute in isolated sandboxes — can't crash the host
- Fast iteration: edit → run → see results in seconds
- Any npm package, any external API
- Cron and webhook triggers, user-configurable
- Write to any connected database (SQL included)
- Connectors are reusable — one connector, many deployments with different configs

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Mako Core                             │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐              │
│  │ Cron /   │  │ Webhook  │  │  Connector    │              │
│  │ Scheduler│  │ Receiver │  │  Manager      │              │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘              │
│       │              │                │                      │
│       ▼              ▼                ▼                      │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Connector Runtime                          │ │
│  │  - Loads code + bundle from DB                          │ │
│  │  - Spins up E2B sandbox                                 │ │
│  │  - Injects context (secrets, state, config, syncMode)   │ │
│  │  - Collects structured output                           │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                        │
│       ┌─────────────┼─────────────┐                          │
│       ▼             ▼             ▼                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │ Schema   │ │ Write    │ │ Secrets  │                     │
│  │ Reconcile│ │ Pipeline │ │ Vault    │                     │
│  └──────────┘ └──────────┘ └──────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **The sandbox is dumb.** It runs user code, fetches data, returns results. It knows nothing about Inngest, MongoDB, workspaces, or Mako internals.
2. **Inngest is the orchestrator.** Scheduling, retries, chunking, timeout enforcement, observability.
3. **Mako owns all DDL.** Connectors never touch database schemas. Mako creates tables, adds columns, manages metadata.
4. **Connectors are reusable.** Code is separate from deployment config. One connector, many instances.

---

## Data Model

Two documents: the reusable code artifact and the per-user deployment configuration.

### UserConnector (the code)

```typescript
{
  _id: ObjectId,
  workspaceId: ObjectId,

  name: string,                        // "Stripe"
  description: string,

  source: {
    code: string,                      // TypeScript source
    resolvedDependencies?: Record<string, string>,  // Computed at build time from imports
  },

  bundle: {
    js: string,                        // Bundled JS (50-300KB)
    sourceMap: string,
    buildHash: string,                 // sha256 — skip rebuild if unchanged
    builtAt: Date,
    buildLog: string,
    errors: string | null,
  },

  metadata: {
    entities: string[],                // ["customers", "invoices", "charges"]
    requiredSecrets: string[],         // ["STRIPE_API_KEY"]
    configSchema?: Record<string, unknown>,
    supports: {
      pull: boolean,
      webhook: boolean,
      incrementalPull: boolean,
    },
  },

  version: number,
  versions: [{ code: string, buildHash: string, createdAt: Date, createdBy: ObjectId }],
  visibility: "private" | "workspace" | "public",

  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date,
}
```

### ConnectorInstance (the deployment config)

```typescript
{
  _id: ObjectId,
  workspaceId: ObjectId,
  connectorId: ObjectId,               // → UserConnector

  name: string,                        // "My Stripe → Postgres (hourly)"

  secrets: Record<string, string>,     // Encrypted, specific to this instance
  config: Record<string, unknown>,     // Passed as ctx.config

  output: {
    destinationDatabaseId: ObjectId,
    entityTableMap: Record<string, string>,
    defaultIdField: string,
    schemaEvolution: "evolve" | "freeze" | "discard_row" | "discard_value",
  },

  triggers: [
    { type: "cron", cron: string, syncMode: "full" | "incremental", enabled: boolean },
    { type: "webhook", path: string, enabled: boolean },
  ],

  state: Record<string, Record<string, unknown>>,  // Per-entity, opaque

  status: "active" | "paused" | "error",
  lastRunAt: Date,
  lastSuccessAt: Date,
  lastError: string,
  runCount: number,

  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date,
}
```

### Why Two Documents

A Stripe connector built by one user should be reusable by others with different API keys, schedules, and destinations. Real-world trigger patterns require this split:

- **Stripe**: full sync daily at 2am + live webhooks → two triggers, different types
- **Close CRM**: incremental hourly + full sync daily at 3am → two cron triggers, different sync modes
- **Marketplace**: one published connector, ten teams using it with their own credentials

---

## Connector Contract

### Input (Mako → Sandbox)

```typescript
interface ConnectorInput {
  trigger: { type: "cron" | "webhook" | "manual"; payload?: unknown };
  syncMode: "full" | "incremental";
  secrets: Record<string, string>;
  state: Record<string, unknown>;
  config: Record<string, unknown>;
}
```

`syncMode` comes from the instance trigger config. For full syncs, Mako clears state before calling. For incremental, existing state is passed through.

### Output (Sandbox → Mako)

```typescript
interface ConnectorOutput {
  data: FlushBatch[];
  state: {
    hasMore: boolean; // REQUIRED — loop termination signal
    [key: string]: unknown; // Opaque — cursor, offset, page, etc.
  };
}

interface FlushBatch {
  entity: string;
  records: Record<string, unknown>[];
  idField?: string; // Default: "id"
  schema?: EntitySchema; // Optional type hints
}

interface EntitySchema {
  columns: {
    name: string;
    type:
      | "string"
      | "number"
      | "boolean"
      | "date"
      | "datetime"
      | "json"
      | "integer"
      | "float";
    nullable?: boolean;
  }[];
}
```

`hasMore` is the only field Mako reads from state. Everything else is opaque — stored and passed back on the next invocation. Output is validated with Zod (`passthrough()` on state).

### Pagination Helper

Injected as `ctx.paginate()`, handles cursor, offset, and link-based pagination:

```typescript
for await (const page of ctx.paginate({
  url: "https://api.stripe.com/v1/customers",
  type: "cursor",
  limit: 100,
  cursorParam: "starting_after",
  cursorPath: "data[-1].id",
  hasMorePath: "has_more",
  dataPath: "data",
  headers: { Authorization: `Bearer ${ctx.secrets.STRIPE_KEY}` },
})) {
  // page is the extracted data array
}
```

Optional — power users can write manual pagination. Covers ~80% of cases.

---

## Sandbox Runtime: E2B

### Why E2B

| Factor         | `isolated-vm` | E2B              | Docker       |
| -------------- | ------------- | ---------------- | ------------ |
| npm packages   | No            | **Yes**          | Yes          |
| Network access | Proxy only    | **Native**       | Yes          |
| Startup        | ~5ms          | ~300ms-2s        | 5-30s        |
| Isolation      | V8 heap       | **Full microVM** | Full VM      |
| Ops burden     | Medium        | **Low**          | High         |
| Cost           | Free          | ~$0.05/hr        | Self-managed |

Connectors need to call external APIs and use SDKs. `isolated-vm` can't do that without proxying everything. E2B gives users a real environment.

**Exception:** High-volume webhook transforms (pure data mapping, no network) can use `isolated-vm` (~5ms) instead of E2B.

### Cost

~$0.05/hr per vCPU. A connector running 10s every hour costs ~$0.00014/run. 100 connectors hourly: ~$1/month.

---

## Build Pipeline

Separate build from execution. Dependencies are auto-resolved from imports (no user-managed `package.json`).

### Build (on deploy, 5-20s)

1. Parse imports from user code, auto-generate `package.json`
2. Spin up E2B builder sandbox
3. `npm install && esbuild index.ts --bundle --platform=node --outfile=bundle.js`
4. Optionally `tsc --noEmit` for type checking
5. Read back `bundle.js` + source map, store on connector document
6. Kill sandbox

Cached by source hash — skip rebuild if unchanged. `//nobundling` escape hatch skips esbuild for packages that don't bundle cleanly (falls back to `npm install` at runtime).

### Execute (on every trigger, ~1-5s)

1. Load connector + instance from DB
2. Create E2B sandbox from shared "mako-runtime" template
3. Write `bundle.js` to sandbox
4. Run with injected context
5. Collect output, kill sandbox

No `npm install`. No `tsc`. Just run a single JS file.

### Artifact Storage

Bundles are 50-300KB text. Stored as a string field on the UserConnector document. Graduate to GCS/R2 when 1000+ connectors or bundles exceed 1MB.

---

## Chunked Execution via Inngest

The sandbox executes one chunk and returns. Mako calls it repeatedly until `hasMore` is `false`. Preserves the current ~10 pages per Inngest step pattern.

```typescript
const userConnectorFlowFunction = inngest.createFunction(
  {
    id: "user-connector-flow",
    concurrency: [{ limit: 1, key: "event.data.instanceId" }],
  },
  { event: "user-connector.execute" },
  async ({ event, step }) => {
    const instance = await step.run("load", () =>
      loadInstance(event.data.instanceId),
    );
    const connector = await step.run("load-connector", () =>
      loadConnector(instance.connectorId),
    );
    let state = instance.state[event.data.entity] || {};
    let chunk = 0;

    while (true) {
      const result = await step.run(`chunk-${chunk}`, () =>
        sandboxRunner.execute(connector, {
          trigger: { type: event.data.triggerType },
          syncMode: event.data.syncMode,
          secrets: decrypt(instance.secrets),
          state,
          config: instance.config,
        }),
      );

      if (result.data.length > 0) {
        await step.run(`write-${chunk}`, () =>
          writeToDestination(instance, result.data),
        );
      }

      await step.run(`checkpoint-${chunk}`, () =>
        saveState(instance._id, result.state),
      );

      if (!result.state.hasMore) break;
      state = result.state;
      chunk++;
    }
  },
);
```

### Sandbox ↔ Inngest Boundary

The sandbox knows nothing about Inngest. Clean separation:

| Concern             | Owner          | Sandbox knows? |
| ------------------- | -------------- | -------------- |
| Scheduling          | Inngest        | No             |
| Retries             | Inngest        | No             |
| Chunking            | Inngest + Mako | No             |
| Webhook reception   | Mako routes    | No             |
| Writing to DB       | Mako           | No             |
| State persistence   | Mako           | No             |
| Secret decryption   | Mako           | No             |
| Timeout enforcement | Inngest + E2B  | No             |

---

## Webhook Handling

### Reception

Mako receives webhooks, responds 200 immediately (<50ms), stores the event, processes asynchronously via Inngest:

```
POST /api/webhooks/:workspaceId/:instanceId
  → 200 response
  → Store WebhookEvent
  → inngest.send("webhook/event.process")
```

### Processing

- **High-volume (10+/s):** Batch — store all events, process in batches of 10-50 in one sandbox
- **Low-volume:** E2B with pause/resume (~100-200ms resume)
- **Pure transforms:** `isolated-vm` in-process (~5ms) for simple data mapping with no network needs

---

## Writing to SQL Databases

### Type Translation

Connectors return abstract types. Mako translates per database:

| Connector  | Postgres           | BigQuery    | ClickHouse | MySQL        |
| ---------- | ------------------ | ----------- | ---------- | ------------ |
| `string`   | `TEXT`             | `STRING`    | `String`   | `TEXT`       |
| `integer`  | `BIGINT`           | `INT64`     | `Int64`    | `BIGINT`     |
| `float`    | `DOUBLE PRECISION` | `FLOAT64`   | `Float64`  | `DOUBLE`     |
| `boolean`  | `BOOLEAN`          | `BOOL`      | `Bool`     | `TINYINT(1)` |
| `date`     | `DATE`             | `DATE`      | `Date`     | `DATE`       |
| `datetime` | `TIMESTAMPTZ`      | `TIMESTAMP` | `DateTime` | `DATETIME`   |
| `json`     | `JSONB`            | `JSON`      | `String`   | `JSON`       |

### Schema Evolution (inspired by dlt)

Four configurable modes per ConnectorInstance:

| Mode               | New columns              | Type changes                       | Missing columns |
| ------------------ | ------------------------ | ---------------------------------- | --------------- |
| `evolve` (default) | `ALTER TABLE ADD COLUMN` | Variant column (`balance__v_text`) | Ignore (NULLs)  |
| `freeze`           | Reject batch             | Reject batch                       | Reject batch    |
| `discard_row`      | Skip rows                | Skip rows                          | Allow (NULLs)   |
| `discard_value`    | NULL unknown fields      | NULL mismatched                    | Allow (NULLs)   |

**Variant columns:** When a column's type changes (e.g., `balance` was `integer`, now `string`), create `balance__v_text TEXT` instead of altering the original. Both columns receive data by actual type.

### Connectors Do Not Run DDL

Mako owns all schema operations. Connectors don't know the target database type, table name, or schema. A buggy connector cannot `DROP TABLE`.

### Mako Metadata Tables

```sql
CREATE SCHEMA IF NOT EXISTS _mako;

CREATE TABLE _mako.sync_state (
  connector_id TEXT NOT NULL, entity TEXT NOT NULL,
  state JSONB, last_synced_at TIMESTAMPTZ, records_synced BIGINT DEFAULT 0,
  PRIMARY KEY (connector_id, entity)
);

CREATE TABLE _mako.sync_log (
  id UUID PRIMARY KEY, connector_id TEXT NOT NULL, entity TEXT NOT NULL,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  status TEXT, records_written BIGINT, error TEXT, chunk_index INTEGER
);

CREATE TABLE _mako.table_schemas (
  connector_id TEXT NOT NULL, entity TEXT NOT NULL,
  table_name TEXT NOT NULL, columns JSONB,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  PRIMARY KEY (connector_id, entity)
);
```

### Write Pipeline

```
Output from sandbox → Zod validation → Schema reconciliation (CREATE/ALTER TABLE)
  → Type coercion → Batch UPSERT (500-1000 rows) → Update _mako metadata
```

---

## Connector Studio UX

### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◀ Connectors    My Stripe Sync    [Draft] [Deploy ▾]              │
├────────────────────────────────┬────────────────────────────────────┤
│  ┌──── Tabs ─────────────┐    │   AI Chat                          │
│  │ Code │ Config │ Runs  │    │   "Make it also pull invoices"     │
│  └──────────────────────┘    │   Agent response + [Apply changes] │
│                                │                                    │
│  Monaco editor (TypeScript)    │                                    │
│  import Stripe from 'stripe';  │                                    │
│  export default async function │                                    │
│    pull(ctx) { ... }           │                                    │
│                                │                                    │
├────────────────────────────────┤                                    │
│  Output: ┌ Output │ Logs │ Schema ┐                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ id      │ email             │ created    │ balance │         │   │
│  │ cus_abc │ alice@example.com │ 2024-01-15 │ 4200    │         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ✓ 100 rows in 2.3s │ 5 columns                                   │
│  [▶ Run] [▶ Dry run] [↻ Reset state] [🗑 Truncate]                │
└─────────────────────────────────────────────────────────────────────┘
```

### Two Execution Modes

**Dev Run** — fast iteration, no Inngest. Build if changed, execute one chunk directly, stream results to UI, write to preview/staging. 2-10s first run, <3s subsequent.

**Production Run** — through Inngest. Full chunked pipeline, writes to real destination, schema reconciliation, execution logging.

### Iteration Controls

| Control                | Action                                          | Use case                   |
| ---------------------- | ----------------------------------------------- | -------------------------- |
| **Run**                | Build + execute one chunk                       | Normal iteration           |
| **Dry run**            | Execute with `ctx.dryRun = true`, no writes     | Preview output             |
| **Reset state**        | Clear `state` to `{}`                           | Changed pagination logic   |
| **Truncate & re-sync** | Clear state + `TRUNCATE TABLE` + clear metadata | Start fresh                |
| **Replay webhook**     | Re-process stored `WebhookEvent` payloads       | Debug webhook handler      |
| **Paste payload**      | Test with arbitrary JSON                        | Test with sample from docs |

### Error Feedback

**Build errors:** esbuild + `tsc` errors mapped to source lines via Monaco diagnostic markers.

**Runtime errors:** Source maps map `bundle.js` stack traces back to original TypeScript. Secrets masked in output.

---

## Coexistence with Existing Systems

### Flows Stay Untouched

The existing Flow system (`IFlow` + `IConnector`) continues to handle:

- Database-to-database syncs (`sourceType: "database"`)
- Built-in connectors (Stripe, PostHog, Close via `sourceType: "connector"`)

The new system (UserConnector + ConnectorInstance) is additive. No existing code is modified.

### Shared Infrastructure

| Component                 | Shared?                               |
| ------------------------- | ------------------------------------- |
| Inngest                   | New functions alongside existing ones |
| Database drivers          | Reused for write pipeline             |
| Encryption                | Reused for secrets                    |
| Workspace auth/middleware | Same patterns                         |
| Monaco editor             | Already in the app                    |
| MUI Data Grid             | Already in the app                    |

---

## Prior Art

### Patterns Adopted

| Project                                                                       | What we took                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **[dlt](https://dlthub.com/docs/general-usage/schema-evolution)**             | Schema evolution modes (`evolve`/`freeze`/`discard_row`/`discard_value`), variant columns, schema contracts |
| **[Windmill](https://windmill.dev/docs/core_concepts/codebases_and_bundles)** | esbuild-at-deploy bundling, content-hash caching, auto-resolve imports, `//nobundling` escape hatch         |
| **[Nango](https://docs.nango.dev/reference/scripts)**                         | `ctx.paginate()` helper (cursor/offset/link), checkpoint/state pattern, webhook script type                 |
| **[Val.town](https://blog.val.town/blog/first-four-val-town-runtimes)**       | Auto-resolve imports, version history, execution logs as first-class UX, fork/remix for templates           |
| **[Fivetran SDK](https://github.com/fivetran/fivetran_connector_sdk)**        | Simple connector contract, auto-schema at destination                                                       |
| **[Singer](http://www.singer.io/)**                                           | Opaque STATE between invocations, SCHEMA as type hints                                                      |

### Evaluated and Rejected

| Project      | Why not wholesale                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nango**    | Elastic License 2.0 prohibits hosted service use. Free self-hosted is auth-only (no syncs/scripts/webhooks). Doesn't write to arbitrary SQL destinations. Requires 5 Node services + Temporal + Redis + ElasticSearch + S3. No in-browser editor. |
| **Airbyte**  | Connector Builder is declarative YAML, not real code. Connectors are Docker containers — slow iteration.                                                                                                                                          |
| **Val.town** | General-purpose, not ETL. No schema management, no destination writers. Not embeddable. Deno-based.                                                                                                                                               |
| **Windmill** | AGPLv3. General-purpose, not ETL. No schema reconciliation or destination writers.                                                                                                                                                                |

### Key Lessons

1. **Don't use Node.js `vm`/`vm2`** — Val.town tried and abandoned in 2 months. Not a security boundary.
2. **Separate build from execution** — Windmill and Val.town both learned runtime installs are too slow.
3. **Auto-resolve dependencies** — Val.town and Windmill proved users shouldn't manage dep lists.
4. **Schema evolution needs modes** — dlt's four modes beat naive "cast or NULL."
5. **Execution logs are not polish** — Val.town makes them first-class from day one.
6. **Fivetran moved from Lambda to hosted SDK** — validates E2B over "bring your own function."

---

## Connector Examples

### Stripe (cursor-based, multi-entity)

```typescript
import Stripe from "stripe";

export const metadata = {
  name: "Stripe",
  entities: ["customers", "invoices"],
  requiredSecrets: ["STRIPE_API_KEY"],
  supports: { pull: true, webhook: true, incrementalPull: true },
};

export async function pull(ctx) {
  const stripe = new Stripe(ctx.secrets.STRIPE_API_KEY);
  const params: any = { limit: 100 };
  if (ctx.syncMode === "incremental" && ctx.state?.cursor) {
    params.starting_after = ctx.state.cursor;
  }
  const customers = await stripe.customers.list(params);
  return {
    data: [{ entity: "customers", records: customers.data }],
    state: { hasMore: customers.has_more, cursor: customers.data.at(-1)?.id },
  };
}

export function onWebhook(event) {
  return {
    entity: event.type.split(".")[0],
    operation: event.type.includes("deleted") ? "delete" : "upsert",
    data: event.data.object,
    id: event.data.object.id,
  };
}
```

### REST API (offset-based)

```typescript
export async function pull(ctx) {
  const page = ctx.state?.page ?? 0;
  const res = await fetch(
    `${ctx.config.apiUrl}/users?offset=${page * 50}&limit=50`,
    {
      headers: { Authorization: `Bearer ${ctx.secrets.API_TOKEN}` },
    },
  );
  const data = await res.json();
  return {
    data: [{ entity: "users", records: data.results, idField: "user_id" }],
    state: { hasMore: data.results.length === 50, page: page + 1 },
  };
}
```

### Using ctx.paginate() helper

```typescript
export async function pull(ctx) {
  const allCustomers = [];
  for await (const page of ctx.paginate({
    url: "https://api.stripe.com/v1/customers",
    type: "cursor",
    limit: 100,
    cursorParam: "starting_after",
    cursorPath: "data[-1].id",
    hasMorePath: "has_more",
    dataPath: "data",
    headers: { Authorization: `Bearer ${ctx.secrets.STRIPE_KEY}` },
  })) {
    allCustomers.push(...page);
  }
  return {
    data: [{ entity: "customers", records: allCustomers }],
    state: { hasMore: false },
  };
}
```

---

## Implementation Phases

### Phase 1 — Foundation (MVP)

- [ ] `UserConnector` + `ConnectorInstance` Mongoose schemas
- [ ] E2B sandbox runner (execute bundle, collect output)
- [ ] Build pipeline (auto-resolve imports → esbuild in E2B, cache by hash)
- [ ] Dev-run API endpoint (direct execution, no Inngest)
- [ ] Output validation with Zod
- [ ] `ctx.paginate()` helper (cursor, offset, link)
- [ ] Basic Connector Studio UI (Monaco editor + output panel)
- [ ] Manual trigger only (Run button)
- [ ] Basic execution logs (status, duration, rows, errors, state)

### Phase 2 — Production Triggers

- [ ] Inngest flow function for user connectors (chunked execution loop)
- [ ] Cron scheduling (reuse `flowSchedulerFunction` pattern)
- [ ] Webhook reception and routing
- [ ] Schema reconciliation engine with dlt-inspired evolution modes
- [ ] Mako metadata tables (`_mako.sync_state`, `_mako.sync_log`, `_mako.table_schemas`)
- [ ] Write pipeline (type coercion, variant columns, batch upserts)
- [ ] ConnectorInstance config UI (secrets, destination, triggers, sync mode)

### Phase 3 — Iteration DX

- [ ] Build error mapping to source lines (Monaco diagnostics)
- [ ] Runtime error mapping via source maps
- [ ] State management controls (reset, truncate, re-sync)
- [ ] Webhook replay UI + paste-a-payload testing
- [ ] Dry-run mode
- [ ] Full execution history with filtering and per-chunk detail
- [ ] Streaming results via SSE/WebSocket
- [ ] `//nobundling` escape hatch

### Phase 4 — AI & Polish

- [ ] AI chat integration in Connector Studio
- [ ] Agent context: code, schema, errors, contract
- [ ] Connector templates (Stripe, REST API, webhook handler starters)
- [ ] Version history and rollback
- [ ] `ctx.log()` for user-visible logging

### Phase 5 — Advanced

- [ ] `isolated-vm` for high-volume webhook transforms
- [ ] E2B pause/resume for warm sandbox pools
- [ ] Connector marketplace with fork/remix
- [ ] Graduate bundle storage to GCS/R2

---

## Open Questions

1. **E2B template strategy** — One shared "mako-runtime" template, or custom templates with pre-installed heavy SDKs?
2. **Sandbox timeout defaults** — 30s dev runs, 5 min production? Configurable per connector?
3. **Bundle size limits** — 1MB? 5MB?
4. **Rate limiting** — Max concurrent sandboxes per workspace? Per plan tier?
5. **TypeScript strictness** — Full `strict` mode or relaxed for vibing?
6. **Connector sharing** — Export as template? Secrets handling?
7. **Monitoring** — Feed into existing flow dashboard or new dedicated view?
