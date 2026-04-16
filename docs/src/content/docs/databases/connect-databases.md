---
title: Connect Databases
description: How to connect your databases to Mako.
---

Mako connects to your databases directly — no data leaves your infrastructure. You get AI-powered SQL, schema exploration, and query collaboration on top of your existing databases.

## Supported Databases

| Database                 | Protocol             | Query Language  |
| ------------------------ | -------------------- | --------------- |
| **PostgreSQL**           | TCP (port 5432)      | SQL             |
| **MySQL**                | TCP (port 3306)      | SQL             |
| **MongoDB**              | MongoDB protocol     | MongoDB queries |
| **BigQuery**             | Google Cloud API     | SQL             |
| **ClickHouse**           | HTTP / native        | SQL             |
| **Amazon Redshift**      | TCP (port 5439)      | SQL             |
| **Cloud SQL (Postgres)** | Cloud SQL Auth Proxy | SQL             |
| **Cloudflare D1**        | Cloudflare API       | SQL             |
| **Cloudflare KV**        | Cloudflare API       | JavaScript      |

## Adding a Database

1. Go to **Settings → Databases** in your workspace
2. Select the database type
3. Enter your connection details (host, port, credentials, database name)
4. Click **Test Connection** to verify
5. Save — Mako will discover your schema automatically

## IP Whitelisting

If your database requires IP whitelisting, add the following address to your allowlist:

```
34.79.190.46
```

This is the static outbound IP used by Mako's cloud service for all database connections.

## Database-Specific Notes

### PostgreSQL

Standard connection string format:

```
postgresql://user:password@host:5432/database
```

Works with any Postgres-compatible database (Supabase, Neon, etc.). SSL connections are supported.

### MySQL

Standard connection string format:

```
mysql://user:password@host:3306/database
```

#### SSH Tunnel

If your MySQL server is not directly accessible (e.g. it's behind a bastion host or inside a private VPC), Mako supports SSH tunneling. Enable it in the connection settings and provide:

| Field | Description |
|-------|-------------|
| **SSH Host** | Hostname or IP of the SSH bastion/jumphost |
| **SSH Port** | Port for SSH (default: 22) |
| **SSH Username** | Username to authenticate with on the bastion |
| **Auth Method** | `Password` or `Private Key` |
| **Password / Private Key** | Credentials for SSH authentication. Private keys can be RSA/Ed25519. Optional passphrase supported. |
| **Remote Host** | The MySQL host as seen *from* the bastion (often `127.0.0.1` or a private hostname) |
| **Remote Port** | MySQL port on the remote side (default: 3306) |

Mako opens the tunnel, forwards traffic through a local ephemeral port, and reuses the tunnel for subsequent queries (idle tunnels expire after 5 minutes).

### MongoDB

When connecting via MongoDB Atlas, the connection string format differs from what Atlas shows:

**Atlas gives you:**

```
mongodb+srv://user:password@cluster.server.mongodb.net/?appName=MyCluster
```

**Mako needs:**

```
mongodb+srv://user:password@cluster.server.mongodb.net/MyCluster
```

Note the query parameter (`?appName=`) becomes a path segment (`/MyCluster`).

**Atlas IP whitelisting:** Go to **Network Access** in your Atlas project → **Add IP Address** → enter `34.79.190.46` → **Confirm**.

### BigQuery

Requires a Google Cloud service account with BigQuery access. Upload the service account JSON key file when adding the connection.

### ClickHouse

Connects over HTTP. Default port is `8123` (HTTP) or `9000` (native). Cloud-hosted ClickHouse (e.g. ClickHouse Cloud) is supported.

### Amazon Redshift

Standard Redshift connection using the Postgres wire protocol:

```
postgresql://user:password@cluster.region.redshift.amazonaws.com:5439/database
```

### Cloud SQL (Postgres)

For Google Cloud SQL instances with the Auth Proxy. Provide the instance connection name (e.g. `project:region:instance`) and credentials.

### Cloudflare D1

Connects via the Cloudflare API. Requires your Cloudflare account ID and an API token with D1 permissions.

### Cloudflare KV

Connects via the Cloudflare API. Uses JavaScript for key-value operations rather than SQL. Requires your Cloudflare account ID, namespace ID, and an API token.

## Multiple Databases

You can connect as many databases as you need — even different types. Mako handles the driver differences transparently. The AI agent knows which dialect to use for each database.
