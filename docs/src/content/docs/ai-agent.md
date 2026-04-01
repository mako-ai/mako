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

## Multi-Agent Architecture

Different contexts activate different specialized agents:

### Console Agent (default)

Active when you're working in a console tab. This is the core SQL client experience — schema discovery, query writing, execution, and console delivery.

### Flow Agent

Active in the flow editor. Helps configure database-to-database sync flows — inspects source and destination schemas, writes extraction queries with template placeholders, and validates before applying.

## AI Models

Mako supports multiple providers. Configure API keys in `.env` and users select their preferred model in the UI:

- **Anthropic** — Claude Sonnet 4, Claude Opus 4 (with extended thinking)
- **OpenAI** — GPT-4o, GPT-5.2, GPT-5.2 Codex
- **Google** — Gemini 2.5 Pro, Gemini 2.5 Flash

## Safety

- SELECT queries are auto-limited to 500 rows unless you explicitly override
- Queries are tested before delivery — you get working SQL, not best-effort guesses
- Write operations require explicit user intent
