---
title: Version History
description: Immutable snapshots for saved consoles, dashboards, and apps — browse, view, restore, and publish past versions.
---

Every saved console, dashboard, and app has a full, immutable version history. Each explicit save creates a new version record capturing the complete state at that point in time. Versions are never rewritten or deleted.

## How It Works

- Each console, dashboard, or app carries a monotonically increasing `version` number on the main document. (Console drafts bump a separate `draftRevision` and do **not** create a version — only an explicit save does.)
- Every versioned save writes an `EntityVersion` record in MongoDB scoped to `(entityId, entityType, version)`, enforced by a unique index. dbt files are versioned through the same collection.
- Snapshots capture the full entity state (for consoles: code, language, chart spec, connection; for dashboards: widgets, data sources, layout; for apps: files, dependencies, and data bindings).
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

Apps autosave every edit, so versions are explicit **checkpoints** rather than per-save snapshots. Saving a version also **publishes** it (see [Drafts & publishing](#drafts--publishing-apps) below). Unlike older builds, every app now seeds a v1 `App created` published baseline at creation time (both the REST `POST /apps` and the agent `create_app` tool), so an app's version history is never empty.

| Method | Endpoint                                                  | Description                              |
| ------ | --------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/workspaces/:wid/apps/:id/versions`                  | List checkpoints (newest first)          |
| `POST` | `/api/workspaces/:wid/apps/:id/versions`                  | Save a checkpoint of the current draft and publish it |
| `GET`  | `/api/workspaces/:wid/apps/:id/versions/:version`         | Get a specific version snapshot          |
| `POST` | `/api/workspaces/:wid/apps/:id/versions/:version/restore` | Restore the app's draft to that version  |

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

Apps use a **draft → published** split:

- The files, dependencies, and bindings you edit are the working **draft**, autosaved on every edit. Editors (and the AI agent) always see the draft in the live preview.
- A freshly created app starts with a v1 `App created` checkpoint that is also the initial published version, so version history exists from the first moment (no explicit save required).
- **Saving a version** snapshots the current draft into history *and* sets it as the **published** definition — the one that public/shared links and viewers render. A half-finished or in-progress draft is therefore never shown to viewers until you save a version.
- The app document tracks `publishedVersion`, `publishedAt`, and a `hasUnpublishedChanges` flag so the UI can show when the draft has drifted from what viewers see.
- **Restoring** reverts the *draft* to a past checkpoint (snapshotting the current draft first, so it is never lossy). Restore does **not** auto-publish — save a version afterward to push the restored state live. Binding materialization caches are preserved by binding id across restore.

## UI

Open the **version history panel** from any saved console, dashboard, or app. It shows the full list of versions with author, timestamp, and commit comment. From there you can:

- Click a version to preview its snapshot
- Restore any past version with one click
- Optionally add a commit comment when saving via the save dialog

For **consoles and dashboards**, an unsaved draft has no version history yet, so the history button stays disabled until the first explicit save. **Apps** always have at least a v1 `App created` checkpoint, so their history is available immediately — and the app preview toolbar carries a **Version History** button that opens the panel for the open app.

## AI Agent Tools

The assistant can inspect version history through two dedicated tools, which are part of the always-on core toolset. See [AI Agent](/ai-agent/) for the full tool surface.

### `browse_version_history`

Lists past versions of a console, dashboard, or app. Returns authors, timestamps, and comments.

**Inputs:** `entityType` (`"console"` | `"dashboard"` | `"app"`), `entityId`, optional `limit` (default 10).

### `get_version_snapshot`

Fetches the full snapshot of a specific version — including code (consoles), widgets/data sources/layout (dashboards), or files/dependencies/bindings (apps).

**Inputs:** `entityType` (`"console"` | `"dashboard"` | `"app"`), `entityId`, `version`.

Both tools are workspace-scoped: the assistant can only browse entities inside the current workspace.

## Notes

- Version history is enabled by default for every workspace; no configuration needed.
- The `EntityVersion` collection was introduced in migration `2026-04-05-075746_add_entity_versions_collection`.
- History is append-only — there is no hard delete, even on restore.
- Apps created before the initial-version fix were backfilled with a v1 snapshot by migration `2026-06-27-145356_backfill_initial_app_version` (idempotent — apps that already had a version are skipped).
