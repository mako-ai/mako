---
title: AI Agent
description: How Mako's AI assistant works — tools, workflow, and multi-database support.
---

Mako's AI agent isn't a chatbot. It's a copilot with real tools — it can inspect your database schemas, write queries, execute them against live data, and place the working result directly in your console.

## How It Works

The agent follows a strict workflow:

1. **Discover** — Lists connections and inspects schemas to understand your data
2. **Write** — Generates a query based on your question and the actual schema
3. **Execute** — Runs the query against your real database
4. **Deliver** — Places the working query in your console editor via `modify_console`

The chat response is secondary — the console gets the working query.

## Agent Types

Mako has a multi-agent architecture with specialized agents:

### Console Agent
The default. Helps write and run database queries. Activated when you're working in a console tab.

- Reads your open consoles and their connections
- Understands which console is active
- Preserves existing console content unless asked to overwrite
- Creates new consoles when needed

### Flow Agent
Activated in flow editor tabs. Helps configure database-to-database sync flows.

- Inspects source and destination schemas
- Writes extraction queries with template placeholders
- Validates queries before applying
- Configures type coercions and column mappings

## Tools

The agent has access to these tool categories:

### Database Discovery
| Tool | What It Does |
|---|---|
| `list_connections` | Lists all database connections in the workspace |
| `sql_list_databases` / `mongo_list_databases` | Lists databases on a connection |
| `sql_list_tables` / `mongo_list_collections` | Lists tables/collections |
| `sql_inspect_table` / `mongo_inspect_collection` | Gets column types, sample data |

### Query Execution
| Tool | What It Does |
|---|---|
| `sql_execute_query` | Runs SQL against PostgreSQL, BigQuery, MySQL, SQLite, D1, Redshift |
| `mongo_execute_query` | Runs MongoDB aggregation pipelines or find queries |

### Console Management
| Tool | What It Does |
|---|---|
| `read_console` | Gets the current content of a console |
| `modify_console` | Updates a console with a working query |
| `create_console` | Creates a new console |
| `search_consoles` | Finds saved consoles by keyword |

### Self-Directive
| Tool | What It Does |
|---|---|
| `read_self_directive` | Reads the agent's persistent memory for this workspace |
| `update_self_directive` | Saves schema quirks, user preferences, and learned rules |

The self-directive persists across all conversations in a workspace. When the agent discovers that your `created_at` column is actually stored as a Unix timestamp, it saves that — and remembers it next time.

## Supported Databases

The agent auto-detects the database type from the connection and uses the correct SQL dialect:

| Database | Dialect | Notes |
|---|---|---|
| PostgreSQL | `postgresql` | Full support including arrays, JSON operators, `ILIKE` |
| Cloud SQL (Postgres) | `postgresql` | Same as PostgreSQL |
| BigQuery | `bigquery` | Backtick identifiers, `CAST()`, `REGEXP_CONTAINS()` |
| MongoDB | — | Aggregation pipelines, `find()`, collection inspection |
| MySQL | `mysql` | Backtick identifiers, `CONVERT()` |
| ClickHouse | `clickhouse` | Columnar-optimized queries |
| Redshift | `postgresql` | PostgreSQL wire-compatible |
| SQLite | `sqlite` | Including Cloudflare D1 |

## AI Models

Mako supports multiple AI providers. Available models depend on which API keys you configure:

- **OpenAI**: GPT-4o, GPT-5.2, GPT-5.2 Codex
- **Anthropic**: Claude Sonnet 4, Claude Opus 4 (with extended thinking)
- **Google**: Gemini 2.5 Pro, Gemini 2.5 Flash

Set the provider API keys in your `.env` file. Users can select their preferred model in the UI.

## Safety

- All SELECT queries are auto-limited to 500 rows unless explicitly overridden
- The agent tests queries before delivering them to the console
- Write operations require explicit user intent
