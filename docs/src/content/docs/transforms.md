---
title: Transforms (dbt)
description: Build, run, and schedule dbt Core projects inside Mako — a dbt Cloud replica with a file IDE, jobs, run history, lineage, and an AI Transform Agent.
---

The **Transforms** section runs [dbt Core](https://docs.getdbt.com) projects directly inside your Mako workspace — a self-hosted dbt Cloud replica. Project files live in the workspace database (one document per file) and execute as `dbt` subprocesses against your existing [database connections](/databases/connect-databases/).

You get a file IDE, saved jobs with cron schedules, run history with artifacts, a DAG lineage view, and an AI [Transform Agent](/ai-agent/#transform-agent) that writes and verifies models for you.

## Projects

A **project** is a dbt Core project scoped to one workspace. It holds:

- A pinned `dbtVersion` (default `1.9`, informational for now).
- A set of **environments** — each maps a name (e.g. `dev`, `prod`) to a database **connection** + **target schema**, with `threads` (1–16, default 4) and optional dbt `vars`.
- A `defaultEnvironment` (default `dev`). Ad-hoc and agent-triggered builds always default to `dev`; production targets require an explicit job or selection.

Project names are unique per workspace. New projects are scaffolded with a standard `dbt_project.yml`, `models/staging`, `models/marts`, `seeds/`, `macros/`, and `snapshots/` layout.

## File IDE

Every file in the project is editable from the **Transforms** explorer:

```text
dbt_project.yml        # project config — name, model defaults
models/
  staging/             # 1:1 source cleanup, materialized as views
    schema.yml         # sources + staging model tests
    stg_<src>_<entity>.sql
  marts/               # business-facing models, materialized as tables
seeds/                 # small CSV reference data (dbt seed)
macros/                # Jinja macros
snapshots/             # SCD2 snapshots
tests/                 # singular SQL tests
```

Files are versioned per path (unique `{projectId, path}`), and deletes are soft (`is_deleted`) so history is preserved.

## Running models

Three ways to execute dbt, all routed through the same validated runner:

| Action | What it runs | Where |
| ------ | ------------ | ----- |
| **Compile / Parse** | `dbt parse` or `dbt compile --select <model>` | Renders Jinja, validates refs/sources without touching the warehouse |
| **Run selection** | `dbt build --select <model>` | Builds the model **and its tests** on the chosen environment |
| **Command bar** | Any allow-listed `dbt` command | dbt Cloud parity — free-form command bar |

The command bar accepts a free-form command (an optional leading `dbt` is stripped), but every command is tokenized and validated against the same allowlist as saved jobs before it reaches the runner. Flags that would leak extra CLI surface (`--profiles-dir`, shell metacharacters, etc.) are rejected. `--select` values are pattern-checked.

## Jobs & schedules

A **job** is a saved list of dbt commands (`build`, `test`, `seed`, `snapshot`, `source freshness`, `docs generate`, with `--select` / `--exclude` / `--full-refresh` flags) bound to an environment. Jobs can run:

- **Manually** — trigger from the UI or the agent (after explicit user confirmation).
- **On a schedule** — set a cron expression; the scheduler picks up due jobs.

## Run history & artifacts

Every execution produces a **run** record with per-node status, timing, and logs. Runs can be **cancelled** while in flight or **retried**. dbt's standard artifacts are captured and downloadable per run:

| Artifact | Contents |
| -------- | -------- |
| `manifest` | Full project graph (nodes, refs, sources) |
| `runResults` | Per-node execution results and timing |
| `catalog` | Column-level metadata from `docs generate` |
| `sources` | Source freshness results |

## Lineage

The **lineage** view renders the model DAG (nodes + edges) from the latest run's `manifest.json`, overlaid with each node's last run status. It's the same dependency graph dbt builds from `{{ ref() }}` and `{{ source() }}`, so undeclared sources and broken refs show up here.

## API

dbt routes are mounted under `/api/workspaces/:workspaceId/dbt`. Highlights (full schema in the [REST API reference](/api/) under the sidebar):

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET` / `POST` | `/projects` | List / create projects |
| `GET` / `PATCH` / `DELETE` | `/projects/:projectId` | Get / update / delete a project |
| `GET` | `/projects/:projectId/files` | List project files |
| `GET` / `PUT` / `DELETE` | `/projects/:projectId/files/:path` | Read / write / delete a file |
| `POST` | `/projects/:projectId/files/rename` | Rename / move a file |
| `GET` / `POST` | `/projects/:projectId/jobs` | List / create jobs |
| `PATCH` / `DELETE` | `/projects/:projectId/jobs/:jobId` | Update / delete a job |
| `POST` | `/projects/:projectId/jobs/:jobId/trigger` | Run a job now |
| `GET` | `/projects/:projectId/runs` | List runs |
| `GET` | `/projects/:projectId/runs/:runId` | Get a run |
| `POST` | `/projects/:projectId/runs/:runId/cancel` | Cancel a running run |
| `POST` | `/projects/:projectId/runs/:runId/retry` | Retry a run |
| `GET` | `/projects/:projectId/runs/:runId/artifacts/:kind` | Stream an artifact (`manifest`, `runResults`, `catalog`, `sources`) |
| `POST` | `/projects/:projectId/compile` | Parse / compile a selection |
| `POST` | `/projects/:projectId/run-select` | `dbt build --select` a selection |
| `POST` | `/projects/:projectId/command` | Run an allow-listed free-form command |
| `GET` | `/projects/:projectId/lineage` | DAG nodes + edges from the latest manifest |
