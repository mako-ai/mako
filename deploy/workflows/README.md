# Mako Workflows infrastructure

Workspace workflows are native Hatchet TypeScript in the workspace repo's
`workflows/` folder (RFC: `rfcs/workflows-as-code.md`). This folder holds the
infrastructure they run on. It reuses the notebook-kernels GKE cluster and its
gVisor node pool.

| Path                  | What                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.sh`        | One-time, idempotent setup per project: Hatchet (Helm), the `mako-workflows` namespace, egress lockdown, firewall                            |
| `hatchet-values.yaml` | Helm values for `hatchet/hatchet-stack` 0.19.0: Neon Postgres, Postgres queue, nothing exposed                                               |
| `k8s/`                | Namespace, quota and network policy for worker pods                                                                                          |
| `runtime/`            | The worker image: fetch `workflows/` at `GIT_SHA`, typecheck, run a Hatchet worker                                                           |
| `template/workflows/` | Starter files for a workspace: `hatchet.ts`, `index.ts`, `lib/mako.ts` and three examples. Typechecked against the runtime image's packages. |

## Environments

| Environment          | GCP project    | Hatchet database (Neon, direct endpoint)        |
| -------------------- | -------------- | ----------------------------------------------- |
| Production           | `mako-ai-prod` | secret `HATCHET_DATABASE_URL` in `mako-ai-prod` |
| PR previews (shared) | `mako-ai-dev`  | secret `HATCHET_DATABASE_URL` in `mako-ai-dev`  |
| Local                | —              | Hatchet Lite in `docker-compose.yml`            |

Previews share one Hatchet. Each PR prefixes its tenants and worker
Deployments with `pr-<n>-`, and `cleanup-preview.yml` removes them when the PR
closes.

## Per-workspace objects (created by the Mako API, not by hand)

- a Hatchet tenant and API token
- Secret `wf-<prefix><workspaceId>` (Hatchet token, Mako worker API key)
- Deployment `wf-<prefix><workspaceId>`: one replica of the runtime image at the
  workspace's `GIT_SHA`. A failed typecheck keeps the pod unready, so the
  previous pod keeps running.

## Run the runtime locally

```bash
cd deploy/workflows/runtime && npm install
HATCHET_CLIENT_TOKEN=<token> HATCHET_CLIENT_TLS_STRATEGY=none \
WORKFLOWS_SOURCE_DIR=../template node entrypoint.mjs   # or any dir containing workflows/
```
