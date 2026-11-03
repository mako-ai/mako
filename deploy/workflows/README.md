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

## Per-workspace objects (created by the Mako API, not by hand)

- a Hatchet tenant and API token, saved on the workspace
- Secret `wf-<prefix><workspaceId>`: the worker's Mako API key
- Deployment `wf-<prefix><workspaceId>`: one replica of the runtime image.
  Created once, replaced only for a new image or a new key. The image is
  tagged `runtime-<git tree of runtime/>`; the app deploy names that tag in
  `WORKFLOWS_RUNTIME_IMAGE` (`resolve-runtime-image.sh`), and the API moves
  every worker to it when it starts. A `:latest` name would never change, so
  workers would keep the image they first pulled.

## Sandbox runs

Testing a workflow needs nothing here. A sandbox run is `mako workflow run`
(packages/cli) inside the person's sandbox, the same command as on a laptop:
`runtime/run.mjs` calls it with the CLI's workflow files, installed next to it
in `cli/`. It runs the checkout's workflow once in one process, with no
Hatchet engine, started detached; Mako reads its result file back
(`api/src/workflows/sandbox.ts`).

Mako installs the runtime in the box itself, by content
(`api/src/workflows/runtime-files.ts`): a box without it, or with an older
one, gets the current files under `~/.mako-workflows` on its next sandbox
run, so nothing has to be rebuilt when these scripts change. The sandbox
image carries it preinstalled
(`api/src/apps/e2b-template.ts`), which only saves the first run its ~40 s
of install; rebuild it now and then with
`pnpm --filter api apps:build-template`.

## PR previews

A preview runs several API instances with ephemeral disks and never pushes
to the workspace's mirror, so a commit exists only on the instance that took
the push. The worker's source fetch for it answers `That commit is not on
this instance` from the others and is retried on every poll, so a deploy on
a PR preview may not land. Production pushes to the mirror, which every
instance can fetch from.
