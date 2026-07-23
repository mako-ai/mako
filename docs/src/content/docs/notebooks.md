---
title: Notebooks
description: Cloud, collaborative data notebooks — SQL, Python, and Markdown cells with a managed kernel, credential-free data access, and full AI agent support.
---

Notebooks are ordered lists of cells that live in your workspace: **SQL** cells run against your database connections, **code** cells run Python on a managed cloud kernel, and **markdown** cells render as prose. They're durable, collaborative, and the AI agent can build and run them for you.

## Cell Types

| Type | Runs where | Notes |
|------|-----------|-------|
| `sql` | Control plane, through the [Query Runner](/query-runner/) driver layer | Set a `connectionId` (data source) per cell; no kernel involved |
| `code` | Managed Python kernel | pandas, polars, numpy, pyarrow, matplotlib, plotly, duckdb, requests, and the `mako` SDK preinstalled |
| `markdown` | Client | Prose, headings, explanation between analyses |

Kernel state persists across runs — variables and imports carry over, so cells build on each other. Idle kernel sessions are stopped after 15 minutes (`KERNEL_SESSION_IDLE_MS`). Sessions are registered in a shared store (Redis when `REDIS_URL` is set), so in multi-instance deployments every API instance routes execution to the same kernel — no session affinity needed.

## Reading Workspace Data from Python

Code cells never hold database credentials. The kernel reads workspace data through the **`mako` Python SDK**, which proxies through the Mako API with a short-lived, read-only kernel token:

```python
import mako

mako.sources.list()
df = mako.sources.sql.read("warehouse", "select date, mrr from metrics.mrr")
tbl = mako.sources.sql.read_arrow("warehouse", "select 1 as n")  # pyarrow.Table
```

Reads stream **Arrow IPC** back into pandas zero-copy. Queries must be read-only (`SELECT`/`WITH`) — the SDK fast-fails writes and the API is the authoritative enforcement point, applying row, byte, and time budgets. Pass `params=` for server-side parameter binding and `limit=` to cap rows. The endpoint is `POST /api/workspaces/:workspaceId/notebook/read`.

## Collaboration & Persistence

- **Durable storage** — in deployed environments, notebook documents live in GCS (`NOTEBOOK_GCS_BUCKET`); locally they fall back to an ephemeral filesystem store. Edits autosave; agent and human edits share one document.
- **Presence** — open the same notebook as a teammate and you'll see live avatars, per-cell cursors, and soft-lock indicators, driven by a lightweight presence heartbeat.
- **Outputs survive reload** — rendered outputs are persisted with cells. Large payloads (a matplotlib PNG, a wide HTML table) are offloaded to storage as *artifacts* and fetched back on demand (`GET …/notebooks/:id/artifacts/:artifactId`), so documents stay small and no output is ever dropped.
- **Streaming runs** — executions stream outputs over SSE, and a run continues server-side even if your tab disconnects.
- **Version history** — prior generations of the document can be listed, inspected, and restored (see the API surface below).

## Folders & Organization

Notebooks are organized like dashboards and consoles: a **My Notebooks** section (private to you) and a **Workspace** section (shared), each supporting arbitrarily nested folders. Create, rename, and delete folders in the explorer; drag notebooks between folders or move them via `PATCH /api/workspaces/:wid/notebooks/:id/move` (set `folderId` and/or `access`). Folder structure updates in real time for everyone in the workspace.

## Building Notebooks with the AI Agent

Notebooks have their own [expertise mode](/ai-agent/#expertise-modes) — opening a notebook tab defaults the agent to **Notebook** mode. The agent can create notebooks, add/edit/delete cells, run SQL cells against a data source, and run Python cells on the kernel, reading each run's stdout/result/error to iterate. Tools:

`create_notebook`, `list_open_notebooks`, `read_notebook`, `add_notebook_cell`, `edit_notebook_cell`, `delete_notebook_cell`, `run_notebook_sql_cell`, `run_notebook_code_cell` — plus the SQL discovery tools (`list_connections`, `sql_list_tables`, `sql_inspect_table`, …) for finding data sources.

Agent runs execute server-side against the durable document and live-update any open tabs. Agent SQL runs persist up to 200 result rows with the cell. Notebook tools are deliberately **not** exposed over the [MCP server](/mcp-server/) yet — authoring stays in-product until notebooks get a dedicated MCP surface.

## Architecture

The control plane stays on Cloud Run; Python execution runs on a separate **GKE kernel plane** where untrusted notebook/agent code is sandboxed under **gVisor**, with a warm pod pool that autoscales 0–5 nodes and a network policy restricting egress. Provisioning is scripted (plain `gcloud`/`kubectl`, idempotent) — see `deploy/notebook-kernels/README.md`.

### Local Development

`pnpm docker:up` starts a local sidecar kernel so `code` cells run on your machine. Configure in `.env`:

```env
KERNEL_PROVIDER=static
KERNEL_GATEWAY_URL=http://localhost:8888
NOTEBOOK_KERNEL_API_URL=http://host.docker.internal:8080
```

Deployed environments auto-detect the GKE provider instead; no static config needed.

### API Surface

| Route | Purpose |
|-------|---------|
| `GET/POST/PATCH/DELETE /api/workspaces/:id/notebooks[/:id]` | Notebook CRUD (rename, replace cells) |
| `POST …/notebooks/:id/sessions` | Start (or return) the notebook's kernel session |
| `GET …/notebooks/:id/sessions/current` | Session status |
| `DELETE …/notebooks/:id/sessions/current` | Stop the kernel |
| `POST …/notebooks/:id/executions` | Run code on the kernel (SSE stream) |
| `POST …/notebook/read` | Read-only, budgeted data reads from the kernel (Arrow IPC) |
| `GET …/notebook/sources` | Data sources visible to the kernel (backs `mako.sources.list()`) |
| `GET …/notebooks/:id/versions[/:versionId]` | List / fetch prior generations of the document |
| `POST …/notebooks/:id/versions/:versionId/restore` | Restore a prior generation as current |
| `POST …/notebooks/:id/presence` | Presence heartbeat (avatars, per-cell cursors) |

The cell schema is deliberately Deepnote-block-shaped; canonical `.deepnote` format support and richer block types are planned with the Git storage/interop slice.
