---
title: Transforms (dbt)
description: Build, run, and schedule dbt Core projects inside Mako with a dbt Studio-style editor, GitHub-backed version control, jobs, and runs.
---

:::caution[Experimental]
Transforms is under active development. The API and UI may change.
:::

**Transforms** brings dbt Core into Mako with dbt Cloud-style parity: a Studio-like editor, GitHub-backed projects, scheduled and ad-hoc Jobs, and a full Run history with artifacts and live logs. Models run against your connected [databases](/databases/connect-databases/).

## Projects

A Transforms project is a dbt Core project. You can:

- **Create** a new project from scratch (scaffolded structure, dbt version selector).
- **Import from GitHub** via Mako's multi-tenant GitHub App — browse repos, check a repo's dbt layout, and import. Pushes to the tracked branch sync continuously back into Mako.

Project settings (dbt version, connection mapping, branch) live in the project settings drawer.

## GitHub integration

Mako installs as a multi-tenant GitHub App. The install flow is HMAC-state protected — the signed state pins the initiating workspace and user, and binding an installation requires that same user with admin access.

Once connected:

- **Continuous branch sync** — pushes to the tracked branch flow into the in-app project.
- **Slim CI on PRs** — `state:modified+` builds with prod-manifest `defer`, posting commit statuses back to the PR.

## Studio-style editor

The file editor (`DbtFileEditor`) mirrors dbt Studio:

- **Live auto-compile** of the model you're editing.
- **Build / Run / Test** node menu with graph operators: `model`, `model+`, `+model`, `+model+`.
- **Persistent bottom panel** with Compiled / Problems / Results / Lineage tabs and a status bar.
- **jinja-sql** language support (Monaco) and a **Lineage** view.

## Jobs & Runs

- **Jobs** — CRUD with manual or scheduled triggers (executed via Inngest). Per-environment `--vars` and `--defer`/`--state` injection in the runner.
- **Runs** — full history with per-step results, artifacts (`manifest.json`, `run_results.json`), live logs, cancel, and retry-from-failure.

## Access control (RBAC)

Transforms access is enforced by a pure policy (`api/src/dbt/rbac.ts`):

- **Reads (GET)** — open to any member, including viewers.
- **Project/file/run mutations** (create/edit files, trigger runs, sync) — require **member** or above (viewers excluded).
- **Deployment-config changes** (GitHub connect/import, repo writes, job create/edit/delete) — require **admin** or **owner**.

## Security

dbt model code can call `env_var()`, so the runner does **not** inherit the API's process environment. A subprocess runs with an allowlisted base env (`buildDbtBaseEnv`) that forwards only what uv/python/dbt need; per-connection secrets are layered on top. This prevents workspace members from exfiltrating server secrets through a model.

## The dbt agent

A dedicated **dbt agent** (also available as the `dbt` expertise mode in the unified production agent) operates Transforms. It activates on `dbt-file` and `dbt-job` tabs and can build, run, and version dbt projects through these server tools:

| Tool | Purpose |
|------|---------|
| `dbt_create_project` | Scaffold a new project |
| `dbt_parse` | Parse the project |
| `dbt_compile_model` | Compile a single model |
| `dbt_run_model` | Run a model (with graph operators) |
| `dbt_show` | Preview a model's results |
| `dbt_run_job` / `dbt_create_job` / `dbt_update_job` | Manage and trigger jobs |
| `dbt_get_run` | Inspect a run's status and steps |
| `dbt_git_status` | Show working-tree status |
| `dbt_commit_and_push` | Commit and push (AI-generated commit messages from the diff) |
| `dbt_create_branch` / `dbt_switch_branch` / `dbt_list_branches` | Branch management |
| `dbt_open_pull_request` | Open a PR |

See the [AI agent](/ai-agent/) page for how agents and expertise modes are selected.
