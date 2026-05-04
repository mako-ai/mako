---
title: API Reference
description: REST API endpoints for authentication, workspaces, queries, and the AI agent.
---

The Mako API is a RESTful API built with [Hono](https://hono.dev). All endpoints are prefixed with `/api`.

## Authentication

Two authentication methods:

1. **Session cookies** — For the web app (set automatically on login)
2. **API keys** — For programmatic access (prefix: `revops_`)

```bash
# API key authentication
Authorization: Bearer revops_YOUR_API_KEY
```

Create API keys in **Workspace settings → API Keys**. The same page surfaces your **Workspace ID** (the value to substitute for `:wid` / `:workspaceId` / `WORKSPACE_ID` below) with a copy button.

### Auth Endpoints

| Method | Endpoint             | Description                     |
| ------ | -------------------- | ------------------------------- |
| `POST` | `/api/auth/register` | Create account (email/password) |
| `POST` | `/api/auth/login`    | Login, returns session cookie   |
| `GET`  | `/api/auth/me`       | Get current user session        |
| `POST` | `/api/auth/logout`   | End session                     |
| `GET`  | `/api/auth/google`   | Google OAuth redirect           |
| `GET`  | `/api/auth/github`   | GitHub OAuth redirect           |

## Workspaces

| Method | Endpoint              | Description            |
| ------ | --------------------- | ---------------------- |
| `GET`  | `/api/workspaces`     | List user's workspaces |
| `POST` | `/api/workspaces`     | Create a workspace     |
| `GET`  | `/api/workspaces/:id` | Get workspace details  |

## Database Connections

| Method   | Endpoint                                   | Description         |
| -------- | ------------------------------------------ | ------------------- |
| `GET`    | `/api/workspaces/:wid/connectors`          | List connections    |
| `POST`   | `/api/workspaces/:wid/connectors`          | Add a connection    |
| `POST`   | `/api/workspaces/:wid/connectors/:id/test` | Test a connection   |
| `DELETE` | `/api/workspaces/:wid/connectors/:id`      | Remove a connection |

## Query Execution

Session cookie or `Authorization: Bearer revops_*` API key required. Use the database connection ID from `GET /api/workspaces/:wid/connectors`.

| Method | Endpoint                                                      | Description                                        |
| ------ | ------------------------------------------------------------- | -------------------------------------------------- |
| `POST` | `/api/workspaces/:wid/databases/:databaseId/execute`        | Run a query against one connection (`body.query`) |
| `POST` | `/api/workspaces/:wid/execute`                                | Execute with `query` / `queryDefinition`, pagination, exports (`POST …/execute/export` supports `format=arrow`, `parquet`, `ndjson`, `csv`) |

## Consoles

| Method | Endpoint                                    | Description                |
| ------ | ------------------------------------------- | -------------------------- |
| `GET`  | `/api/workspaces/:wid/consoles/list`        | List all consoles          |
| `GET`  | `/api/workspaces/:wid/consoles/:id/details` | Get console details + code |
| `POST` | `/api/workspaces/:wid/consoles/:id/execute` | Execute a saved console    |
| `PUT` | `/api/workspaces/:wid/consoles/:id/schedule` | Create or update a saved console schedule (admin only) |
| `DELETE` | `/api/workspaces/:wid/consoles/:id/schedule` | Remove a saved console schedule (admin only) |
| `POST` | `/api/workspaces/:wid/consoles/:id/schedule/run` | Trigger a scheduled console immediately (admin only) |
| `GET` | `/api/workspaces/:wid/consoles/:id/schedule/runs` | List scheduled run history (admin only) |
| `GET` | `/api/workspaces/:wid/scheduled-queries` | List scheduled consoles in the workspace (admin only) |

See [Console](/console/) for full API documentation with examples. Scheduled query endpoints require workspace admin access and use the same session/API-key authentication as other workspace endpoints.

## Flows

| Method | Endpoint                                                           | Description                                                  |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `POST` | `/api/workspaces/:wid/flows`                                       | Create/trigger a flow                                        |
| `GET`  | `/api/workspaces/:wid/flows/:id`                                   | Get flow status                                              |
| `GET`  | `/api/workspaces/:wid/flows/:id/sync-cdc/status`                   | Get CDC stream status                                        |
| `GET`  | `/api/workspaces/:wid/flows/:id/sync-cdc/schema-health`            | Compare live destination column types to the connector schema (BigQuery; detects drift) |
| `GET`  | `/api/workspaces/:wid/flows/:id/sync-cdc/destination-counts`       | Batched row counts per entity in the destination             |

### Destination Counts Response

Returns a map of CDC entity name to destination row count. Mako batches BigQuery and PostgreSQL counts into one metadata query and may return `0` for configured entities whose destination table does not exist yet.

```json
{
  "success": true,
  "data": {
    "contacts": 125000,
    "organizations": 8421,
    "opportunities": 0
  }
}
```

### Schema Health Response

```json
{
  "success": true,
  "data": {
    "hasDrift": true,
    "entities": [
      {
        "entity": "customers",
        "hasDrift": true,
        "columns": [
          { "column": "created_at", "liveType": "STRING", "expectedType": "TIMESTAMP", "status": "drift" },
          { "column": "id",         "liveType": "STRING", "expectedType": "STRING",    "status": "match" }
        ]
      }
    ]
  }
}
```

Accepts an optional `?entity=<name>` query parameter to scope the check to a single entity. Drift is auto-corrected on the next CDC merge — see [Schema Evolution](/data-sync/#schema-evolution-bigquery).

## Chat API (AI Agent)

The Chat API enables programmatic access to Mako's AI agent with streaming responses.

| Method | Endpoint            | Description                                  |
| ------ | ------------------- | -------------------------------------------- |
| `POST` | `/api/agent/chat`   | Send messages, receive streaming AI response |
| `GET`  | `/api/agent/models` | List available AI models                     |

### Chat Request

```bash
curl -X POST https://app.mako.ai/api/agent/chat \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Show me top 10 customers by revenue"}],
    "chatId": "optional-session-id",
    "workspaceId": "your-workspace-id",
    "model": "claude-sonnet-4-20250514"
  }'
```

### Streaming Response

The response is a **Server-Sent Events (SSE)** stream:

| Event Type             | Description                                 |
| ---------------------- | ------------------------------------------- |
| `start`                | Stream started, contains `messageId`        |
| `text-delta`           | Incremental text chunk from assistant       |
| `tool-input-available` | Tool call with full input (e.g., SQL query) |
| `tool-result`          | Tool execution result (e.g., query results) |
| `finish`               | Stream complete, contains `finishReason`    |

### Error Codes

| Status | Description                                               |
| ------ | --------------------------------------------------------- |
| 400    | Missing or invalid `messages`, `chatId`, or `workspaceId` |
| 401    | Unauthorized (missing or invalid API key)                 |
| 403    | API key not authorized for the workspace                  |
| 404    | Agent not found (invalid `agentId`)                       |

## Chat History

| Method   | Endpoint                         | Description        |
| -------- | -------------------------------- | ------------------ |
| `GET`    | `/api/workspaces/:wid/chats`     | List chat sessions |
| `POST`   | `/api/workspaces/:wid/chats`     | Create a new chat  |
| `GET`    | `/api/workspaces/:wid/chats/:id` | Get chat details   |
| `PUT`    | `/api/workspaces/:wid/chats/:id` | Update chat title  |
| `DELETE` | `/api/workspaces/:wid/chats/:id` | Delete a chat      |


## Skills

Workspace skills — named playbooks the agent can author and load on demand. See [Skills](/skills/) for the conceptual model.

| Method   | Endpoint                                            | Description                                   |
| -------- | --------------------------------------------------- | --------------------------------------------- |
| `GET`    | `/api/workspaces/:wid/skills`                       | List every skill in the workspace             |
| `GET`    | `/api/workspaces/:wid/skills/:id`                   | Get a single skill with full body             |
| `PUT`    | `/api/workspaces/:wid/skills/:id`                   | Edit `loadWhen`, `body`, or `entities`        |
| `POST`   | `/api/workspaces/:wid/skills/:id/suppress`          | Toggle the `suppressed` flag                  |
| `DELETE` | `/api/workspaces/:wid/skills/:id`                   | Permanently delete a skill                    |

All endpoints require authentication and workspace access. Agent-side CRUD is available through the `save_skill`, `delete_skill`, `load_skill`, and `search_skills` tools — see [AI Agent](/ai-agent/#targeted-playbooks-skills).

### Skill Response Shape

```json
{
  "success": true,
  "skill": {
    "id": "6620...",
    "name": "mrr_walkthrough_fr",
    "loadWhen": "Building a sales report or answering questions about MRR in France",
    "body": "...",
    "entities": ["mrr", "france", "subscriptions"],
    "suppressed": false,
    "useCount": 12,
    "createdBy": "6612...",
    "createdAt": "2026-04-23T12:36:00.000Z",
    "updatedAt": "2026-04-23T12:36:00.000Z"
  }
}
```

## Dashboards

| Method   | Endpoint                                                         | Description                          |
| -------- | ---------------------------------------------------------------- | ------------------------------------ |
| `GET`    | `/api/workspaces/:wid/dashboards`                                | List dashboards                      |
| `POST`   | `/api/workspaces/:wid/dashboards`                                | Create a dashboard                   |
| `GET`    | `/api/workspaces/:wid/dashboards/:did`                           | Get dashboard details                |
| `PUT`    | `/api/workspaces/:wid/dashboards/:did`                           | Update dashboard                     |
| `DELETE` | `/api/workspaces/:wid/dashboards/:did`                           | Delete dashboard                     |
| `POST`   | `/api/workspaces/:wid/dashboards/:did/duplicate`                 | Duplicate a dashboard                |

### Dashboard Folders

| Method   | Endpoint                                                         | Description                          |
| -------- | ---------------------------------------------------------------- | ------------------------------------ |
| `GET`    | `/api/workspaces/:wid/dashboard-folders`                         | List dashboard folders               |
| `POST`   | `/api/workspaces/:wid/dashboard-folders`                         | Create a folder                      |
| `PUT`    | `/api/workspaces/:wid/dashboard-folders/:fid`                    | Update a folder                      |
| `DELETE` | `/api/workspaces/:wid/dashboard-folders/:fid`                    | Delete a folder                      |

### Dashboard Materialization

| Method | Endpoint                                                                      | Description                                   |
| ------ | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `GET`  | `/api/workspaces/:wid/dashboards/:did/materialization/status`                 | Get materialization status for all data sources |
| `POST` | `/api/workspaces/:wid/dashboards/:did/materialization/trigger`                | Trigger materialization for a data source       |
| `POST` | `/api/workspaces/:wid/dashboards/:did/materialization/trigger-all`            | Trigger materialization for all data sources    |
| `GET`  | `/api/workspaces/:wid/dashboards/:did/materialization/stream/:dataSourceId`   | Stream Parquet artifact (supports range requests) |

## Inngest

| Method | Endpoint       | Description                        |
| ------ | -------------- | ---------------------------------- |
| `POST` | `/api/inngest` | Inngest webhook handler (internal) |

## Billing

Subscription management endpoints. All require workspace membership. When `BILLING_ENABLED` is `false` (self-hosted default), all endpoints return `{ "billingEnabled": false }`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workspaces/:wid/billing/status` | Get plan, usage quota, and subscription status |
| `POST` | `/api/workspaces/:wid/billing/checkout` | Create a Stripe Checkout session (returns `{ url }`) |
| `POST` | `/api/workspaces/:wid/billing/portal` | Create a Stripe Customer Portal session (returns `{ url }`) |

### Billing Status Response

```json
{
  "billingEnabled": true,
  "plan": "free",
  "subscriptionStatus": null,
  "usageQuotaUsd": 5,
  "hardLimitUsd": 5,
  "currentUsageUsd": 1.23,
  "modelTier": "free",
  "maxDatabases": 3,
  "maxMembers": 3
}
```

### Error Codes

| Status | Description |
|--------|-------------|
| 403 | Not a workspace owner or admin |
| 409 | Active subscription already exists (on checkout) |
