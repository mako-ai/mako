---
title: Version History
description: Immutable snapshots for saved consoles and dashboards — browse, view, and restore past versions.
---

Every saved console and dashboard has a full, immutable version history. (Apps are git-backed — their history is git history, browsable in Source Control.) Each explicit save creates a new version record capturing the complete state at that point in time. Versions are never rewritten or deleted.

## How It Works

- Each console or dashboard carries a monotonically increasing `version` number on the main document. (Console drafts bump a separate `draftRevision` and do **not** create a version — only an explicit save does.)
- Every versioned save writes an `EntityVersion` record in MongoDB scoped to `(entityId, entityType, version)`, enforced by a unique index. dbt files are versioned through the same collection.
- Snapshots capture the full entity state (for consoles: code, language, chart spec, connection; for dashboards: widgets, data sources, layout).
- Restoring a past version writes the old snapshot back into the main document **and** appends a new version record (with `restoredFrom` set), so the timeline is never lost.

Retry logic handles the rare case of concurrent writers picking the same version number.

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

### Apps

Apps are git-backed: every edit is a commit on a branch, history is `git log`, and publishing builds a commit on `main` into an immutable deployment (`POST /apps/:id/publish`, `POST /apps/:id/rollback`). See [Apps](/apps/). Version history for apps migrated from the legacy document-based system was replayed into git commits, one per saved version.

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

`version` is the full version record, including the `snapshot`:

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

Restoring bumps the entity to a new version (`N + 1`) whose record has `restoredFrom` set to the version you restored. The restored content is written to the main document alongside the new version record.

```json
{
  "success": true,
  "message": "Restored to version 8",
  "console": { "id": "6620...", "name": "Active users", "version": 8 }
}
```

(The dashboard restore endpoint returns the restored dashboard under `data` instead of `console`.)

Optional body on restore: `{ "comment": "Reverting because X" }`. If omitted, the comment defaults to `"Restored from version N"`.

## Drafts & publishing (apps)

Apps moved to git: the working copy in your sandbox is the draft, commits and merges to `main` are the history, and **publishing** builds a `main` commit into an immutable deployment that public/shared links render. A half-finished working copy is therefore never shown to viewers. See [Apps](/apps/#publishing--sharing).

## UI

Open the **version history panel** from any saved console or dashboard. It shows the full list of versions with author, timestamp, and commit comment. From there you can:

- Click a version to preview its snapshot
- Restore any past version with one click
- Optionally add a commit comment when saving via the save dialog

An unsaved draft has no version history yet, so the history button stays disabled until the first explicit save. For **apps**, use Source Control instead — history is git history.

## AI Agent Tools

The assistant can inspect version history through two dedicated tools. They are _deferred_ tools — activated on demand via tool discovery (`search_tools`/`load_tools`) rather than always loaded. See [AI Agent](/ai-agent/#tool-paging) for how tool paging works.

### `browse_version_history`

Lists past versions of a console, dashboard, or legacy (pre-git) app. Returns authors, timestamps, and comments.

**Inputs:** `entityType` (`"console"` | `"dashboard"` | `"app"`), `entityId`, optional `limit` (default 10).

### `get_version_snapshot`

Fetches the full snapshot of a specific version — including code (consoles), widgets/data sources/layout (dashboards), or files/dependencies/bindings (legacy apps).

**Inputs:** `entityType` (`"console"` | `"dashboard"` | `"app"`), `entityId`, `version`.

Both tools are workspace-scoped: the assistant can only browse entities inside the current workspace.

## Notes

- Version history is enabled by default for every workspace; no configuration needed.
- The `EntityVersion` collection was introduced in migration `2026-04-05-075746_add_entity_versions_collection`.
- History is append-only — there is no hard delete, even on restore.
- Apps created before the initial-version fix were backfilled with a v1 snapshot by migration `2026-06-27-145356_backfill_initial_app_version` (idempotent — apps that already had a version are skipped).
