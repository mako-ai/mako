# RFC: Workflows as code — native Hatchet workflows in the workspace repo

**Status:** proposal v5, the build plan for the first working version.
Supersedes v3 (issue #761) and v4.
**Continues:** RFC #904 (flows as code), `rfcs/connectors-as-code.md`
(tenant code isolation), `deploy/notebook-kernels/` (gVisor on GKE).
**Mockups:** https://claude.ai/artifact/4ivqohdXB3zwBGKMH4SzFG

## 1. Summary

A workflow is a TypeScript file in the workspace repo, under `workflows/`,
written against Hatchet's own SDK. When it reaches `main`, Mako builds it and
runs it on a Hatchet worker in a sandboxed pod on GKE. The Workflows section of
the IDE lists runs, shows what happened in each task, and starts runs.
Hatchet executes; Mako stores no execution state.

> **Mako Workflows is the Git-native development and operations experience
> for native Hatchet workflows.**

## 2. The first working version

The first working version is done when this demo works end to end, on staging,
for a workspace with the feature flag on:

1. A coding agent, connected to Mako's MCP server, writes three workflows into
   `workflows/`: a sequential one, a scheduled one and an AI agent one. It
   merges to `main`.
2. Within five minutes, the Workflows section shows the three names, and the
   footer shows the new commit as live.
3. The scheduled workflow fires on its own.
4. Clicking Run on the sequential one, with JSON input, opens a run page. Each
   task shows its input, output and logs.
5. The AI workflow calls a model and Mako MCP tools. Each model turn and tool
   call appears as its own task on the run page.
6. Killing the worker pod mid-run does not lose the run: Hatchet retries the
   task on the new pod.
7. A merge with a type error shows "Build failed" in the footer, and the
   previous commit keeps running.
8. Cancel and Replay work from the UI and from the agent.
9. A second workspace sees none of the first one's runs.

Everything in this document serves that demo. Anything else is listed in §15
or §16.

## 3. Decisions

| Question             | Decision                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who writes workflows | Workspace members and their coding agents, in the workspace repo.                                                                                                                                            |
| Engine               | Hatchet v1, self-hosted by Mako on GKE. One engine for tenant workflows. Inngest stays Mako's internal job runner.                                                                                           |
| Programming model    | Native Hatchet TypeScript. No DSL and no wrapper around `workflow()` or `task()`.                                                                                                                            |
| Where code lives     | `workflows/*.workflow.ts`, plus `workflows/index.ts` exporting the list.                                                                                                                                     |
| Where code runs      | A Hatchet worker in a pod on the existing GKE cluster, under gVisor, one Deployment per workspace. This is how Hatchet recommends running workers, and how Mako already runs notebook kernels.               |
| Deploy               | Push to `main`. Mako builds in a sandboxed Kubernetes Job, then rolls the workspace's Deployment. A failed build changes nothing.                                                                            |
| Version              | The Git commit SHA. No version table and no version screen.                                                                                                                                                  |
| Execution state      | Hatchet only. Mako stores which commit is deployed, never runs.                                                                                                                                              |
| Tenancy              | One Hatchet tenant per workspace.                                                                                                                                                                            |
| Data access          | Mako's MCP server, with a workspace API key the worker holds. Reads by default. Writes need the existing `query:write` scope **and** a connection an admin flagged `allowAgentWrites`. No new data endpoint. |
| Model access         | Through a Mako pass-through to the Vercel AI Gateway, billed to the workspace. Mako's gateway key never enters the pod.                                                                                      |
| Dependencies         | First version: only what the runtime image ships (`@hatchet-dev/typescript-sdk`, `@makoai/workflows`, `ai`, `zod`). Third-party packages come later (§15).                                                   |
| UI                   | Three surfaces, modeled on Hatchet's dashboard: runs list, run page, Run button.                                                                                                                             |
| Branch tests         | Not in the first version. Developers test locally with Hatchet Lite.                                                                                                                                         |
| Hatchet MCP server   | Not used in the product. The community server needs raw tenant tokens and knows nothing about workspaces. Fine for staff debugging.                                                                          |
| Rollout              | Behind a per-workspace feature flag, staff-enabled.                                                                                                                                                          |
| Naming               | Flows is renamed **Sync** in the UI, with lucide `RefreshCcwDot`. Workflows uses lucide `Workflow`. Separate PR.                                                                                             |

## 4. Where everything runs

```
┌─────────────── Cloud Run (exists) ────────────────┐
│ Mako API                                          │
│  · push hook → starts the deploy (Inngest)        │
│  · /workflows routes: runs list, run page, Run    │
│  · /api/mcp: data tools for workflows and agents  │
│  · AI gateway pass-through for workflow models    │
└───────────────┬───────────────────────────────────┘
                │ Kubernetes API (private, as kernels do)
┌───────────────▼────── GKE cluster (exists) ───────────────────────┐
│ namespace hatchet  (NEW)                                          │
│   Hatchet engine + API (Helm)  ── Cloud SQL Postgres (NEW)        │
│                                                                   │
│ namespace mako-workflows  (NEW, gVisor node pool, egress locked)  │
│   Job  wf-build-<ws>-<sha>    builds the bundle, then exits       │
│   Deployment  wf-<ws>         1 pod: Hatchet worker at <sha>      │
└───────────────────────────────────────────────────────────────────┘
```

| State                                         | Lives in                                                |
| --------------------------------------------- | ------------------------------------------------------- |
| Workflow code, schedules, retries, timeouts   | Git, `workflows/`                                       |
| Runs, tasks, attempts, inputs, outputs, logs  | Hatchet (its Postgres)                                  |
| Which commit is deployed, build log, manifest | Mongo, `workflow_deployments` (new)                     |
| Hatchet tenant id and token, worker API key   | Mongo, encrypted, and a Kubernetes Secret per workspace |
| Built bundles                                 | Mako's artifact store, keyed by workspace and SHA       |

## 5. The workflow file

```ts
// workflows/customer-health.workflow.ts
import { hatchet, mako } from "@makoai/workflows";

type Input = { customerIds: string[] };

export const customerHealth = hatchet.workflow<Input>({
  name: "customer-health",
  on: { cron: "0 8 * * *" },
});

const fetchCustomers = customerHealth.task({
  name: "fetch-customers",
  retries: 3,
  fn: async input =>
    mako.query(
      "warehouse",
      "select id, plan, mrr from customers where id = any($1)",
      [input.customerIds],
    ),
});

customerHealth.task({
  name: "score-customers",
  parents: [fetchCustomers],
  fn: async (_input, ctx) => {
    const { rows } = await ctx.parentOutput(fetchCustomers);
    return rows.map(c => ({
      id: c.id,
      score: c.mrr > 1000 ? "healthy" : "watch",
    }));
  },
});
```

```ts
// workflows/index.ts — the one list the worker registers and the build reads
export const workflows = [customerHealth, enrichLead, dailyDigest];
```

Rules the build enforces: `workflows/index.ts` exists and exports
`workflows`; it typechecks; it imports only the packages in §3.

## 6. `@makoai/workflows`

A small package, shipped in the runtime image. It wires credentials from the
pod's environment and adds nothing to Hatchet's semantics.

| Export                                 | What it does                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `hatchet`                              | `Hatchet.init()` with the workspace's tenant token.                                                    |
| `mako.query(connection, sql, params?)` | Calls Mako MCP `sql_execute_query`. Writes succeed only under the double gate in §3.                   |
| `mako.tools()`                         | Mako MCP tools as AI SDK tools, for agent steps.                                                       |
| `mako.model(id)`                       | An AI SDK model through Mako's gateway pass-through, e.g. `mako.model("anthropic/claude-sonnet-5-5")`. |

About 250 lines. If it ever needs to know about tasks, retries or ordering, it
has gone too far.

## 7. Agent steps

An agent step is code inside a task. It runs in the same worker pod, calls
models through `mako.model()`, and gets tools from `mako.tools()` plus any
TypeScript function in the workflow.

**Small, read-only agents** run the whole loop in one task:

```ts
const research = enrichLead.task({
  name: "research-lead",
  executionTimeout: "5m",
  retries: 1,
  fn: async (_i, ctx) => {
    const lead = await ctx.parentOutput(loadLead);
    const { text } = await generateText({
      model: mako.model("anthropic/claude-sonnet-5-5"),
      tools: await mako.tools(),
      stopWhen: stepCountIs(8),
      prompt: `Research ${lead.company} and summarize sales context.`,
    });
    return { summary: text };
  },
});
```

**Agents that write data or run longer** use Hatchet's durable pattern. A
durable task runs the loop, and each model turn and tool call is a child task.
Hatchet checkpoints each one, so a crash at turn 7 resumes at turn 7 without
repeating tool calls or tokens. Each turn also shows as its own task on the run
page, so no separate trace view is needed.

This pattern ships as a copyable file in the workspace template,
`workflows/lib/agent.ts`, about 80 lines of plain Hatchet code. It is user
code, not a Mako API.

**Guardrails for every agent step:** a turn limit, an `executionTimeout`, and
a worker API key that is read-only unless an admin opts the key in to
`query:write`. Each model call logs its token usage to the task log.

Mako's in-product chat agent is not available as a workflow step. It is built
around a live chat stream, and wrapping it would turn the Mako API into a
second long-running executor.

## 8. Deploy pipeline

Triggered by `notifyRepoPushed` → `syncRepoBackedResources` →
`syncWorkflowsFromRepo(workspaceId, sha)`, only for `main`, only when the flag
is on and something under `workflows/` changed.

| Step | Where   | What happens                                                                                                                                                                                                                                                                             |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | API     | Insert `workflow_deployments` `{ sha, status: "building" }`. Send Inngest event `workflows/deploy.requested`.                                                                                                                                                                            |
| 2    | Inngest | Export `workflows/` at `sha` from the bare repo as a tarball to the artifact store.                                                                                                                                                                                                      |
| 3    | GKE Job | `wf-build-<ws>-<sha>` on the gVisor pool, runtime image in build mode. It downloads the source, runs `tsc --noEmit` and `esbuild`, imports `index.ts` to write `manifest.json` (workflow names, crons, task names), and uploads the bundle and manifest. No network beyond the Mako API. |
| 4    | Inngest | On failure: `status: "failed"`, build log saved, stop. The live pod is untouched.                                                                                                                                                                                                        |
| 5    | Inngest | First deploy only: create the Hatchet tenant and token, mint the worker API key, write the Kubernetes Secret.                                                                                                                                                                            |
| 6    | Inngest | Apply Deployment `wf-<ws>` with `GIT_SHA=<sha>`. The pod fetches its bundle from the Mako API at start, then starts the worker with label `git_sha=<sha>`.                                                                                                                               |
| 7    | Inngest | Wait for the rollout and for the worker to register in Hatchet. Then `status: "live"`, and the previous deployment becomes `replaced`.                                                                                                                                                   |

**Rollouts.** A standard rolling update: the new pod starts, the old pod gets
SIGTERM, and the worker stops taking tasks and finishes the ones it holds,
within a 30-minute grace period. A task cut off by the grace period is retried
by Hatchet on the new pod.

**Rollback** is a revert commit on `main`.

## 9. Security model

| Workflow code can                    | It cannot                                | Because                                                                                                                              |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Run arbitrary TypeScript             | Escape to the node or reach other pods   | gVisor runtime, one pod per workspace, and the notebook-kernel network policy: deny RFC1918 and the metadata server, allow HTTPS out |
| Reach Hatchet                        | Reach anything else inside the cluster   | One extra egress rule: the `hatchet` namespace on the gRPC port only                                                                 |
| Read workspace data through Mako MCP | Hold database credentials                | Data goes through MCP with the worker API key                                                                                        |
| Write to flagged connections         | Write anywhere else                      | `query:write` scope on the key **and** `allowAgentWrites` on the connection, both existing                                           |
| Call models                          | See Mako's gateway key                   | The pass-through injects the key server-side                                                                                         |
| See its workspace's runs             | See any other workspace                  | One Hatchet tenant per workspace                                                                                                     |
| Run until `executionTimeout`         | Exhaust the node                         | Pod CPU and memory limits; Hatchet enforces timeouts                                                                                 |
| Become live from `main`              | Become live from a branch or an API call | Only the push hook on `main` deploys                                                                                                 |

The build Job runs untrusted code (the TypeScript compiler imports
`index.ts`), so it uses the same pool and network policy as the worker.

## 10. UI

Three surfaces in a "Workflows" rail section. See the mockups.

| Surface    | What it shows                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runs list  | Table of runs: status, workflow, started, duration. Filters: workflow, status. The explorer lists workflow names, and clicking one filters the table and shows its Run button. A footer shows the live commit, or "Build failed" with the error. |
| Run page   | Status, started, duration, commit, and Cancel or Replay. Tasks in order with a timeline bar. Clicking a task opens Input, Output (error and attempt count on top) and Logs.                                                                      |
| Run button | JSON input box, prefilled from the last run. Run opens the new run's page.                                                                                                                                                                       |

## 11. API and MCP tools

Mounted at `/api/workspaces/:id/workflows`, behind auth, then workspace
context, then the feature flag.

| Route                                                  | Does                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GET /`                                                | Workflows from the live manifest, plus the latest deployment (live commit, or the failed build and its error) |
| `GET /runs?workflow&status&cursor`                     | Hatchet run list                                                                                              |
| `GET /runs/:runId`                                     | Run with tasks, attempts and the `git_sha` of each task's worker                                              |
| `GET /runs/:runId/tasks/:taskId/logs`                  | Task logs                                                                                                     |
| `POST /:name/run`                                      | Start a run with JSON input. Adds `additionalMetadata` `{ trigger, triggeredBy }`.                            |
| `POST /runs/:runId/cancel`, `POST /runs/:runId/replay` | Hatchet cancel and replay                                                                                     |
| `GET /runtime/bundle/:sha`                             | The pod fetches its bundle. Worker API key only.                                                              |
| `ALL /runtime/ai-gateway/*`                            | Pass-through to the Vercel AI Gateway. Worker API key only.                                                   |

The worker API key gets a new scope, `workflows:runtime`, which only the two
`/runtime` routes accept. Run `pnpm openapi:sync` after the routes land.

**MCP tools**, all in the **deferred** tier so the tier-policy test passes:
`workflow_list`, `workflow_run` (name and input, returns a run id), and
`workflow_get_run` (tasks, errors, and the tail of each task's log). There is
also a system skill, `api/src/agent-skills/workflows/`, covering the file
rules, `@makoai/workflows`, and the agent pattern.

## 12. Infrastructure to add

| Piece              | Where                                      | Notes                                                                                                                                                                       |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hatchet            | `deploy/workflows/hatchet/`                | Official Helm chart in namespace `hatchet`, Cloud SQL Postgres, internal gRPC Service. A staff-only dashboard behind IAP.                                                   |
| Namespace and pool | `deploy/workflows/k8s/`                    | `mako-workflows` namespace on the existing gVisor node pool, `RuntimeClass` reused.                                                                                         |
| Network policy     | `deploy/workflows/k8s/network-policy.yaml` | A copy of the kernel policy plus egress to `hatchet` on gRPC.                                                                                                               |
| Runtime image      | `deploy/workflows/runtime/`                | Node 20, the pinned packages from §3, an entrypoint with `build` and `run` modes. Built by `build-and-deploy.sh` like the kernel image.                                     |
| Local              | `docker-compose.yml`                       | Hatchet Lite next to the notebook kernel. `pnpm dev` runs the worker as a local process with no Kubernetes (`WORKFLOWS_RUNTIME=local`, refused when `NODE_ENV=production`). |

## 13. Code footprint

```
api/src/workflows/
  hatchet-admin.service.ts     tenant + token provisioning           ~200
  hatchet-client.ts            per-tenant client cache                ~80
  workflow-sync.service.ts     push hook → deployment row            ~150
  k8s-deployer.ts              build Job, Deployment, Secret, rollout ~350
  local-runtime.ts             dev worker as a local process          ~100
  workflow-runs.service.ts     list / get / logs / run / cancel       ~300
api/src/inngest/functions/workflows-deploy.ts                         ~200
api/src/routes/workflows.routes.ts  (+ runtime routes)                ~250
api/src/database/workspace-schema.ts  WorkflowDeployment model         ~60
api/src/agent-lib/tools/workflow-tools.ts + skill                     ~250
packages/workflows-sdk/            @makoai/workflows                  ~250
deploy/workflows/                  runtime entrypoint, manifests      ~300
app/src/components/workflows/
  WorkflowsExplorer  WorkflowRunsView  WorkflowRunView  RunDialog     ~700
app/src/store/workflowStore.ts, rail, tab kinds, icons                ~150
workspace template: 3 examples + workflows/lib/agent.ts               ~250
tests                                                                 ~700
```

About **4,000 lines**, roughly 3,300 of them code.

**Stop rule:** if the work needs a run table, a scheduler, a queue, a retry
loop or a log store in Mako, stop and simplify. Each of those is Hatchet's.

## 14. Build plan

### Phase 0: spike (throwaway branch)

| #   | Check                                                                                 | Pass                                                                              |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| S1  | Hatchet Helm on the staging cluster with Cloud SQL. Create a tenant and token by API. | A script prints a token, and a worker registers with it.                          |
| S2  | A worker under gVisor with the locked-down network policy plus the Hatchet rule.      | It connects, runs tasks, and survives a pod kill without losing the task.         |
| S3  | A rolling update while a 5-minute task runs.                                          | The task finishes on the old pod, or is retried on the new one. Write down which. |
| S4  | Durable task with `spawnChild` per turn. Does the waiting parent hold a worker slot?  | Known, and slot counts set for it.                                                |
| S5  | Run list through the REST API for one tenant, filtered by workflow and status.        | p95 under 300 ms at 10k runs.                                                     |
| S6  | Licence check of Hatchet and its Helm chart.                                          | Recorded in this RFC.                                                             |

The spike also produces the runtime image and Helm values that PR 1 cleans up.

### Phase 1: first working version, six PRs

Each PR merges on its own and leaves `main` working.

| PR                      | Contents                                                                                                                                           | Done when                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **1. Infra**            | `deploy/workflows/` (Hatchet Helm values, namespace, network policy, runtime image), Hatchet Lite in docker-compose                                | Hatchet runs on staging, and a hand-applied worker registers                                     |
| **2. SDK and template** | `packages/workflows-sdk`, the three examples, `workflows/lib/agent.ts`, the `workflows:runtime` scope, `/runtime/ai-gateway` and `/runtime/bundle` | The examples run locally against Hatchet Lite with `WORKFLOWS_RUNTIME=local`                     |
| **3. Deploy pipeline**  | `WorkflowDeployment` model, `workflow-sync.service`, `hatchet-admin.service`, `k8s-deployer`, the Inngest function, the feature flag               | Merging `workflows/` on staging builds and rolls a worker. A bad commit leaves the old one live. |
| **4. Runs API**         | `workflow-runs.service`, `workflows.routes`, `openapi:sync`                                                                                        | `curl` lists runs, shows a run, starts, cancels and replays                                      |
| **5. UI**               | Rail entry, explorer, runs list, run page, Run dialog                                                                                              | Demo steps 2 to 4, 7 and 8 work in the browser                                                   |
| **6. Agent surface**    | Three MCP tools, the skill, tier classification, docs page                                                                                         | Demo steps 1 and 5 work from Claude Code against staging                                         |

Demo steps 6 and 9 are covered by tests in PR 3 (pod kill) and PR 4 (tenant
isolation), and then run by hand on staging.

**Separately:** rename Flows to Sync in the UI. It is independent and can ship
first.

## 15. Later phases

Ordered by expected need. Each starts only when real use asks for it.

1. **Scale to zero.** KEDA on Hatchet's Task Stats API, as Hatchet documents.
   It matters once many workspaces have workflows that run rarely.
2. **Third-party npm packages.** Install from the workspace lockfile inside
   the build Job, with `--ignore-scripts`, cached per lockfile hash.
3. **Secrets.** Workspace env-vault values injected as environment variables
   into the worker.
4. **Failure notifications.** Reuse the Sync run-notification service.
5. **Branch tests.** Run a session branch's code before merging, on a
   separate tenant with namespaced workflow names.
6. **Richer run page.** Version history, per-workflow overview, charts, the
   chat run card.

## 16. Not in scope

Visual editor, workflow DSL, YAML or JSON workflow format, dry runs,
approvals, human task inbox, DSAR, custom scheduler, queue, retry engine,
execution database or log store, Temporal or Inngest adapters, customer
access to the Hatchet dashboard, Python workflows, customer-hosted workers,
Mako's chat agent as a step.

## 17. How this relates to what exists

| Need                                                                        | Use                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Move data from a source to a destination, on a schedule or by CDC           | **Sync**, formerly Flows (declarative YAML, Inngest) |
| Transform data in the warehouse                                             | **dbt**                                              |
| Refresh an app's data on a schedule                                         | **App bindings** with `-- schedule:`                 |
| Multi-step logic in code: call APIs and models, branch, retry, combine data | **Workflows**                                        |

`apps.md` §4.9 "scheduled jobs in mako.json" is superseded.

## 18. Open questions

1. **Pricing and quotas.** Per run, per task-second, or included? Model usage
   is already metered by the gateway.
2. **Cold start under scale to zero** (Phase 2). Pod start plus image pull
   under gVisor is probably 10 to 30 seconds. Is that acceptable for
   on-demand runs, or do active workspaces keep one warm pod?
3. **Retention.** How long Hatchet keeps runs and logs, and what we promise
   customers. Set after S5.
