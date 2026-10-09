# Mako Workflows: infrastructure for Mako's cloud

How to use and set up workflows: `docs/src/content/docs/workflows.md`.

This folder holds what Mako's own cloud adds: a Hatchet we operate, and one
sandboxed worker pod per workspace (the `gke` worker provider). It reuses the
notebook-kernels GKE cluster and its gVisor node pool. A self-hosted
installation needs none of it.

| Path                  | What                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.sh`        | One-time, idempotent setup per project: the Cloud SQL database, Hatchet (Helm), its internal load balancer, the `mako-workflows` namespace                                            |
| `hatchet-values.yaml` | Helm values for `hatchet/hatchet-stack` 0.19.0: Cloud SQL Postgres, Postgres queue, nothing exposed                                                                                   |
| `k8s/`                | Namespace, quota and network policy for worker pods                                                                                                                                   |
| `runtime/`            | The worker image: follow the commit Mako names, typecheck it, run a Hatchet worker. `runtime/defaults/` are the shared files (`hatchet.ts`, `lib/mako.ts`) it supplies to every repo. |

## Environments

Each environment has its own Hatchet and its own database.

| Environment          | GCP project    | Hatchet database                                |
| -------------------- | -------------- | ----------------------------------------------- |
| Production           | `mako-ai-prod` | Cloud SQL `mako-hatchet` in `mako-ai-prod`      |
| PR previews (shared) | `mako-ai-dev`  | Cloud SQL `mako-hatchet` in `mako-ai-dev`       |
| Local                | —              | Postgres in `docker-compose.yml` (Hatchet Lite) |

Previews share one Hatchet. Each PR prefixes its tenants and worker
Deployments with `pr-<n>-` (`WORKFLOWS_NAME_PREFIX`). When the PR closes,
`cleanup-preview.yml` deletes its Deployments and Secrets; the idle Hatchet
tenants stay.

**Do not put Hatchet's database on Neon.** Hatchet's outbox migrations choose
their schema with the `search_path` connection parameter. Neon drops it, also
on the direct endpoint, so the tables are created in `public`, the engine logs
`relation "outbox.messages" does not exist`, and runs stay `QUEUED`.

Workflows stay off for a workspace until staff turn them on:
`PUT /api/admin/workspaces/:workspaceId/workflows` with `{ "enabled": true }`.

## Per-workspace objects (created by the Mako API, not by hand)

- a Hatchet tenant and API token, saved on the workspace
- Secret `wf-<prefix><workspaceId>`: the worker's Mako API key
- Deployment `wf-<prefix><workspaceId>`: one replica of the runtime image.
  Created once, replaced only for a new image.
