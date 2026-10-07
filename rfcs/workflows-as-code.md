# RFC: Workflows as code — native Hatchet workflows in the workspace repo

**Status:** proposal v6, the plan to validate. Supersedes v3 (issue #761)
and v4–v5.
**Plan and mockups:** https://claude.ai/artifact/4ivqohdXB3zwBGKMH4SzFG

## 1. Summary

A workflow is a TypeScript file in the workspace repo, under `workflows/`,
written against Hatchet's own SDK. Merging to `main` deploys it to a
sandboxed pod. Hatchet runs it, and Mako shows the runs.

The goal is the thinnest possible layer on Hatchet:

| Mako adds | Size |
|---|---|
| One pod per workspace, deployed by setting `GIT_SHA` | ~150 lines of Kubernetes client code |
| One allowlisted pass-through to Hatchet's REST API | ~150 lines |
| Three screens: runs list, run page, Run | ~600 lines |
| Three MCP tools and a skill | ~220 lines |
| New collections, npm packages, Mako services | 0 |

About **1,600 lines** of Mako code, plus about 400 lines of tests.

## 2. Architecture

Each fact has exactly one owner, and Mako never copies state it can read.

| Owner | Knows | Mako reads it through |
|---|---|---|
| Git | Workflow code, schedules, retries, timeouts. Version = commit SHA. | The bare repo (`git archive`) |
| Kubernetes | Which SHA is deployed, whether the pod started, the build error | The Kubernetes API, as `gke-kernel-provider.ts` does |
| Hatchet | Registered workflows, runs, tasks, attempts, input, output, logs, crons | Hatchet REST with the workspace's tenant token |
| Mako | Who may see what, plus the screens and agent tools | — |

```
workspace repo ──push to main──▶ Mako API ──k8s API──▶ Deployment wf-<ws> (gVisor)
                                   │                        │ gRPC
                                   │ REST, tenant token     ▼
                                   └──────────────────▶ Hatchet + Postgres
pod ──▶ Mako API: /runtime/source/:sha, /runtime/ai/*, /api/mcp
```

## 3. Infra

Built on what Mako already runs for notebook kernels (`deploy/notebook-kernels/`):
the same GKE cluster, gVisor node pool and locked-down egress.

| Piece | What | New or reused |
|---|---|---|
| Hatchet | Official Helm chart, namespace `hatchet`, Neon Postgres (direct endpoint, timezone UTC). Dashboard for staff only, through `kubectl port-forward`. | New |
| Namespace | `mako-workflows` on the gVisor node pool | Pool reused |
| Network policy | Copy of the kernel policy (HTTPS out, no private ranges, no metadata server), plus Hatchet gRPC | Copied |
| Runtime image | Node 20 + pinned `@hatchet-dev/typescript-sdk`, `ai`, `@ai-sdk/gateway`, `@ai-sdk/mcp`, `zod`, `tsx`, `typescript`, and `entrypoint.mjs` | New |
| Per workspace | One `Secret` (Hatchet token, Mako API key) and one `Deployment` with 1 replica | Created on first push |
| Local | Hatchet Lite in `docker-compose.yml`. The same entrypoint runs as a local process. | New service in existing file |

### A deploy, start to finish

1. A merge to `main` touches `workflows/`.
2. The push hook (`syncRepoBackedResources` → `on-push.ts`) sets `GIT_SHA` on
   Deployment `wf-<ws>`. The first time, it creates the Hatchet tenant, the
   worker API key, the Secret and the Deployment.
3. The new pod downloads `workflows/` at that SHA from
   `/runtime/source/:sha`, runs `tsc --noEmit`, starts the worker with label
   `git_sha=<sha>`, then writes `/tmp/ready`.
4. Kubernetes stops the old pod. Its worker stops taking tasks and finishes
   the ones it holds within the 30-minute grace period. Hatchet retries any
   it could not finish.
5. If `tsc` fails, the new pod never becomes ready, so the rollout stalls and
   the old pod keeps running. The UI shows the unready pod's last log lines
   as the build error.

There is no build job, no bundle storage, no deploy queue and no Inngest
function. Rollback is a revert commit.

### The Deployment

```yaml
kind: Deployment
metadata: { name: wf-<ws>, namespace: mako-workflows }
spec:
  replicas: 1
  progressDeadlineSeconds: 300
  strategy: { rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  template:
    spec:
      runtimeClassName: gvisor
      terminationGracePeriodSeconds: 1800
      containers:
        - name: worker
          image: workflows-runtime:<pinned>
          env:
            - { name: GIT_SHA, value: 8fc2ad1 }
            - { name: MAKO_URL, value: https://app.mako.ai }
          envFrom: [{ secretRef: { name: wf-<ws> } }]
          readinessProbe: { exec: { command: [test, -f, /tmp/ready] } }
          resources: { limits: { cpu: "1", memory: 1Gi } }
```

## 4. Data model

One optional field on `Workspace`, and no new collection:

```ts
workflows?: {
  enabled: boolean;        // staff-set feature flag
  hatchetTenantId: string;
  hatchetToken: string;    // AES-256-CBC, like connection secrets
  workerApiKeyId: string;  // scopes: mcp, query:read, workflows:runtime
}
```

| Not stored by Mako | Read from |
|---|---|
| Workflow list, crons | Hatchet, registered workflows |
| Runs, tasks, logs | Hatchet |
| Live commit | Kubernetes, the Deployment's `GIT_SHA` |
| Build error | Kubernetes, the unready pod's logs |
| Commit of a run | Hatchet, the worker label `git_sha` |
| Who started a run | Hatchet, `additionalMetadata` |

## 5. Files

Mako ships no SDK. Workflow code imports Hatchet and the AI SDK directly. Two
small helper files live in the customer's repo, where they can read and
change them.

### Mako repo

| File | What | Lines |
|---|---|---|
| `api/src/workflows/hatchet.ts` | Create tenant and token. Per-tenant client. REST allowlist. | 150 |
| `api/src/workflows/kube.ts` | Ensure Secret and Deployment, set `GIT_SHA`, read status and logs | 150 |
| `api/src/workflows/on-push.ts` | Called from `syncRepoBackedResources` on `main` | 40 |
| `api/src/routes/workflows.ts` | Status, Hatchet pass-through, Run, runtime source and AI | 160 |
| `api/src/database/workspace-schema.ts` | The `workflows` field | 15 |
| `api/src/auth/api-key-scopes.ts` | Add `workflows:runtime` | 5 |
| `api/src/agent-lib/tools/workflow-tools.ts` | Three MCP tools, deferred tier | 140 |
| `api/src/agent-skills/workflows/SKILL.md` | File rules, helpers, agent pattern | 80 |
| `app/src/components/workflows/*` | `WorkflowsExplorer`, `RunsTable`, `RunView`, `RunDialog` | 500 |
| `app/src/lib/*`, store | Rail entry, tab kinds, icons, a small store | 90 |
| `deploy/workflows/` | Helm values, namespace, network policy, Deployment template, Dockerfile, `entrypoint.mjs` | 220 |
| `docker-compose.yml` | Hatchet Lite | 20 |

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
| `GET /workflows` | Live commit (from Kubernetes), or the build error, plus workflows from Hatchet |
| `GET /workflows/hatchet/*` | Pass-through to an allowlist of Hatchet REST reads: run list, run, task logs, workers. The tenant token is added server-side. |
| `POST /workflows/:name/run` | Start a run, with `additionalMetadata` `{ trigger: "ui", triggeredBy }` |
| `POST /workflows/runs/:id/cancel`, `/replay` | Hatchet cancel and replay |
| `GET /workflows/runtime/source/:sha` | `git archive <sha> workflows/` as a tarball |
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
3. Self-hosted Hatchet on our GKE, one tenant per workspace.
4. One gVisor pod per workspace, always on in V1. Scale to zero with KEDA
   later.
5. Deploy = set `GIT_SHA` on the pod. Typecheck at pod start; a failed check
   keeps the old pod running.
6. No new collection. One field on `Workspace`.
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
| 2. Backend | `hatchet.ts`, `kube.ts`, `on-push.ts`, routes, the Workspace field and scope, template files | A merge on staging deploys, a bad commit keeps the old pod, and `curl` lists runs |
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
