---
title: API Reference
description: Key API endpoints in Mako.
---

The Mako API is a RESTful API built with Hono. All endpoints are prefixed with `/api`.

## Authentication

| Method | Endpoint             | Description               |
| :----- | :------------------- | :------------------------ |
| `POST` | `/api/auth/login`    | Login with email/password |
| `POST` | `/api/auth/register` | Create a new account      |
| `GET`  | `/api/auth/me`       | Get current user session  |
| `POST` | `/api/auth/logout`   | End session               |

## Workspaces

| Method | Endpoint              | Description           |
| :----- | :-------------------- | :-------------------- |
| `GET`  | `/api/workspaces`     | List user workspaces  |
| `POST` | `/api/workspaces`     | Create a workspace    |
| `GET`  | `/api/workspaces/:id` | Get workspace details |

## Connectors & Flows

| Method | Endpoint                              | Description                  |
| :----- | :------------------------------------ | :--------------------------- |
| `GET`  | `/api/workspaces/:wid/connectors`     | List configured data sources |
| `POST` | `/api/workspaces/:wid/connectors`     | Add a new data source        |
| `POST` | `/api/workspaces/:wid/flows`          | Trigger a flow               |
| `GET`  | `/api/workspaces/:wid/flows/:fid`     | Get flow status              |

## Query Execution

| Method | Endpoint       | Description               |
| :----- | :------------- | :------------------------ |
| `POST` | `/api/execute` | Execute a SQL/NoSQL query |

## AI Agent / Chat API

The Chat API enables programmatic access to Mako's AI agent. It supports both session-based and API key authentication.

| Method | Endpoint           | Description                                    |
| :----- | :----------------- | :--------------------------------------------- |
| `POST` | `/api/agent/chat`  | Send messages and receive streaming AI response |
| `GET`  | `/api/agent/models` | List available AI models                       |
| `GET`  | `/api/agent/agents` | List available agent modes                     |

### Authentication

Use an API key in the `Authorization` header:

```
Authorization: Bearer revops_YOUR_API_KEY
```

API keys are created in Settings → API Keys. Each key is scoped to a workspace. Chats created via API key are attributed to the key's creator, so they appear in the creator's chat history.

### Request Body (`POST /api/agent/chat`)

| Field          | Type             | Required | Description                                                              |
| :------------- | :--------------- | :------- | :----------------------------------------------------------------------- |
| `messages`     | `UIMessage[]`    | Yes      | Array of messages. Each has `id`, `role`, and `parts`.                   |
| `chatId`       | `string`         | Yes      | 24-char MongoDB ObjectId. New ID for new chats; reuse for follow-ups.    |
| `workspaceId`  | `string`         | Yes      | 24-char MongoDB ObjectId. Must match the API key's workspace.            |
| `modelId`      | `string`         | No       | Model ID (e.g. `gpt-5.2`, `gemini-2.5-flash`). Default: `gpt-5.2`.     |
| `openConsoles` | `object[]`       | No       | Console context for SQL tools.                                           |
| `consoleId`    | `string`         | No       | Active console ID.                                                       |
| `agentId`      | `string`         | No       | Agent mode: `console` (default) or `flow`.                               |

### Message Format

```json
{
  "id": "unique-id",
  "role": "user",
  "parts": [{ "type": "text", "text": "Your message here" }]
}
```

### Example Request

```bash
curl -X POST https://your-mako.com/api/agent/chat \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "id": "1",
      "role": "user",
      "parts": [{ "type": "text", "text": "Show top 5 customers" }]
    }],
    "chatId": "507f1f77bcf86cd799439011",
    "workspaceId": "YOUR_WORKSPACE_ID",
    "modelId": "gemini-2.5-flash"
  }'
```

### Response Format

The response is a **streaming SSE** (Server-Sent Events) stream. Key event types:

| Event Type             | Description                                          |
| :--------------------- | :--------------------------------------------------- |
| `start`               | Stream started. Contains `messageId`.                 |
| `text-delta`          | Incremental text chunk from the assistant.            |
| `tool-input-available` | Tool call with full input (e.g. SQL query).          |
| `tool-result`         | Tool execution result (e.g. query results).           |
| `finish`              | Stream finished. Contains `finishReason`.             |

### Error Codes

| Status | Description                                     |
| :----- | :---------------------------------------------- |
| 400    | Missing or invalid `messages`, `chatId`, or `workspaceId`. |
| 401    | Unauthorized (missing or invalid API key).      |
| 403    | API key not authorized for the workspace.       |
| 404    | Agent not found (invalid `agentId`).            |

For full details, see [CHAT_API_REFERENCE.md](/docs/CHAT_API_REFERENCE.md).

## Chat History

| Method   | Endpoint                              | Description        |
| :------- | :------------------------------------ | :----------------- |
| `GET`    | `/api/workspaces/:wid/chats`          | List chat sessions |
| `POST`   | `/api/workspaces/:wid/chats`          | Create a new chat  |
| `GET`    | `/api/workspaces/:wid/chats/:id`      | Get chat details   |
| `PUT`    | `/api/workspaces/:wid/chats/:id`      | Update chat title  |
| `DELETE` | `/api/workspaces/:wid/chats/:id`      | Delete a chat      |

## Console API

For executing saved consoles programmatically, see [CONSOLE_API_DOCUMENTATION.md](/CONSOLE_API_DOCUMENTATION.md).

## Inngest

| Method | Endpoint       | Description             |
| :----- | :------------- | :---------------------- |
| `POST` | `/api/inngest` | Inngest webhook handler |
