---
title: Roadmap
description: Where Mako is headed.
---

Mako is an AI-powered data platform. Here's what's shipped and what's next.

## Current (V1)

What's shipped and stable:

- **Console** — AI-powered SQL editor with schema-aware autocomplete
- **Multi-database support** — Connect PostgreSQL, MySQL, MongoDB, BigQuery, ClickHouse, Redshift, Cloud SQL, Cloudflare D1/KV
- **AI Agent** — Natural language to SQL, query explanation, schema discovery
- **Query Runner** — Execute, save, and share queries across your team
- **Collaboration** — Shared workspaces, saved queries, team access controls
- **Dashboards** — Interactive visual boards with charts (Vega-Lite), KPI cards, data tables, and cross-filtering. Powered by in-browser DuckDB. See [Dashboards](/dashboards/).

## Experimental

Features that work but are still evolving:

- **SaaS Connectors** — Pull data from Stripe, PostHog, Close CRM, and REST APIs into your data warehouse. Think of it as lightweight Fivetran built into your SQL client.
- **Data Sync & Flows** — Scheduled, resumable ETL pipelines with cursor-based pagination and automatic retries.

See the [Experimental](/connectors/) section in the docs for details.

## Planned

What's on the horizon (no timeline commitments):

- **Reverse ETL** — Write data back from your warehouse into SaaS tools (CRM updates, marketing lists, etc.).

## Philosophy

The product grows along a natural complexity curve:

1. **One database** — Mako is already useful as a SQL client
2. **Multiple databases** — Connect all of them, query from one place
3. **Data warehouse** — Get your SaaS data in (connectors)
4. **Visualize** — Dashboards on top of everything
5. **Write back** — Push processed data out (reverse ETL)

Each step builds on the previous one. We ship each layer when it's ready, not before.
