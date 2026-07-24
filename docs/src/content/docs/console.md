---
title: Console
description: The universal SQL client — write, run, and share queries across all your databases.
---

The Console is Mako's query editor. It connects to any database you've added and lets you write, execute, and save queries — with AI assistance built in.

## Features

- **Multi-database**: One editor for PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, SQLite, and more
- **AI-assisted**: Ask questions in natural language, get working queries placed in your editor
- **Saved queries**: Consoles persist in your workspace, organized in folders
- **Shareable**: Share with specific teammates as viewer/editor, or with the whole workspace (see [Sharing](#sharing))
- **API access**: Execute saved consoles programmatically via REST API
- **Scheduled queries**: Run saved consoles on cron schedules and inspect run history

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

### Version History

Every explicit save of a console creates an immutable version record. Open the history panel from the editor to browse past versions, preview them, and restore with one click. Full details: [Version History](/version-history/).

### Scheduling Saved Consoles

Workspace admins can schedule a saved console to run automatically from the console header. Scheduled consoles use five-field cron expressions plus an IANA timezone, for example `0 0 * * *` with `UTC` for a daily midnight run.

When a console is scheduled, Mako stores the next run time and executes it through Inngest. The schedule panel shows the latest run status, duration, row count, consecutive failures, and recent run history. You can attach **notifications** to a schedule (email, webhook, or Slack) — see [Notifications](/notifications/).

### Async Runs (Run now)

**Run now** triggers an asynchronous run of any saved console — no schedule required. Each run is queued through Inngest, executes in the background, and is recorded in the **Runs** tab below the editor. Use this to:

- Test a query end-to-end before attaching a schedule (notifications, retry behavior, row counts).
- Kick off a one-off backfill or ad-hoc refresh without blocking your editor session.
- Re-run a scheduled query immediately, off-cycle.

Triggering an async run requires workspace admin access and hits `POST /api/workspaces/:wid/consoles/:id/schedule/run`.

### Runs Tab

The **Runs** tab below the editor lists the console's recent query executions (retained for ~90 days) — not just scheduled runs. Each row shows status, duration, row count, and a **Trigger** label identifying what ran the query: App UI, API key, MCP, AI agent, Schedule, or Flow. External triggers (API key, MCP) are highlighted and show a key suffix when available. For scheduled consoles, the scheduled run history appears as a subsection.

The same history is available programmatically via `GET /api/workspaces/:wid/consoles/:id/executions` and to agents via the `list_console_executions` tool.

## Live Editing & Streaming

When the agent edits a console, changes are applied **server-side to the authoritative draft** and any open windows update live — you don't have to be the one driving the chat to see the edit land.

Edits are **incremental, not all-or-nothing**. `modify_console` supports four actions:

- **`patch`** — replace a specific 1-indexed, inclusive line range (preferred for small edits, e.g. changing a single `WHERE` clause). Produces a tight, reviewable diff instead of rewriting the whole query.
- **`replace`** — swap the full content.
- **`insert`** — add content at a position.
- **`append`** — add to the end.

The agent reads the current content with `read_console` (which returns line-numbered text) to target the right range before patching. If a console is read-only to the agent (a workspace console it doesn't own, and it isn't an admin), modification is rejected and the agent creates a copy with `create_console` instead.

Tool inputs stream as they generate, so edit cards reflect work in progress rather than blocking on a spinner until the full payload arrives.

## Sharing

Consoles use the same **Google Workspace-style** sharing model as [dashboards](/dashboards/#sharing--collaborators):

- **Per-user collaborators** — add specific teammates as `viewer` (read-only) or `editor` (read + write) from the console's **Share** dialog.
- **General access** — set the console to `private` (owner + collaborators only) or `workspace` (every member), with a `workspaceRole` of `viewer` or `editor` controlling what members can do.
- Only the **owner**, or a workspace **owner/admin** for non-private consoles, can manage sharing.

Unlike dashboards and apps, consoles do **not** support unauthenticated public links — they execute live queries against your databases, so access always requires workspace authentication.

## Console API

Saved consoles can be executed programmatically. This is useful for building dashboards, automations, or integrations on top of your queries.

### Authentication

Create an API key in **Workspace settings → API Keys**. The same page shows your **Workspace ID** with a copy button — substitute it for `WORKSPACE_ID` in the examples below. Include the key in requests:

```bash
Authorization: Bearer revops_YOUR_API_KEY
```

### Endpoints

| Method | Endpoint                                    | Description                |
| ------ | ------------------------------------------- | -------------------------- |
| `GET`  | `/api/workspaces/:wid/consoles/list`        | List all consoles          |
| `GET`  | `/api/workspaces/:wid/consoles/:id/details` | Get console details + code |
| `POST` | `/api/workspaces/:wid/consoles/:id/execute` | Execute a console          |
| `PUT` | `/api/workspaces/:wid/consoles/:id/schedule` | Create or update a schedule (admin only) |
| `DELETE` | `/api/workspaces/:wid/consoles/:id/schedule` | Remove a schedule (admin only) |
| `POST` | `/api/workspaces/:wid/consoles/:id/schedule/run` | Trigger a scheduled console now (admin only) |
| `GET` | `/api/workspaces/:wid/consoles/:id/schedule/runs` | List scheduled run history (admin only) |
| `GET` | `/api/workspaces/:wid/consoles/:id/executions` | List recent query executions (any trigger, ~90-day retention) |
| `GET` | `/api/workspaces/:wid/scheduled-queries` | List scheduled consoles in the workspace (admin only) |

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
