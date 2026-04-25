---
title: Version History
description: Immutable snapshots for saved consoles and dashboards — browse, view, and restore past versions.
---

Every saved console and dashboard has a full, immutable version history. Every save creates a new version record capturing the complete state at that point in time. Versions are never rewritten or deleted.

## How It Works

- Each console or dashboard has a monotonically increasing `version` number on the main document.
- Every save creates an `EntityVersion` record in MongoDB scoped to `(entityType, entityId, version)`.
- Snapshots capture the full entity state (for consoles: code, language, chart spec, connection; for dashboards: widgets, data sources, layout).
- Restoring a past version writes the old snapshot into the main document **and** appends a new version record (with `restoredFrom` set), so the timeline is never lost.

Version numbers are unique per entity and enforced by a unique index on `(entityType, entityId, version)`. Retry logic handles the rare case of concurrent writers picking the same version number.

## REST API

All endpoints live under the workspace path and require workspace membership.

### Consoles

| Method | Endpoint                                                      | Description                              |
| ------ | ------------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/workspaces/:wid/consoles/:id/versions`                  | List versions (paginated, newest first)  |
| `GET`  | `/api/workspaces/:wid/consoles/:id/versions/:version`         | Get a specific version snapshot          |
| `POST` | `/api/workspaces/:wid/consoles/:id/versions/:version/restore` | Restore the console to that version      |

### Dashboards

| Method | Endpoint                                                        | Description                              |
| ------ | --------------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/workspaces/:wid/dashboards/:did/versions`                 | List versions (paginated, newest first)  |
| `GET`  | `/api/workspaces/:wid/dashboards/:did/versions/:version`        | Get a specific version snapshot          |
| `POST` | `/api/workspaces/:wid/dashboards/:did/versions/:version/restore` | Restore the dashboard to that version    |

### Query Parameters (list endpoints)

| Param    | Default | Max | Description                      |
| -------- | ------- | --- | -------------------------------- |
| `limit`  | 50      | 100 | Number of versions to return     |
| `offset` | 0       | —   | Pagination offset                |

### List Response

```json
{
  "success": true,
  "versions": [
    {
      "version": 7,
      "savedBy": "user_abc123",
      "savedByName": "Alice Doe",
      "comment": "Added filter on status",
      "restoredFrom": null,
      "createdAt": "2026-04-22T14:10:32.000Z"
    }
  ],
  "total": 7
}
```

### Snapshot Response

```json
{
  "success": true,
  "version": {
    "version": 7,
    "savedBy": "user_abc123",
    "savedByName": "Alice Doe",
    "comment": "Added filter on status",
    "restoredFrom": null,
    "createdAt": "2026-04-22T14:10:32.000Z",
    "snapshot": { "code": "SELECT ...", "language": "sql" }
  }
}
```

### Restore Response

```json
{
  "success": true,
  "message": "Restored to version 5",
  "version": 8,
  "restoredFrom": 5
}
```

Restoring bumps the entity to a new version (`N + 1`) whose record has `restoredFrom: 5`. The restored content is written to the main document atomically alongside the version write.

Optional body on restore: `{ "comment": "Reverting because X" }`. If omitted, the comment defaults to `"Restored from version N"`.

## UI

Open the **version history panel** from any saved console or dashboard. It shows the full list of versions with author, timestamp, and commit comment. From there you can:

- Click a version to preview its snapshot
- Restore any past version with one click
- Optionally add a commit comment when saving via the save dialog

Unsaved drafts have no version history yet; the history button is disabled until the first save.

## AI Agent Tools

The assistant can inspect version history through two dedicated tools. See [AI Agent](/ai-agent/) for the full tool surface.

### `browse_version_history`

Lists past versions of a console or dashboard. Returns authors, timestamps, and comments.

**Inputs:** `entityType` (`"console"` | `"dashboard"`), `entityId`, optional `limit` (default 10).

### `get_version_snapshot`

Fetches the full snapshot of a specific version — including code (consoles) or widgets/data sources/layout (dashboards).

**Inputs:** `entityType`, `entityId`, `version`.

Both tools are workspace-scoped: the assistant can only browse entities inside the current workspace.

## Notes

- Version history is enabled by default for every workspace; no configuration needed.
- The `EntityVersion` collection was introduced in migration `2026-04-05-075746_add_entity_versions_collection`.
- Console and dashboard saves are append-only from the history's perspective — there is no hard delete, even on restore.
