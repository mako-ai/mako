---
title: Query Runner
description: Execute queries across 9 database engines with a uniform interface.
---

The Query Runner is Mako's database abstraction layer. It provides a single interface to execute queries across all supported databases, handling connection management, dialect differences, and result formatting.

## Supported Databases

| Database | Driver | Connection Type |
|---|---|---|
| PostgreSQL | `postgresql` | Host/port or connection string |
| Cloud SQL (Postgres) | `cloudsql-postgres` | Instance connection name |
| BigQuery | `bigquery` | Project ID + service account |
| MongoDB | `mongodb` | Connection string |
| MySQL | `mysql` | Host/port |
| ClickHouse | `clickhouse` | Host/port |
| Redshift | `redshift` | Host/port (PostgreSQL wire protocol) |
| SQLite | `sqlite` | File path |
| Cloudflare D1 | `cloudflare-d1` | Account ID + database ID |

## Adding a Database Connection

In the Mako UI:
1. Click **Databases** in the sidebar
2. Click **Add Connection**
3. Select the database type
4. Enter connection details
5. Click **Test Connection** to verify
6. Save

## IP Whitelisting

If your database requires IP whitelisting, add Mako's static outbound IP:

```
34.79.190.46
```

### MongoDB Atlas Specifics

Atlas connection strings need the database name as a path segment, not a query parameter:

```
# What Atlas gives you:
mongodb+srv://user:pass@cluster.mongodb.net/?appName=Cluster

# What Mako needs:
mongodb+srv://user:pass@cluster.mongodb.net/DatabaseName
```

## How It Works

The Query Runner uses a driver registry pattern. Each database type has a driver that implements:

- **Connection pooling** — Connections are cached and reused
- **Query execution** — Takes SQL/MongoDB queries and returns structured results
- **Schema inspection** — Lists databases, tables, columns, and sample data
- **Dialect handling** — Identifier quoting, type casting, and syntax differences

The AI agent uses the Query Runner under the hood — when it calls `sql_execute_query`, the Query Runner resolves the correct driver, executes against the right database, and returns results.
