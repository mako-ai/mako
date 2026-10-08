# Mako Workflows: running them

Workspace workflows are native Hatchet TypeScript in the workspace repo's
`workflows/` folder (RFC: `rfcs/workflows-as-code.md`). They are optional.
Mako needs two things to run them: a Hatchet API token, and a worker.

## Pick one

| Use                             | What to do                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **No workflows**                | Nothing. With no Hatchet setting, the routes answer "not set up" and the UI hides Workflows.                               |
| **Local testing**               | The bundled Hatchet Lite. See below. Not for production.                                                                   |
| **Production**                  | A token from [Hatchet Cloud](https://cloud.onhatchet.run) or from a Hatchet you run, plus the worker container. See below. |
| **Hosting other people's code** | The `gke` provider: one sandboxed pod per workspace. See "Mako's cloud".                                                   |

### Local testing

1. In `.env`, uncomment the workflows lines from `.env.example`. Set
   `WORKFLOWS_WORKER_KEY` to any value of your own starting with `revops_`.
2. `docker compose --profile workflows up -d` starts Hatchet Lite, its
   Postgres and the worker.
3. Turn workflows on for a workspace (super admin):
   `PUT /api/admin/workspaces/:workspaceId/workflows` with `{ "enabled": true }`.
   Mako creates the workspace's Hatchet tenant.
4. Copy `template/workflows/` into the workspace repo as `workflows/` and
   merge to `main`. The worker picks it up within ten seconds.

Hatchet dashboard: http://localhost:8085 (`admin@example.com` / `Admin123!!`).

### Production

1. Create an API token in Hatchet Cloud, or in your own Hatchet.
2. Give it to Mako: `HATCHET_CLIENT_TOKEN` for the whole installation, or per
   workspace with `{ "enabled": true, "hatchetToken": "..." }` on the admin
   route above.
3. Choose a `WORKFLOWS_WORKER_KEY` (starts with `revops_`, long and random)
   and set it on the Mako API.
4. Run the worker anywhere that can reach Mako and Hatchet:

   ```bash
   docker run -e MAKO_URL=https://your-mako -e MAKO_API_KEY=$WORKFLOWS_WORKER_KEY \
     <registry>/workflows-runtime
   ```

5. Optional: `HATCHET_DASHBOARD_URL` makes Mako link admins to the Hatchet
   dashboard.

A worker run this way serves one workspace and has no sandbox: workflow code
runs with the container's access. Use it for your own team's code.

### Settings

| Variable                                                  | Set on                          | What                                                                                                   |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `HATCHET_CLIENT_TOKEN`                                    | API                             | One Hatchet tenant for the whole installation                                                          |
| `HATCHET_API_URL`                                         | API                             | Overrides the address in the token, when the Mako API cannot resolve it. Required for tenant creation. |
| `HATCHET_ADMIN_EMAIL`, `HATCHET_ADMIN_PASSWORD`           | API                             | Lets Mako create a tenant per workspace on a Hatchet you operate                                       |
| `HATCHET_DASHBOARD_URL`                                   | API                             | Where "Open in Hatchet" points                                                                         |
| `WORKFLOWS_WORKER_PROVIDER`                               | API                             | `static` or `gke`. Default: `gke` when a cluster and image are configured, else `static`.              |
| `WORKFLOWS_WORKER_KEY`                                    | API and worker (`MAKO_API_KEY`) | The `static` worker's Mako API key                                                                     |
| `MAKO_URL`, `MAKO_API_KEY`                                | Worker                          | All the worker needs. It gets the Hatchet token from Mako.                                             |
| `HATCHET_CLIENT_HOST_PORT`, `HATCHET_CLIENT_TLS_STRATEGY` | Worker                          | Only when the token's gRPC address is wrong from where the worker runs, or the Hatchet has no TLS      |

## How a deploy works

A merge to `main` that changes `workflows/` saves that commit as the
workspace's target. The worker asks Mako what to run, typechecks the new
commit, starts it, and then lets the old one finish its tasks. A commit that
does not build is reported as a build error and the old code keeps running.

## Mako's cloud

The rest of this folder is the infrastructure for the `gke` provider. It
reuses the notebook-kernels GKE cluster and its gVisor node pool.

| Path                  | What                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.sh`        | One-time, idempotent setup per project: the Cloud SQL database, Hatchet (Helm), its internal load balancer, the `mako-workflows` namespace   |
| `hatchet-values.yaml` | Helm values for `hatchet/hatchet-stack` 0.19.0: Cloud SQL Postgres, Postgres queue, nothing exposed                                          |
| `k8s/`                | Namespace, quota and network policy for worker pods                                                                                          |
| `runtime/`            | The worker image: follow the commit Mako names, typecheck it, run a Hatchet worker                                                           |
| `template/workflows/` | Starter files for a workspace: `hatchet.ts`, `index.ts`, `lib/mako.ts` and three examples. Typechecked against the runtime image's packages. |

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

## Run the runtime locally

```bash
cd deploy/workflows/runtime && npm install
HATCHET_CLIENT_TOKEN=<token> HATCHET_CLIENT_TLS_STRATEGY=none \
WORKFLOWS_SOURCE_DIR=../template node entrypoint.mjs   # runs that folder once, without Mako
```
