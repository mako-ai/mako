---
title: Transforms (dbt)
description: Build, run, and schedule dbt Core projects inside Mako — a dbt Cloud replica with a file IDE, jobs, run history, lineage, and an AI Transform Agent.
---

The **Transforms** section runs [dbt Core](https://docs.getdbt.com) projects directly inside your Mako workspace — a self-hosted dbt Cloud replica. Project files live in the workspace database (one document per file) and execute as `dbt` subprocesses against your existing [database connections](/databases/connect-databases/).

You get a file IDE, saved jobs with cron schedules, run history with artifacts, a DAG lineage view, and the AI agent's [Transforms mode](/ai-agent/#expertise-modes) that writes and verifies models for you.

## Projects

A **project** is a dbt Core project scoped to one workspace. It holds:

- A pinned `dbtVersion` (default `1.9`, informational for now).
- A set of **environments** — each maps a name (e.g. `dev`, `prod`) to a database **connection** + **target schema**, with `threads` (1–16, default 4), optional dbt `vars`, and optional **ownership** (see [Personal environments](#personal-environments)).
- A `defaultEnvironment` (default `dev`). Ad-hoc and agent-triggered builds resolve their target as: explicit selection → your saved per-user dev environment → your personal environment (when provisioned) → the project default. Production targets require an explicit job or selection.

Project names are unique per workspace. New projects are scaffolded with a standard `dbt_project.yml`, `models/staging`, `models/marts`, `seeds/`, `macros/`, and `snapshots/` layout.

## Personal environments

A **personal environment** is a per-developer build target so iteration never lands in a shared schema:

- **Auto-provisioned** — `POST .../environments/personal` (also triggered from the editor) idempotently creates yours: same connection as the prod-like environment, private schema `dbt_<slug>` (slug = your email local-part, lowercased, `[a-z0-9_]`; name/schema collisions get a numeric suffix).
- **Claim / release from settings** — each environment row in the project settings drawer has an **Ownership** dropdown (`Shared`, `Personal — only me`, or shows `Personal — another user`), so an existing environment can be claimed as personal or released back to shared.
- **Rules** (validated on create, update, and GitHub import): at most **one personal environment per user**, and neither the `defaultEnvironment` nor the production (`prodEnvironment`) environment can be personal — both are resolved for other users too, so a private schema there would leak one developer's scratch data into everyone's builds.
- **Member+, not admin-only** — provisioning your own personal environment only affects your own iteration target. It requires a user session (not an API key). Shared environment config stays admin-gated as usual.
- **Per-user dev preference** — `PUT .../projects/:projectId/my-environment` saves *your* default development environment for the project (the editor/console env pickers persist here; `""` clears back to Auto). Project reads carry it back as `myDevEnvironment`.

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

Files are unique per path (`{projectId, path}`), deletes are soft (`is_deleted`) so history is preserved, and every write is also captured in the shared [version history](/version-history/).

## GitHub integration

Projects can be **imported from GitHub** and kept in sync via Mako's multi-tenant GitHub App.

- **Install flow** is HMAC-state protected — the signed `state` pins the initiating workspace + user, and binding an installation requires that same user with **admin** access (prevents install IDOR/CSRF).
- **Browse & import** — list repos, check a repo's dbt layout, and import a project.
- **Continuous branch sync** — pushes to the tracked branch flow back into the in-app project.
- **Slim CI on PRs** (opt-in per project, off by default) — `state:modified+` builds with prod-manifest `defer`, posting commit statuses back to the PR.

## Studio-style editor

Beyond the file IDE, the editor mirrors **dbt Studio**:

- **Live auto-compile** of the model you're editing.
- **Build / Run / Test** node menu with graph operators: `model`, `model+`, `+model`, `+model+`.
- **Persistent bottom panel** — Compiled / Problems / Results / Lineage tabs and a status bar.
- **jinja-sql** Monaco language support, a dbt version selector, and project create/import/settings drawers.

## Running models

Three ways to execute dbt, all routed through the same validated runner:

| Action | What it runs | Where |
| ------ | ------------ | ----- |
| **Compile / Parse** | `dbt parse` or `dbt compile --select <model>` | Renders Jinja, validates refs/sources without touching the warehouse |
| **Run selection** | `dbt build --select <model>` | Builds the model **and its tests** on the chosen environment |
| **Command bar** | Any allow-listed `dbt` command | dbt Cloud parity — free-form command bar |

The command bar accepts a free-form command (an optional leading `dbt` is stripped), but every command is tokenized and validated against the same allowlist as saved jobs before it reaches the runner. The subcommand must be on the allowlist (`run`, `build`, `test`, `seed`, `snapshot`, `compile`, `parse`, `source freshness`, `docs generate`, `deps`, `retry`, `show`), and unknown flags are rejected. Commands are executed with `spawn` (no shell), and `--select` selectors on compile / run-select are pattern-checked.

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

## Access control (RBAC)

Transforms access is enforced by a pure policy (`api/src/dbt/rbac.ts`):

- **Reads (GET)** — open to any member, including viewers (GitHub repo discovery is member+).
- **File/run mutations** (edit files, trigger runs, repo sync) — require **member** or above (viewers excluded).
- **Deployment-config changes** (GitHub connect/import, repo writes, job create/edit/delete, project create/delete) — require **admin** or **owner**.

## Runner security

dbt model code can call `env_var()`, so the runner does **not** inherit the API's process environment. The dbt subprocess runs with an allowlisted base env (`buildDbtBaseEnv`) forwarding only what uv/python/dbt need; per-connection secrets are layered on top. This stops workspace members from exfiltrating server secrets (e.g. `ENCRYPTION_KEY`, `AI_GATEWAY_API_KEY`, `DATABASE_URL`) through a one-line model.

## Lineage

The **lineage** view renders the model DAG (nodes + edges) from the latest run that produced a `manifest.json`, overlaid with each node's last run status from that same run. It's the same dependency graph dbt builds from `{{ ref() }}` and `{{ source() }}`, so undeclared sources and broken refs show up here.

## API

dbt routes are mounted under `/api/workspaces/:workspaceId/dbt`. Highlights (full schema in the [REST API reference](/api/) under the sidebar):

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET` / `POST` | `/projects` | List / create projects |
| `GET` / `PATCH` / `DELETE` | `/projects/:projectId` | Get / update / delete a project |
| `GET` | `/projects/:projectId/files` | List project files |
| `GET` / `PUT` / `DELETE` | `/projects/:projectId/files/:path` | Read / write / delete a file |
| `POST` | `/projects/:projectId/files/rename` | Rename / move a file |
| `POST` | `/projects/:projectId/environments/personal` | Idempotently provision the caller's personal environment |
| `PUT` | `/projects/:projectId/my-environment` | Save the caller's default dev environment (`""` = Auto) |
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

GitHub connect/import and in-IDE git operations (status, diff, commit, branch, pull request) are exposed under the same `/dbt` prefix.

## Project rules (`.makorules.md`)

Drop a `.makorules.md` file at the root of a dbt project and Mako's agent will
follow it on every turn — the same idea as `.cursorrules`, scoped to how your
team writes SQL. `.makorules` (no extension) works too; `.makorules.md` wins if
both exist.

It is an ordinary project file, so it is versioned with the project: it syncs
from your repo, commits and pushes with the rest of your changes, and lives on
the branch you wrote it on. Your uncommitted edits apply to your own agent turns
straight away, so you can tune the rules and re-prompt without committing.

**Precedence,** highest first:

1. What you tell the agent in the conversation
2. `.makorules.md`
3. Workspace instructions (Settings → Prompt)
4. The `dbt` system skill
5. Mako's built-in dbt conventions

When a rule blocks what you asked for, the agent says so and cites the file
rather than silently picking a side.

**Size limit:** the first 16,000 characters (~4k tokens) are injected. Past that
the agent is told the file was truncated.

### Example

```markdown
# SQL conventions for this project

- Every model starts with import CTEs (`with source as (select * from {{ ref(...) }})`),
  one per upstream, then transform CTEs, then a single `select` at the bottom.
- Never `select *` outside an import CTE.
- Columns are `snake_case`; booleans are prefixed `is_` or `has_`.
- Money is stored in minor units and suffixed `_cents`.
- Every mart model needs a `unique` + `not_null` test on its primary key in
  `schema.yml`, in the same PR.
- Never hardcode a schema or table name — always `{{ ref() }}` or `{{ source() }}`.
```

You don't have to write it yourself: tell the agent a convention ("we never use
`select *`") and it will offer to record it for you.
