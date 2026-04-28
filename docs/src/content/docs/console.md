---
title: Console
description: The universal SQL client — write, run, and share queries across all your databases.
---

The Console is Mako's query editor. It connects to any database you've added and lets you write, execute, and save queries — with AI assistance built in.

## Features

- **Multi-database**: One editor for PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, SQLite, and more
- **AI-assisted**: Ask questions in natural language, get working queries placed in your editor
- **Saved queries**: Consoles persist in your workspace, organized in folders
- **Shareable**: Share consoles with your team via the workspace
- **API access**: Execute saved consoles programmatically via REST API

## Working with Consoles

### Creating a Console

Click the + button in the sidebar to create a new console. Select a database connection and start writing.

### Running Queries

Hit `Cmd+Enter` (Mac) or `Ctrl+Enter` to execute. Results appear in a table below the editor.

### Using AI

Open the chat panel and describe what you want. The agent will:

1. Inspect your database schema
2. Write or revise the query
3. Execute it to verify it works
4. Place the result in your console

When the agent edits a console, the chat shows the target console name and a compact diff preview of the change. Click the console name in the tool card to jump back to that console. Large edits are truncated in the preview, so use the editor as the source of truth for the full generated SQL.

### Organizing

Consoles can be organized into folders. Use the sidebar tree to drag and arrange.

## Console API

Saved consoles can be executed programmatically. This is useful for building dashboards, automations, or integrations on top of your queries.

### Authentication

Create an API key in workspace settings. Include it in requests:

```bash
Authorization: Bearer revops_YOUR_API_KEY
```

### Endpoints

| Method | Endpoint                                    | Description                |
| ------ | ------------------------------------------- | -------------------------- |
| `GET`  | `/api/workspaces/:wid/consoles/list`        | List all consoles          |
| `GET`  | `/api/workspaces/:wid/consoles/:id/details` | Get console details + code |
| `POST` | `/api/workspaces/:wid/consoles/:id/execute` | Execute a console          |

### Example

```bash
# Execute a saved console
curl -X POST \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  https://app.mako.ai/api/workspaces/WORKSPACE_ID/consoles/CONSOLE_ID/execute
```

Response:

```json
{
  "success": true,
  "results": [
    { "name": "Alice", "revenue": 12500 },
    { "name": "Bob", "revenue": 8900 }
  ],
  "metadata": {
    "rowCount": 2,
    "executionTimeMs": 145
  }
}
```
