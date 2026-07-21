---
title: AI-Powered SQL Client
description: A SQL client where AI is the interface — ask questions in plain English, get working queries in your console.
---

Mako is a SQL client. The AI is how you talk to it.

Instead of manually browsing schemas, writing queries from scratch, and iterating through syntax errors, you describe what you want in plain English. Mako inspects your database, writes the query, tests it against your live data, and places the working result directly in your console editor — ready to run, tweak, or save.

The chat is secondary. The console is the product.

## The Workflow

Every interaction follows the same pattern:

1. **You ask a question** — "Show me users who signed up last week but haven't made a purchase"
2. **Mako inspects your schema** — discovers tables, columns, types, relationships
3. **Writes and tests the query** — executes it against your real database to verify it works
4. **Delivers to your console** — the working query appears in your editor via `modify_console`

You get a brief explanation in chat, but the real output is always a working query in your console.

## Console-First Design

The console is a full SQL editor — not a chat window with code blocks you copy-paste from. Mako treats it as the primary output:

- **Preserves your work** — won't overwrite a console with valuable content. Creates a new tab instead.
- **Reads before writing** — always checks the current console state before modifying
- **Supports patching** — for small edits (adding a WHERE clause, fixing a column name), it patches specific lines instead of replacing everything
- **Multiple consoles** — each query gets its own tab, organized by topic
- **Reviewable edits** — agent edits to an existing console arrive as a Monaco Accept/Reject diff rather than overwriting your buffer. Your editor keeps the pre-agent baseline until you resolve the review: **Accept** adopts the agent's version, **Reject** reverts it. Cumulative edits across a turn diff against the original baseline, and a pending review re-surfaces if you reload or reconnect mid-edit. (Renames apply immediately as metadata, not part of the content diff.)

## Multi-Database Support

Mako auto-detects the database type from your connection and adapts its SQL dialect:

| Database   | Dialect      | Notes                                               |
| ---------- | ------------ | --------------------------------------------------- |
| PostgreSQL | `postgresql` | Full support — arrays, JSON operators, `ILIKE`      |
| Cloud SQL  | `postgresql` | Same as PostgreSQL                                  |
| BigQuery   | `bigquery`   | Backtick identifiers, `CAST()`, `REGEXP_CONTAINS()` |
| MongoDB    | Aggregation  | Pipelines, `find()`, collection inspection          |
| MySQL      | `mysql`      | Backtick identifiers, `CONVERT()`                   |
| ClickHouse | `clickhouse` | Columnar-optimized queries                          |
| Redshift   | `postgresql` | PostgreSQL wire-compatible                          |
| SQLite     | `sqlite`     | Including Cloudflare D1                             |

You don't configure dialects — Mako reads the connection metadata and does the right thing.

## Schema Discovery

Before writing any query, Mako inspects your actual schema. No guessing, no hallucinated column names:

| Tool                                             | What It Does                                    |
| ------------------------------------------------ | ----------------------------------------------- |
| `list_connections`                               | Shows all database connections in the workspace |
| `sql_list_databases` / `mongo_list_databases`    | Lists databases on a connection                 |
| `sql_list_tables` / `mongo_list_collections`     | Lists tables/collections with row counts        |
| `sql_inspect_table` / `mongo_inspect_collection` | Gets column types, constraints, and sample data |

The agent uses sample data to understand real values — not just types. If your `status` column contains `'active'`, `'churned'`, `'trial'`, it knows what to filter on.

## Persistent Memory (Self-Directive)

Mako learns your database over time. When it discovers that your `created_at` column stores Unix timestamps instead of dates, or that your `users` table uses `uuid` instead of `id` as the primary key, it saves that knowledge:

| Tool                    | What It Does                                  |
| ----------------------- | --------------------------------------------- |
| `read_self_directive`   | Reads learned rules for this workspace        |
| `update_self_directive` | Saves schema quirks, preferences, conventions |

This persists across all conversations. The more you use Mako, the less explaining you need to do.


## Targeted Playbooks (Skills)

Beyond the always-on self-directive, Mako supports **skills** — named, workspace-scoped playbooks that load only when their trigger fires. Good for per-country queries, multi-step procedures, or rare schema gotchas that shouldn't clutter the always-on memory.

| Tool            | What It Does                                                |
| --------------- | ----------------------------------------------------------- |
| `save_skill`    | Create or overwrite a named playbook                        |
| `delete_skill`  | Retract a skill that turned out to be wrong                 |
| `load_skill`    | Explicitly load a skill mid-turn when the index hints at it |
| `search_skills` | Free-text fallback when the auto-injected index misses      |

Every turn, Mako injects a compact index of every skill plus the top-3 auto-retrieved bodies (entity overlap 0.6 + semantic similarity 0.4). See [Skills](/skills/) for the full model, admin UI, and REST API.

Skill _retrieval_ (`get_relevant_skills`, `load_skill`) is always active; skill _writes_ and long-tail lookups (`save_skill`, `delete_skill`, `list_skills`, `search_skills`, `read_skill_resource`) are deferred tools the agent activates on demand — see [Tool paging](#tool-paging) below.

## Expertise Modes

Mako runs a **single unified agent**, not a fleet of separate agents. Capability is loaded dynamically: the agent switches *expertise modes* mid-conversation via the `enable_mode` tool, and each mode unlocks a domain-specific toolset plus guidance. A small set of core tools (memory, skill retrieval, web access, planning, mode-switching, tool discovery) is always available regardless of mode; everything else is either mode-scoped or deferred (see [Tool paging](#tool-paging)).

On a fresh request the default mode is picked from what you're looking at — a dashboard view opens in **Dashboard**, the flow editor in **Sync Flow**, an app in **React App**, a dbt file/job in **Transforms**, a notebook in **Notebook** — otherwise **Query**. The agent then switches as the task demands.

| Mode | Does |
|------|------|
| **Query** (default) | Build and run queries in consoles (SQL, MongoDB), funnels, reports, and analyses |
| **Dashboard** | Create and edit dashboards, widgets, data sources, filters, and charts |
| **Sync Flow** | Configure database-to-database sync flows, query templates, and schema mapping |
| **React App** | Build [React apps](/apps/) wired to workspace data — edit files, add dependencies, create data bindings |
| **Transforms** | Build and run [dbt transformations](/transforms/) — edit project files, compile, test, and run models against the warehouse |
| **Notebook** | Build [notebooks](/notebooks/) — add SQL/Python/Markdown cells, run SQL against data sources and Python on the managed kernel, iterate on results |
| **Explore** | Read-only investigation across connections, consoles, dashboards, and memory |

`Explore` is read-only by design. Mode ids persist in chat history, so renames stay backward-compatible (the legacy `dbt` mode resolves to `transform`). Enabling a mode adds its tools — modes accumulate across a turn rather than replacing one another.

### Tool Paging

The provider request carries a bounded **working set** of tools instead of every registered tool. Every tool sits in one of three tiers:

- **core** — always active (lifecycle, memory, skill retrieval, web access, tool discovery)
- **mode** — activates with an expertise mode
- **deferred** — registered and executable (approval flow intact) but dormant: all MCP tools plus demoted built-ins (skill writes, version history)

Deferred tools are discoverable via the `search_tools` meta-tool (compact cards, no schemas) and activated with `load_tools`, which mutates the active set exactly like `enable_mode` and replays statelessly from the chat transcript. A deterministic per-turn relevance preload activates obviously-relevant deferred tools from the last user message, so common cases need no search/load round-trip.

Budgets: at most 110 active tools and ~12k tokens of tool definitions per step, whichever binds first — with per-provider hard caps as a backstop (xAI rejects requests above 250 tools, OpenAI above 128). Core and mode tools are never evicted; loaded deferred tools are evicted oldest-first. Small workspaces whose whole tool surface fits the budget bypass paging entirely and keep the zero-friction behavior. When paging is active, the system prompt lists deferred sources one line per connector, and provider-facing MCP tool descriptions are truncated (full descriptions stay in the search catalog).

`pnpm --filter api tools:measure` prints per-tool token weights and per-mode totals.

### Plan Gate

There is no user-facing plan/agent toggle. The model decides when planning is worthwhile: the moment it calls `submit_plan` in a turn, mutating tools are hard-gated until you approve the plan. Read-only and lifecycle tools (e.g. `enable_mode`, `todo_write`, `ask_clarifying_questions`, `search_tools`, `load_tools`) stay available throughout — finding and loading a tool mutates nothing, and loaded write-tools remain gated.

### Dashboard specifics

Dashboards combine saved queries (consoles) into interactive visualizations powered by in-browser DuckDB and Vega-Lite charts:

- **Data sources** — dashboard-local query definitions materialized into a local DuckDB instance
- **Widgets** — charts (Vega-Lite), KPI cards, and data tables querying the local data
- **Cross-filtering** — clicking a bar or slice in one chart filters all others automatically
- **Global filters** — dashboard-level date range pickers, dropdowns, and search fields
- **Multi-dashboard** — multiple dashboards open simultaneously, each with its own isolated DuckDB instance

Edit-mode locking is handled automatically so concurrent users cannot conflict.

## Version-Aware Tools

Two tools inspect the history of saved consoles and dashboards. They are deferred — the agent activates them via `search_tools`/`load_tools` (or the relevance preload) when a history question comes up:

- `browse_version_history` — list past versions of a console or dashboard with author, timestamp, and comment.
- `get_version_snapshot` — fetch the full snapshot of a specific version.

Both are workspace-scoped. See [Version History](/version-history/).

## Visual Inspection

The agent can capture screenshots of the live UI for visual QA via the **`capture_screenshot`** client tool. It runs in the browser (no server round-trip) and returns a PNG that the agent inspects directly. Supported targets:

| Target | Captures |
|--------|----------|
| `active_dashboard` | The current dashboard — for visual QA of layout and charts |
| `active_tab` | The current main tab |
| `app_shell` | The full Mako app UI |
| `widget` | A specific dashboard widget |
| `viewport` | The current visible page |
| `selector` | A specific element matched by a CSS selector |

This lets the agent verify dashboard rendering (chart legibility, overlap, layout reflow) and debug UI issues by actually looking at the result rather than reasoning blind.

## Web Access

When a request needs information from the public internet — a pasted URL, an online document, or fresh facts not in your data — the agent reaches for two web tools. They are always active in every expertise mode (usage guidance lives in the `web` skill):

| Tool | What It Does |
|------|--------------|
| `fetch_url` | Reads a specific public URL in full. Handles HTML, PDF, CSV, JSON, and plain text. Returns up to `max_chars` characters (20k default, 50k max). |
| `web_search` | Searches the web for current information. Returns ranked results as `{ title, url, snippet }`. Follow up with `fetch_url` to read a result in full. |

Typical flow: if you paste a URL, the agent calls `fetch_url` directly; for an open-ended question needing fresh context, it runs `web_search` first, then `fetch_url` on the best one or two results, and cites the source.

**Limits:**

- Public `http`/`https` URLs only — no authenticated pages and no internal/private networks (requests are validated by a safe-fetch guard).
- Static fetch only — JavaScript is not executed, so client-rendered SPAs may return incomplete content.
- `web_search` is only available when a search provider is configured for the workspace.

## AI Models

Mako routes all AI requests through the **Vercel AI Gateway**, which provides access to 180+ models across Anthropic, OpenAI, Google, DeepSeek, and others. Only `AI_GATEWAY_API_KEY` is required — no individual provider API keys needed.

Models are discovered dynamically at runtime by merging the Gateway model catalog with [arena.ai](https://arena.ai) code leaderboard ELO scores. The catalog refreshes hourly.

### Free vs Pro Models

When billing is enabled, models are split into two tiers:

| Tier | Criteria | Examples |
|------|----------|---------|
| **Free** | Blended cost ≤ $3 / 1M tokens | GPT-4o Mini, Gemini 2.5 Flash, DeepSeek Chat |
| **Pro** | All other models | Claude Sonnet 4, GPT-4o, Gemini 2.5 Pro |

The top 3 free-tier models are auto-selected by ELO ranking. Free users are gated to free-tier models. Pro users can access all models.

When billing is disabled (self-hosted default), all models are available to all users.

### Thinking / Reasoning Models

Models tagged with `reasoning` in the Gateway catalog automatically enable extended thinking.

For Anthropic models, Mako picks between two thinking payloads:

- **Adaptive** (Claude 4.6 and newer, including models without version-numbered IDs like Fable 5) — the model manages its own reasoning effort. Reasoning is streamed in summarized form.
- **Manual** (pre-4.6 Claude models) — a fixed `budget_tokens` allowance, 10,000 tokens by default.

The mode is resolved in three layers: probed capabilities persisted in the model catalog (populated at catalog refresh), an explicit per-model map, and a fallback of adaptive for any uncatalogued Claude model. If the chosen mode is still wrong, the API returns a 400 — Mako self-heals by persisting the corrected mode and retrying the call once, so users never see the error.

### Model Selection

Users pick their preferred model in the chat UI. The model is persisted per-user in workspace settings. If a user's saved model becomes unavailable (e.g. billing downgrade), Mako falls back to the best available model for their plan.

### Utility / Fast Model

Cheap, high-volume tasks — AI-suggested version commit messages, summaries, and other internal helpers — run on a dedicated **utility model** instead of the user's chosen chat model. By default Mako auto-selects the cheapest capable tool-use model, cheapest first.

A super admin can pin an explicit utility model from **Settings → Admin → Model curation** (`PUT /api/admin/catalog/defaults` with `utilityModelId`). The pinned model is promoted to the front of the ranking as long as it stays visible in the catalog; if it disappears, Mako falls back to the cheapest available model. Set it to `null` to return to automatic selection.

## Long-Running Queries

Queries that take a while no longer fail at a fixed timeout. When the agent calls `run_console`, the query runs as a *detached server-side task* that outlives the tool call:

- If it finishes within a short soft timeout (`QUERY_SOFT_TIMEOUT_MS`, ~90s default), the rows come back immediately, as before.
- If it's still running after that, `run_console` returns `{ status: "running", executionId }` and the query **keeps running** server-side — nothing is cancelled.

The agent then calls `check_query_status` to fetch the result, and can stop a run with `cancel_query`. `check_query_status` **long-polls server-side** (`QUERY_STATUS_POLL_WAIT_MS`, ~30s default): it blocks until the run settles or the wait window elapses, then returns. This throttles the agent to roughly one poll per window — an LLM can't sleep between tool calls, so without server-side blocking it would re-poll every ~1s and flood the chat UI:

| Tool                 | What It Does                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `run_console`        | Executes a console's query as a detached run; returns rows, or `status: "running"` + `executionId`   |
| `check_query_status` | Polls a running query by `consoleId` (+ optional `executionId`); returns `running`/`success`/`error`/`cancelled` |
| `cancel_query`       | Aborts a running detached query (task + engine-native cancel)                                         |

Results land via the persisted `lastRun` record and the realtime `console.run.completed` pipeline, so result polling works across server instances for **every engine** — no re-attach and no Inngest dependency (multi-instance realtime fan-out uses `REDIS_URL`). A server-side hard cap (`QUERY_HARD_MAX_EXECUTION_MS`, 5 minutes default) aborts any detached run that exceeds it, so no query can run forever.

The short, single-shot execute tools (`sql_execute_query`, `mongo_execute_query`) stay on a brief timeout (`AGENT_DIRECT_QUERY_TIMEOUT_MS`, 60s default) for quick exploration; when one times out, the agent moves the query into a console and uses the resumable `run_console` flow instead.

## Safety

- SELECT queries are auto-limited to 500 rows unless you explicitly override
- Queries are tested before delivery — you get working SQL, not best-effort guesses
- Write operations require explicit user intent
