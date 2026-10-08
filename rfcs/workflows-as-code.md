# RFC: Workflows as code — native Hatchet workflows in the workspace repo

**Status:** proposal v7. Supersedes v3 (issue #761) and v4–v6. v7 makes
workflows optional and removes Kubernetes as a requirement, so the open
source project can run them anywhere.
**Plan and mockups:** https://claude.ai/artifact/4ivqohdXB3zwBGKMH4SzFG

## 1. Summary

A workflow is a TypeScript file in the workspace repo, under `workflows/`,
written against Hatchet's own SDK. Merging to `main` deploys it. Hatchet runs
it, and Mako shows the runs.

Mako is the thinnest possible layer on Hatchet:

| Mako adds | What |
|---|---|
| A connection | One Hatchet API token per workspace |
| A deploy | The commit the worker should run, saved on the workspace |
| A worker | The runtime image. It follows that commit by itself. |
| A read path | One allowlisted pass-through to Hatchet's REST API |
| Screens | Runs list, run page, Run |
| Agent tools | Three MCP tools and a skill |

No new collection, no npm package, no Mako service, no queue.

### Installing it

Workflows are optional. An installation picks one row:

| Use | Hatchet | Setup |
|---|---|---|
| **Off** (default) | none | Set nothing. The routes answer "not set up" and the UI hides Workflows. |
| **Local testing** | Hatchet Lite from `docker-compose.yml` | `docker compose --profile workflows up -d`. Mako creates the tenant. Not for production. |
| **Production** | Hatchet Cloud, or a Hatchet you run | Set `HATCHET_CLIENT_TOKEN`. Run the worker container. |
| **Mako's cloud** | Our own Hatchet on GKE | Mako creates a tenant and a sandboxed pod per workspace. |

`HATCHET_DASHBOARD_URL` makes Mako link admins to the Hatchet dashboard, and
each run page to the same run there. Mako does not proxy the dashboard.

## 2. Architecture

Each fact has one owner.

| Owner | Knows | Mako reads it through |
|---|---|---|
| Git | Workflow code, schedules, retries, timeouts. Version = commit SHA. | The bare repo (`git archive`) |
| Hatchet | Registered workflows, runs, tasks, attempts, input, output, logs, crons | Hatchet REST with the workspace's token |
| Mako | The Hatchet token, the commit the worker should run, the commit it reports running, the last build error. Who may see what. | — |

```
workspace repo ──push to main──▶ Mako API: save target commit
                                   ▲   │ REST, workspace token
              poll: what do I run? │   ▼
                         worker ──gRPC──▶ Hatchet
worker ──▶ Mako API: /runtime/head, /runtime/source/:sha, /runtime/status,
                     /runtime/ai/*, /api/mcp
```

### The token is the whole connection

A Hatchet API token is a JWT that names its tenant, the REST address and the
worker (gRPC) address. So a workspace's connection is that one value, and it
is the same for Hatchet Cloud, a self-hosted Hatchet and Hatchet Lite. Hatchet
keeps one tenant's token from reading another tenant.

Where the token comes from, first match wins:

1. The workspace's own token, pasted by an admin.
2. `HATCHET_CLIENT_TOKEN`: one tenant for the whole installation.
3. Created by Mako when `HATCHET_ADMIN_PASSWORD` is set: Mako logs in to a
   Hatchet it operates, creates a tenant for the workspace and saves its
   token. Used by local testing and by Mako's cloud.

### The worker follows a commit

One worker serves one workspace. It holds one credential, a Mako API key
with the scope `workflows:runtime`, and loops:

1. `GET /runtime/head` → the commit to run and the Hatchet token.
2. When the commit changes: download `workflows/` at it, run `tsc --noEmit`.
3. Start a worker process for the new commit (label `git_sha=<sha>`). Once
   it is up, tell the old process to finish its running tasks and exit.
4. `POST /runtime/status`: the commit now running, or the build error.

A commit that fails its typecheck, or cannot start, is reported and skipped.
The process for the previous commit keeps running. Rollback is a revert
commit. There is no build job, no bundle storage and no deploy queue.

Who starts the worker is the one thing that differs between installations
(`WORKFLOWS_WORKER_PROVIDER`, the same idea as `KERNEL_PROVIDER`):

| Provider | Who runs it | Sandbox |
|---|---|---|
| `static` | The operator: the compose service, or the image anywhere. The key is `WORKFLOWS_WORKER_KEY`. | None. For the operator's own code. |
| `gke` | Mako creates a Secret and a Deployment per workspace, once | gVisor, locked-down egress. For code from people the operator does not know. |

## 3. Infra

Only Mako's cloud needs any. It builds on what Mako already runs for notebook
kernels (`deploy/notebook-kernels/`): the same GKE cluster, gVisor node pool
and locked-down egress.

| Piece | What | New or reused |
|---|---|---|
| Hatchet | Official Helm chart, namespace `hatchet`. Dashboard for staff only. | New |
| Hatchet API address | An internal load balancer, so the Mako API on Cloud Run can reach Hatchet (`HATCHET_API_URL`) | New |
| Namespace | `mako-workflows` on the gVisor node pool | Pool reused |
| Network policy | Copy of the kernel policy (HTTPS out, no private ranges, no metadata server), plus Hatchet gRPC | Copied |
| Runtime image | Node 20 + pinned `@hatchet-dev/typescript-sdk`, `ai`, `@ai-sdk/gateway`, `@ai-sdk/mcp`, `zod`, `tsx`, `typescript`, `entrypoint.mjs`, `worker.mjs` | New |
| Per workspace | One `Secret` (the Mako API key) and one `Deployment` with 1 replica | Created on first deploy |

The pod is created once and replaced only for a new runtime image. Deploying
a commit never touches Kubernetes.

## 4. Data model

One optional field on `Workspace`, and no new collection:

```ts
workflows?: {
  enabled: boolean;         // staff-set feature flag
  hatchetToken?: string;    // AES-256-CBC; absent with HATCHET_CLIENT_TOKEN
  workerApiKeyId?: ObjectId; // scopes: mcp, query:read, workflows:runtime
  target?: { sha, tree };   // set on push: where workflows/ last changed
  live?: { sha };           // reported by the worker
  failed?: { sha, error };  // reported by the worker
}
```

| Not stored by Mako | Read from |
|---|---|
| Workflow list, crons | Hatchet, registered workflows |
| Runs, tasks, logs | Hatchet |
| Hatchet tenant id and addresses | The token |
| Commit of a run | Hatchet, the worker label `git_sha` |
| Who started a run | Hatchet, `additionalMetadata` |

v6 read the live commit and the build error from Kubernetes. v7 stores them,
because an installation without Kubernetes has nowhere else to keep them.

## 5. Files

Mako ships no SDK. Workflow code imports Hatchet and the AI SDK directly. Two
small helper files live in the customer's repo, where they can read and
change them.

### Mako repo

| File | What | Lines |
|---|---|---|
| `api/src/workflows/hatchet.ts` | Read the token. Optional tenant creation. REST allowlist. | 340 |
| `api/src/workflows/kube.ts` | The `gke` provider only: ensure the Secret and Deployment | 220 |
| `api/src/workflows/on-push.ts` | Called from `syncRepoBackedResources` on `main`: save the target, ensure token and worker | 210 |
| `api/src/routes/workflows.ts` | Status, Hatchet pass-through, Run, and the worker's routes | 420 |
| `api/src/database/workspace-schema.ts` | The `workflows` field | 15 |
| `api/src/auth/api-key-scopes.ts` | Add `workflows:runtime` | 5 |
| `api/src/agent-lib/tools/workflow-tools.ts` | Three MCP tools, deferred tier | 140 |
| `api/src/agent-skills/workflows/SKILL.md` | File rules, helpers, agent pattern | 80 |
| `app/src/components/workflows/*` | `WorkflowsExplorer`, `RunsTable`, `RunView`, `RunDialog` | 500 |
| `app/src/lib/*`, store | Rail entry, tab kinds, icons, a small store | 90 |
| `deploy/workflows/` | Helm values, namespace, network policy, Dockerfile, `entrypoint.mjs`, `worker.mjs` | 400 |
| `docker-compose.yml` | Profile `workflows`: Hatchet Lite and the worker | 45 |

### Workspace template (customer repo)

```
workflows/
  index.ts                    export { hatchet, workflows }       10
  hatchet.ts                  HatchetClient.init()                  3
  lib/mako.ts                 query · tools · model                40
  lib/agent.ts                durable agent loop                   80
  customer-health.workflow.ts sequential example                   40
  daily-digest.workflow.ts    cron example                         30
  enrich-lead.workflow.ts     AI agent example                     40
```

All of `lib/mako.ts`:

```ts
import { createGateway } from "@ai-sdk/gateway";
import { createMCPClient } from "@ai-sdk/mcp";

const url = process.env.MAKO_URL!;
const key = process.env.MAKO_API_KEY!;
const auth = { Authorization: `Bearer ${key}` };

export const model = createGateway({
  baseURL: `${url}/api/workflows/runtime/ai`, apiKey: key,
});

export async function tools() {
  const mcp = await createMCPClient({
    transport: { type: "http", url: `${url}/api/mcp`, headers: auth },
  });
  return mcp.tools();
}

export async function query(connection: string, sql: string) {
  const t = await tools();
  return t.sql_execute_query.execute({ connection, sql });
}
```

### API routes

All routes are workspace-scoped and behind auth. The runtime routes accept
only the worker API key, with the `workflows:runtime` scope.

| Route | Does |
|---|---|
| `GET /workflows` | Whether workflows are set up and on, the target and live commit, the build error, the dashboard URL. The workflow and cron lists come from the pass-through. |
| `GET /workflows/hatchet/*` | Pass-through to an allowlist of Hatchet REST reads: run list, run, task logs, workers. The tenant token is added server-side. |
| `POST /workflows/:name/run` | Start a run, with `additionalMetadata` `{ trigger: "ui", triggeredBy }` |
| `POST /workflows/runs/:id/cancel`, `/replay` | Hatchet cancel and replay |
| `GET /workflows/runtime/head` | The commit the worker should run, and the Hatchet token |
| `GET /workflows/runtime/source/:sha` | `git archive <sha> workflows/` as a tarball |
| `POST /workflows/runtime/status` | The worker reports the commit it runs, or a build error |
| `ALL /workflows/runtime/ai/*` | Pass-through to the Vercel AI Gateway with Mako's key |

The UI uses Hatchet's own response shapes, so Mako keeps no copy of them.
Pin the Hatchet version so those shapes stay stable.

## 6. Mockups

Three screens in a "Workflows" rail section, modeled on Hatchet's dashboard.
See the artifact.

| Screen | What it shows |
|---|---|
| Runs list | Status, workflow, started, duration. Filters for workflow and status. The explorer lists workflow names; clicking one filters the table and shows Run. The footer shows the live commit, or "Build failed". |
| Run page | Status, started, duration, commit, and Cancel or Replay. Tasks in order with a timeline bar. Clicking a task opens Input, Output (error and attempts on top) and Logs. |
| Run | A JSON box prefilled from the last run's input. |

## 7. Agent tools

**Tools for coding agents** (Claude Code, Mako's own agent), in the deferred
tier:

| Tool | In → out |
|---|---|
| `workflow_list` | nothing → workflow names and crons, the live commit, and the build error if the last deploy failed |
| `workflow_run` | `{ name, input }` → `{ runId }` |
| `workflow_get_run` | `{ runId }` → status, each task's status, attempts and error, and the last 50 log lines per task |

The loop an agent follows: write the file and add it to `index.ts`, merge to
`main`, call `workflow_list` until the live commit matches (or read the build
error and fix it), then `workflow_run` and `workflow_get_run`. Writing files
uses the existing repo tools. Cancel and replay stay in the UI for now.

**Agents inside a workflow** are ordinary code:

```ts
import { generateText, stepCountIs } from "ai";
import { model, tools } from "./lib/mako";

enrichLead.task({
  name: "research-lead",
  parents: [loadLead],
  executionTimeout: "5m",
  fn: async (_i, ctx) => {
    const lead = await ctx.parentOutput(loadLead);
    const { text } = await generateText({
      model: model("anthropic/claude-sonnet-5-5"),
      tools: await tools(),
      stopWhen: stepCountIs(8),
      prompt: `Research ${lead.company}.`,
    });
    return { summary: text };
  },
});
```

- **Short, read-only agents:** one task, as above. A retry restarts the loop.
- **Long agents, or agents that write data:** `lib/agent.ts`, a Hatchet
  durable task with one child task per model turn and tool call. A crash
  resumes at the last turn, and each turn shows on the run page.
- **Data:** Mako MCP with the worker key. Read-only unless an admin grants
  the key `query:write` **and** flags the connection `allowAgentWrites`.
- **Models:** through Mako's pass-through, billed to the workspace. The
  gateway key never enters the pod.
- **Hatchet MCP:** not used. It would need raw tenant tokens.

## 8. Decisions to validate

1. Workflows live in the workspace repo, `workflows/`, written by members and
   their agents. Behind a staff-set flag at first.
2. Native Hatchet code, no Mako SDK. Two helper files in the customer's repo,
   about 120 lines together.
3. A workspace's connection to Hatchet is one token. Hatchet Cloud, a
   self-hosted Hatchet and Hatchet Lite all work. Mako's cloud runs its own
   Hatchet with one tenant per workspace.
4. The worker follows the commit Mako names. One container per workspace,
   run by the operator (`static`) or as a gVisor pod (`gke`), always on in
   V1. Scale to zero with KEDA later.
5. Deploy = save the target commit. The worker typechecks it before
   switching; a failed check keeps the old code running.
6. No new collection. One field on `Workspace`, which holds the token and
   the deploy state.
7. The UI reads Hatchet through an allowlisted pass-through, using Hatchet's
   own response shapes.
8. Three screens: runs list, run page, Run.
9. Data and tools come from Mako MCP, models from the gateway pass-through.
   Writes keep the existing double gate.
10. Only the runtime image's packages in V1. Customer npm dependencies come
    next, installed with `--ignore-scripts`.

## 9. Build order

| Step | Contents | Done when |
|---|---|---|
| 0. Spike | Hatchet Helm on staging, a hand-made tenant, a worker under gVisor with the network policy, a pod kill and a rolling update during a long task | A task survives a pod kill and a redeploy |
| 1. Infra | `deploy/workflows/`, Hatchet Lite in docker-compose | A hand-applied worker registers on staging |
| 2. Backend | `hatchet.ts`, `kube.ts`, `on-push.ts`, routes, the Workspace field and scope, the self-switching worker, the compose profile | A merge on staging deploys, a bad commit keeps the old code, and `curl` lists runs |
| 3. UI | Rail entry, runs list, run page, Run | The three screens work against staging |
| 4. Agent | Three MCP tools, the skill | Claude Code writes, deploys, runs and checks a workflow on staging |

Separately, and first if convenient: rename Flows to Sync in the UI.

## 9a. Spike results (local, Hatchet Lite, SDK 1.36.0, 2026-10-07)

| Check | Result |
|---|---|
| Create a tenant and a token by API | Works. Log in as a Hatchet service user, `POST /api/v1/tenants`, then `POST /api/v1/tenants/:id/api-tokens`. The default retention is 720 h. |
| Redeploy while a task runs (SIGTERM) | Works. The old worker stops taking tasks, finishes the running one (27 s here), then exits. Nothing is retried. |
| Crash while a task runs (SIGKILL) | Works. About 27 s later Hatchet reassigns the task to the new worker. It costs one retry from the task's budget, so a task needs `retries >= 1` to survive a crash. |
| Commit of each task | Works with two reads. The run's task events (`ASSIGNED`) carry the worker id, and the worker list carries the `git_sha` label. A crash shows as `REASSIGNED`. |
| Still to check on GKE | gVisor plus network policy, slot use by durable agent loops, run-list speed at 10k runs |

Two SDK features simplify the plan:

- **`inputValidator` (zod)** gives each workflow an input schema. The Run
  dialog and `workflow_run` can show the expected fields, with no Mako code.
- **`workflow.mcpTool("claude" | "openai")`** turns a Hatchet task into an
  agent tool, so each tool call runs as a durable, visible Hatchet task. This
  could replace most of `lib/agent.ts`; to try during step 2.

## 10. Later, only when real use asks

Scale to zero (KEDA on Hatchet's Task Stats API), customer npm dependencies,
secrets from the workspace env vault, failure notifications, branch tests,
version history, cancel and replay as MCP tools.

## 11. Not in scope

Visual editor, workflow DSL, YAML workflows, approvals, human inbox, custom
scheduler, queue, retry engine or log store, customer access to the Hatchet
dashboard, Python workflows, Mako's chat agent as a step.
