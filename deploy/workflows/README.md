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
| `loadtest/`           | A Hatchet of its own, a synthetic workflow and a driver, to measure a burst without touching a shared engine ("Load test" below)                                                      |

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
- Deployment `wf-<prefix><workspaceId>`: the runtime image, one pod unless
  the autoscaler says otherwise ("Autoscaling" below). Created once, replaced only for a new image or a new key. The image is
  tagged `runtime-<git tree of runtime/>`; the app deploy names that tag in
  `WORKFLOWS_RUNTIME_IMAGE` (`resolve-runtime-image.sh`), and the API moves
  every worker to it when it starts. A `:latest` name would never change, so
  workers would keep the image they first pulled.

## Sizing

What each part must be at least, and why. The numbers come from the outage
of 2026-11-16 and from the load test below.

| Part                  | Size                                                                  | Why                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hatchet's database    | `db-custom-2-7680` (2 dedicated vCPUs, 7.5 GB), `max_connections=200` | The queue is this database. On `db-g1-small` (half a shared core, 1.7 GB) the API and engine hold 35 connections idle and 80 to 100 busy; under a burst it swapped up to 0.95 GB, stayed at its CPU allowance, and answered too slowly for everything else. Never a shared-core tier in production. |
| Hatchet API, engine   | two pods each, the chart's 250m CPU and 1Gi, PDB `minAvailable: 1`    | They used 0.1 CPU and 60 MB at the worst. They were restarted 57 times by their liveness probes, which ask the database; `hatchet-values.yaml` gives the probes a minute instead of 15 s. With one pod each, a rollout and an eviction on 2026-11-16 caused 56 x 500 on the runs list.              |
| A worker pod          | 250m / 512Mi requested, 2 CPU / 3Gi limit, 128 steps at once          | 16 step programs, each a Node process of about 100 MB running up to 8 steps of one workflow at a time: 1.45 GiB measured with all 128 under way (`api/src/workflows/kube.ts`, `WORKER_STEPS`).                                                                                                      |
| A workspace's workers | 1 pod, or 0 to 5 with the autoscaler                                  | 5 x 128 = 640 steps at once. The namespace quota (`k8s/namespace.yaml`: 32 CPU and 64Gi of limits) holds 16 such pods for all workspaces.                                                                                                                                                           |

## Limits on a burst

A POST to a workflow's webhook always starts a run, so a caller can start a
thousand in a minute. They queue instead of all running at once:

- **Runs per workflow.** `worker.mjs` gives every workflow a Hatchet
  concurrency limit: `WORKFLOWS_MAX_RUNS` runs executing at once (250: the most the load
  test has run), the rest waiting in the order they
  came (`GROUP_ROUND_ROBIN` on one group; the SDK's default strategy would
  cancel the run in progress). A workflow that declares its own `concurrency`
  keeps it.
- **Steps per pod.** `WORKFLOWS_MAX_STEPS` (128) is the worker's Hatchet
  slots: `WORKFLOWS_MAX_PROGRAMS` (16) step programs of
  `WORKFLOWS_STEPS_PER_PROGRAM` (8) steps each. A program runs the steps of
  one workflow only, as that workflow's user, so workflows stay apart;
  steps of the same workflow share it. Each step keeps its own pass: a
  request made outside any step's own flow goes without a pass, and is
  refused, rather than with a neighbour's. A cancelled step is told to
  stop, and its program is stopped once the steps beside it have ended.
- **Waiting is not failing.** A step waits up to 24 h to start
  (`WORKFLOWS_SCHEDULE_TIMEOUT`); Hatchet's default cancels it after 5 min.
  A step whose pass cannot be checked because Hatchet does not answer waits
  up to 3 min and then fails as a step does, so its `retries` apply; it used
  to end for good after 15 s.
- **Rate limits.** `WORKFLOWS_RATE_LIMITS` on the Mako API
  (`model=300/minute,mail=60/minute`) names limits every worker registers
  with Hatchet. A step takes from one with
  `rateLimits: [{ staticKey: "model", units: 1 }]` and waits while it is
  used up. None is set by default: set them to the quotas of the providers
  the workflows call.

Starting many runs from code: one `workflow.runNoWait([...])` (Hatchet's
bulk call, up to 1000 a request) costs the engine less than a thousand
webhook calls. Mako's webhook starts one run per POST.

## Autoscaling (optional)

With `WORKFLOWS_AUTOSCALER=keda` on the Mako API, each worker Deployment
gets a KEDA `ScaledObject` and `TriggerAuthentication` of the same name
(`api/src/workflows/kube.ts`, `autoscalerBodies`): 0 to 5 pods, one per 128
steps the workspace has to run.

- KEDA reads `GET <mako>/api/workflows/runtime/demand` every 15 s with the
  worker's own key, from its Secret. Mako answers `steps`: the steps queued
  or running in Hatchet (its `task-stats`), and 1 while a commit or a change
  of triggers has not been reported by a worker yet, so a push wakes a
  sleeping worker as a run does.
- The last pod stops after 10 minutes without work. Pods are removed one a
  minute, and a pod asked to stop finishes its steps first.
- No answer from Mako or Hatchet is not "no work": KEDA keeps one pod.
- A run started while no pod is up waits `QUEUED`: about a minute for the
  pod to start and build, longer when a node must start.

It needs KEDA in the cluster and the Mako API's Kubernetes identity allowed
to manage `scaledobjects` and `triggerauthentications` (`keda.sh`) in
`mako-workflows`. Without the setting nothing changes: one pod, always on.

## Load test

`loadtest/` is a Hatchet Lite of the production version with its own
Postgres, a stand-in for the Mako API and the real `worker.mjs`, all on
this machine. It never touches a shared engine. `burst` is the synthetic
workflow: five steps in a row, each waiting on one HTTP call.

```bash
cd deploy/workflows/loadtest
# The outage: a shared-core database, one pod of 8 steps, no limits.
./stage.sh --runs 200 --step-ms 2000
# The sizes above: 2 vCPU / 7.5 GB database, 2 pods of 128 steps.
PG_CPUS=2 PG_MEMORY=7680m PG_SHARED_BUFFERS=2500MB HATCHET_CPUS=2 \
  WORKER_CPUS=2 WORKER_MEMORY=3g WORKERS=2 WORKFLOWS_MAX_PROGRAMS=16 WORKFLOWS_STEPS_PER_PROGRAM=8 WORKFLOWS_MAX_RUNS=250 \
  ./stage.sh --runs 1600 --step-ms 2000
docker compose down
```

Each stage starts from an empty Hatchet and prints one line of JSON: the
steps by final status, steps and runs a minute, the peaks, and
`runsReadModel`, the runs' statuses as the API shows them a minute after the
last step ended.

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
