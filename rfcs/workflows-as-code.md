# RFC: Workflows as code — native Hatchet workflows in the workspace repo

**Status:** proposal v4. Refines issue #761 (v3); nothing in v3's intent changes.
**Continues:** RFC #904 (flows as code), `rfcs/connectors-as-code.md` (tenant
code in a workspace box), `apps.md` §4.9 (scheduled jobs), §19 (branch policy),
§20/§23 (dbt in the repo).
**Mockups:** https://claude.ai/artifact/4ivqohdXB3zwBGKMH4SzFG

## 1. Summary

A workflow is a TypeScript file in the workspace repo, under `workflows/`,
written against Hatchet's own SDK. When it reaches `main`, Mako builds it,
runs it on a worker in the workspace's E2B box, and shows every run and
every step in the IDE. Hatchet executes; Mako never keeps execution state.

> **Mako Workflows is the Git-native development and operations experience
> for native Hatchet workflows.**

This is the dbt pattern applied to code. dbt models live in `dbt/` and dbt
runs them; workflows live in `workflows/` and Hatchet runs them. Mako adds
discovery, deploys, run inspection and operations.

### 1.1 V1 is deliberately small

V1 runs only what is on `main`. There are no branch tests, no version
history screen and no dashboards. The UI has three things, modeled on
Hatchet's own dashboard: a **runs list**, a **run page**, and a **Run
button**. Everything else waits until real use asks for it (§17).

## 2. What v4 changes from v3

v3 had the right boundary but left the parts that are specific to Mako
open. Each item below was ambiguous or wrong in v3:

| # | v3 said | v4 says | Why |
|---|---|---|---|
| 1 | Workflows live in "the normal repository" | They live in the **workspace repo**, `workflows/` | Mako is multi-tenant. The v3 file layout (`routes/…/page.tsx`, `db.customers`) read like a single Next.js app. |
| 2 | "CI builds worker, deploy worker" | **Push to `main` is the deploy.** Mako builds and rolls the worker. | Workspaces have no CI of their own. Apps and dbt already deploy on push to main. |
| 3 | Sandbox execution is "not V1" | Workers run in a **per-workspace E2B box**, as workspace connectors do | Workflow code is untrusted tenant code. It never runs in the API process. This reuses existing infra and adds no new sandbox feature. |
| 4 | `db.customers.findMany(...)` | Data access goes through **`@makoai/workflows`**: `mako.query()` and `mako.ai` | Tenant code has no database client or credentials today. Something has to give it data. |
| 5 | `ctx.taskOutput(task)` | `await ctx.parentOutput(task)` | `taskOutput` does not exist in Hatchet's TypeScript SDK. |
| 6 | Three environments: local, staging, production | Two separate things: **Mako's own environments** (local, staging, prod, each with its own Hatchet) and, per workspace, what is on `main` (§8) | v3 mixed the two. Customers only ever see their workspace's runs. |
| 7 | Git SHA "associated with every run" | The SHA comes from the **worker label** of the worker that ran the task | Cron runs are started by Hatchet, so Mako cannot stamp them at trigger time. |
| 8 | 800–1,500 LOC | **About 3,000 LOC** with tests (§12) | The UI is about 850. Build, worker box, tenancy and the SDK are the rest. |
| 9 | "Open raw execution in Hatchet" | Staff and self-hosters only | Customers have no Hatchet login and should not get one. |
| 10 | A Processes page, a Runs explorer and a rich run page | **Three surfaces only**: runs list, run page, Run button (§10) | Hatchet's own dashboard proves this is enough to operate workflows. Anything more waits for real use. |
| 11 | Not addressed | **Coding agents** get three MCP tools and a skill | The definition of done says an agent can add a workflow. It also has to see the run. |
| 12 | Not addressed | **Flows is renamed Sync** in the UI, with a new icon | "Flows" next to "Workflows" in the rail reads as the same thing twice. Sync says what it does: move data from a source to a destination. |

## 3. Decisions

The left column is what this RFC decides. Rows marked **confirm** need a
yes from Jonas before the spike starts.

| Question | Decision |
|---|---|
| Who writes workflows | Workspace members and their coding agents, in the workspace repo. **confirm** |
| Engine | Hatchet v1, self-hosted by Mako, MIT-licensed. One engine for tenant code. Inngest stays Mako's internal job runner and is not exposed. |
| Programming model | Native Hatchet TypeScript. No DSL, compiler or wrapper around `workflow()`/`task()`. |
| Where code lives | `workflows/*.workflow.ts`, one workflow per file, plus `workflows/index.ts` exporting the list. |
| Where code runs | A long-lived Hatchet worker in a per-workspace E2B "workflow box". Never in the API process. |
| Deploy | Push to `main`, then Mako builds, typechecks and rolls the worker. A failed build leaves the previous worker running. |
| Version | Git commit SHA. No Mako version table. |
| Execution state | Hatchet only. Mako stores **deployments** (which SHA is live), never runs. |
| Tenancy | One Hatchet tenant per workspace (`ws_<id>`). |
| Branch tests | **Not in V1.** Only `main` runs. Developers test locally with Hatchet Lite until real use shows a hosted branch test is needed. |
| Data and AI access | Through the Mako API via `@makoai/workflows`, with a short-lived scoped token. Read by default; writes only to connections the workspace allows. **confirm** |
| UI | A "Workflows" rail section with three surfaces: runs list, run page, Run button. Modeled on Hatchet's dashboard. Icon: lucide `Workflow`. |
| Flows | Renamed **Sync** in the UI (rail, tabs, breadcrumbs, command palette, docs). Icon changes from `ArrowLeftRight` to lucide `RefreshCcwDot`. The repo folder `flows/`, the API routes and the Mongo collections keep their names. Ships before Workflows. |

## 4. The workflow file

A workflow is plain Hatchet. The only Mako import is the helper package,
which also exports a preconfigured Hatchet client.

```ts
// workflows/customer-health.workflow.ts
import { hatchet, mako } from "@makoai/workflows";

type Input = { customerIds: string[] };

export const customerHealth = hatchet.workflow<Input>({
  name: "customer-health",
  on: { cron: "0 8 * * *" },           // optional; Hatchet owns the schedule
});

const fetchCustomers = customerHealth.task({
  name: "fetch-customers",
  retries: 3,
  fn: async (input) =>
    mako.query("warehouse", {
      sql: "select * from customers where id = any($1)",
      params: [input.customerIds],
    }),
});

const scoreCustomers = customerHealth.task({
  name: "score-customers",
  parents: [fetchCustomers],
  retries: 2,
  fn: async (_input, ctx) => {
    const customers = await ctx.parentOutput(fetchCustomers);
    return customers.rows.map(scoreCustomerHealth);
  },
});

customerHealth.task({
  name: "store-results",
  parents: [scoreCustomers],
  fn: async (_input, ctx) => {
    const scores = await ctx.parentOutput(scoreCustomers);
    await mako.write("warehouse", { table: "customer_health", rows: scores, mode: "upsert", key: ["customer_id"] });
    return { updated: scores.length };
  },
});
```

An AI step is ordinary code inside a task:

```ts
const investigate = enrichLead.task({
  name: "investigate-lead",
  parents: [loadLead],
  retries: 2,
  executionTimeout: "5m",
  fn: async (_input, ctx) => {
    const lead = await ctx.parentOutput(loadLead);
    return mako.ai.generate({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "Research this company and summarize useful sales context.",
      input: lead,
      tools: ["web_search"],
      log: ctx,                          // writes structured model/tool lines to ctx.log
    });
  },
});
```

The registry is the one list both the worker and Mako read:

```ts
// workflows/index.ts
export const workflows = [customerHealth, enrichLead, nightlyImport];
```

### 4.1 `@makoai/workflows`

The package is small on purpose. It is shipped in the workflow box's
template, like `@makoai/connector-sdk` in the sync box.

| Export | What it is |
|---|---|
| `hatchet` | `Hatchet.init()` configured from the box's environment (tenant token, namespace). |
| `mako.query(conn, { sql, params })` | Read-only query through the existing notebook read path (`POST /api/workspaces/:id/notebook/read`). Row, byte and time budgets apply. |
| `mako.write(conn, { table, rows, mode, key })` | Batched insert or upsert. Refused unless the connection is in `workflows/mako.workflows.json` `writableConnections`. New endpoint. |
| `mako.ai.generate(...)` | Calls the AI gateway through Mako, billed to the workspace. When given `ctx`, it emits one structured log line per model call and tool call. |
| `mako.secret(name)` | Reads a value from the workspace env vault (`apps/env.service.ts`). |

It does not wrap, extend or replace any Hatchet API. If a helper starts
needing to know about tasks, retries or ordering, it has gone too far.

## 5. Where everything lives

| Thing | Lives in | Written by |
|---|---|---|
| Workflow code, schedule, retries, timeouts | Git: `workflows/` | Members and agents |
| Writable connections, worker size | Git: `workflows/mako.workflows.json` | Members and agents |
| Run, task and attempt state, inputs, outputs, logs | Hatchet (its Postgres) | Hatchet |
| Which SHA is live, build log, manifest | Mongo: `workflow_deployments` | Mako |
| Hatchet tenant tokens | Mongo, encrypted (AES-256-CBC) | Mako |
| Secrets used by workflow code | Workspace env vault | Members |

Mako adds exactly one collection, and it holds deployments, not runs.

## 6. Lifecycle

```
edit workflows/*.ts  (IDE, terminal or agent)
        ▼
merge to main
        ▼
notifyRepoPushed → syncRepoBackedResources → syncWorkflowsFromRepo
        ▼
build in the workflow box at that SHA
  pnpm install --frozen-lockfile · tsc --noEmit · esbuild bundle
  · import workflows/index.ts → manifest.json
        ▼
  failed? → deployment = failed, old worker keeps running, UI shows the error
        ▼
start new worker (label git_sha=<sha>) on tenant ws_<id>
        ▼
registered → deployment = live → drain the previous worker
        ▼
Mako shows the new SHA on every workflow
```

The manifest is produced by importing the registry, not by parsing source.
For each workflow it records name, file, cron and task names. That is
enough to list workflows that have never run.

## 7. Versions and deploys

- **A workflow's version is the SHA of the live deployment.**
- **A run's version is the SHA on the worker label** of the worker that ran
  its first task. Mako reads it from Hatchet's task metadata and caches
  nothing.
- A run whose tasks ran on two SHAs is shown as mixed, with the SHA per step.
- **Rollback** is a revert commit on `main`. There is no other path, so
  history stays in Git.

The previous worker drains: it stops taking new tasks and exits once its
in-flight tasks finish or a 30-minute ceiling passes. Whether Hatchet can
pin a run's remaining tasks to the worker that started it (worker affinity
on `git_sha`) is spike question S3. If it cannot, mixed runs are allowed and
shown, and this section records that.

## 8. Environments

v3 merged two unrelated things.

**Mako's own environments.** How Mako itself is hosted; customers never see
it. Local, staging and production Mako each run their own Hatchet with its
own Postgres, and their state never mixes. Locally, `pnpm dev` starts
Hatchet Lite in docker-compose next to the notebook kernel.

**Per workspace.** One Hatchet tenant, `ws_<id>`, running the code on
`main`. That is the only thing a customer sees. Testing a change before
merging is done locally against Hatchet Lite in V1; a hosted way to test a
branch is listed under §17.

## 9. Security model

Workflow code is untrusted tenant code, held to the same bar as workspace
connectors (`rfcs/connectors-as-code.md` §6.4).

| The workflow can | It cannot | Because |
|---|---|---|
| Run its own code and reach the internet | Run in, or reach the environment of, the API process | It runs in the workspace's E2B workflow box |
| Query connections through Mako | Hold database credentials | `mako.query` is proxied. The box holds a token, not a password. |
| Write to allowed connections | Write anywhere else | `writableConnections` is checked server-side per call |
| Use a token scoped to `workflows:runtime` for this workspace, valid 1 hour and refreshed by the box supervisor | Push to the repo, call MCP tools or reach another workspace | The box never clones (it receives the bundle), so it never gets the `mgt_` git token |
| See its own workspace's runs | See another tenant's runs | One Hatchet tenant per workspace |
| Run until its `executionTimeout` | Run forever | Hatchet enforces the timeout. The box has CPU and memory limits. |

## 10. Product, V1

Strict minimum, modeled on Hatchet's dashboard. Three surfaces, all in one
"Workflows" rail section. Mockups are in the companion artifact.

| Surface | What it shows |
|---|---|
| **Runs list** | The default view. A table of runs: status, workflow, started, duration. Two filters: workflow and status. The explorer on the left lists workflow names; clicking one filters the table. A one-line footer in the explorer shows the live commit, and turns red when the last build failed. |
| **Run page** | Header with status, commit, duration, and Cancel or Replay. Below it, the tasks in order, each with status, duration and a bar on a shared timeline. Clicking a task opens three tabs: Input, Output (with the error and attempt count when it failed) and Logs. |
| **Run button** | On the runs list, filtered to one workflow. Opens a JSON input box and starts a run. |

Not in V1 UI: a per-workflow overview page, DAG drawing, charts, version
history, branch tests, an AI trace view, a chat run card, form editing, a
visual builder, approvals, a human inbox.

### 10.1 Agent and MCP surface

Three tools, all in the **deferred** tier (`DEFERRED_BUILTIN_TOOL_DOMAINS`),
so the tier-policy test passes:

- `workflow_list` returns the manifest and the live deployment.
- `workflow_trigger` takes a name and input, and returns a run id.
- `workflow_get_run` returns the run with steps, errors and the tail of each
  task's log.

A system skill, `api/src/agent-skills/workflows/`, teaches the file
conventions and `@makoai/workflows`. Writing the files uses the existing
repo tools.

## 11. API

All routes are mounted at `/api/workspaces/:id/workflows`, behind auth then
workspace context. Run routes are thin proxies to Hatchet's REST API, using
the workspace's tenant token.

| Route | Does |
|---|---|
| `GET /` | Manifest plus live deployment |
| `GET /runs?workflow&status&cursor` | Proxies Hatchet run list |
| `GET /runs/:runId` | Run, tasks and attempts, with SHA per task |
| `GET /runs/:runId/tasks/:taskId/logs` | Proxies task logs |
| `POST /:name/trigger` | Starts a run. Adds `additionalMetadata` `{ triggeredBy, trigger: "manual" \| "agent" \| "api" }`. |
| `POST /runs/:runId/cancel` and `/replay` | Hatchet cancel and replay |
| `POST /runtime/query`, `/runtime/write`, `/runtime/ai` | `@makoai/workflows` backend, `workflows:runtime` scope only |

`pnpm openapi:sync` regenerates the client after these land.

## 12. Implementation footprint

Real paths, following the dbt and flows layout:

```
api/src/workflows/
  hatchet-admin.service.ts      tenant provisioning, tokens        ~250
  workflow-sync.service.ts      push hook → build → deployment     ~350
  workflow-box.ts               E2B box, worker supervisor, drain  ~400
  workflow-runs.service.ts      Hatchet REST proxy, SHA mapping    ~300
  runtime.service.ts            query / write / ai for the SDK     ~250
api/src/routes/workflows.routes.ts                                  ~200
api/src/agent-skills/workflows/  +  3 MCP tools                     ~250
packages/workflows-sdk/          @makoai/workflows                  ~200
app/src/components/workflows/
  WorkflowsExplorer.tsx  WorkflowRunsView.tsx
  WorkflowRunView.tsx    TriggerDialog.tsx                          ~700
app/src/store/workflowStore.ts, rail, tab kinds, icons              ~150
```

About **3,000 LOC** with tests. Plus one Mongo model,
`WorkflowDeployment` (`workspaceId`, `sha`, `status`, `buildLog`,
`manifest`, `workerBoxId`, `startedAt`, `endedAt`).

**Stop rule:** if the work needs a run table, a scheduler, a queue, a retry
loop or a log store in Mako, stop and simplify. Each of those is Hatchet's.

## 13. Spike: answer these first

One week, before M1. Each question has a pass condition.

| # | Question | Pass |
|---|---|---|
| S1 | Does Hatchet run self-hosted on our infra (Cloud Run or GKE, Cloud SQL Postgres), with tenants created by API? | A script creates a tenant and token, and a worker registers against it. |
| S2 | Does a long-lived worker in an E2B box stay connected across box pause and resume? | 24 h soak, no lost tasks. If not, keep the box running and measure cost per workspace. |
| S3 | What happens to an in-flight DAG run when a new SHA's worker registers? | Documented behaviour, and whether `desiredWorkerLabels` on `git_sha` pins the rest of the run. |
| S4 | Can the run list filter by workflow, status and time in one call fast enough for the UI? | p95 < 300 ms for 10k runs in a tenant. |
| S5 | Retention and log size limits | Known numbers, written into the docs page. |

## 14. Milestones

| Milestone | Ships | Proves |
|---|---|---|
| **M0** spike | §13 answers | The plan holds |
| **M1** runs | Tenants, build, workflow box, `@makoai/workflows` query, sequential example, `GET /runs` | Push to main runs a workflow |
| **M2** see it | Rail, runs list, run page | Every step is inspectable |
| **M3** operate it | Run button, cancel, replay, cron example, AI example, MCP tools, skill | An agent can write, run and debug a workflow end to end |

## 15. First examples

Not DSAR, which mixes too many concerns. Three small ones, shipped as
workspace-template examples:

1. **Sequential:** trigger → fetch → transform → store.
2. **Scheduled:** cron → fetch → compute → store.
3. **AI:** trigger → load context → model with tools → persist.

## 16. How this relates to what exists

| Need | Use |
|---|---|
| Move data from a source to a destination, on a schedule or by CDC | **Sync**, formerly Flows (declarative YAML, Inngest) |
| Transform data in the warehouse | **dbt** |
| Refresh an app's data on a schedule | **App bindings** with `-- schedule:` |
| Multi-step logic in code: call APIs and models, branch, retry, combine data | **Workflows** |

`apps.md` §4.9 "scheduled jobs in mako.json" is superseded by this RFC.

## 17. Explicitly not V1

Visual editor, workflow DSL, YAML or JSON workflow format, dry run or service
virtualization, approvals, human task inbox, DSAR code, custom scheduler,
queue, retry engine, execution database or log backend, Temporal or Inngest
adapters, customer access to the Hatchet dashboard, Python workflows,
self-hosted customer workers.

Also deferred until real use asks for them: hosted branch tests (running a
session branch's code before merging), a version history screen, a
per-workflow overview page with DAG and charts, an AI trace view, a chat
run card, failure notifications.

## 18. Definition of done

1. A member or coding agent adds `workflows/<name>.workflow.ts` and lists it
   in `workflows/index.ts`.
2. It merges to `main`. Mako builds it, and a failed typecheck shows in the
   explorer footer while the old worker keeps running.
3. Hatchet runs it on the workspace's worker. Cron workflows fire without
   Mako involvement.
4. The explorer lists it, and the footer shows the live commit.
5. The runs list shows every run, filterable by workflow and status.
6. The run page shows every task: status, timing, input, output, logs,
   attempts and error, with the commit that ran it.
7. Run, cancel and replay work from the UI and from the MCP tools.
8. Mako's database holds no run state: `workflow_deployments` is the only
   new collection.

## 19. Open questions

1. **Cost of always-on boxes.** One box per workspace with workflows on `main`
   costs money while idle. Options after S2: pause when the tenant queue is
   empty for N minutes and resume on a Hatchet queue signal, or a shared
   worker pool per region with stronger isolation work. V1 keeps one box.
2. **Pricing and quotas.** Per run, per task-second, or included?
3. **Third-party npm dependencies.** V1 installs from the workspace
   lockfile during the build. Should an allowlist exist?
4. **Notifications on failure.** Reuse `flow-run-notification.service.ts`
   by polling Hatchet, or use Hatchet's own alerting? Probably M4.
5. **Inngest vs Hatchet for tenant code.** This RFC assumes Hatchet for
   per-tenant isolation, MIT licence and Postgres-only operation. Confirm
   that Inngest's self-hosting and licence do not change the call.
