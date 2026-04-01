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

| Method | Endpoint       | Description                    |
| ------ | -------------- | ------------------------------ |
| `POST` | `/api/execute` | Execute a SQL or MongoDB query |

## Consoles

| Method | Endpoint                                    | Description                |
| ------ | ------------------------------------------- | -------------------------- |
| `GET`  | `/api/workspaces/:wid/consoles/list`        | List all consoles          |
| `GET`  | `/api/workspaces/:wid/consoles/:id/details` | Get console details + code |
| `POST` | `/api/workspaces/:wid/consoles/:id/execute` | Execute a saved console    |

See [Console](/console/) for full API documentation with examples.

## Flows

| Method | Endpoint                         | Description           |
| ------ | -------------------------------- | --------------------- |
| `POST` | `/api/workspaces/:wid/flows`     | Create/trigger a flow |
| `GET`  | `/api/workspaces/:wid/flows/:id` | Get flow status       |

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

## Inngest

| Method | Endpoint       | Description                        |
| ------ | -------------- | ---------------------------------- |
| `POST` | `/api/inngest` | Inngest webhook handler (internal) |
