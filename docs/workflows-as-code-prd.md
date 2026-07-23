# PRD: Workflows as Code

> Vibe-code deterministic multi-step jobs in TypeScript. Mako is the trigger,
> connector context, runtime, and monitor — not an n8n canvas.

**Status:** Proposal  
**Related:** Sync Flows (`IFlow` / CDC), Transforms (dbt virtual FS + GitHub binding),
Connectors, Inngest platform jobs, [Hatchet](https://github.com/hatchet-dev/hatchet)

---

## 1. Summary

Replace cumbersome n8n-style JSON graphs with **TypeScript workflows** stored in
Mako (virtual filesystem, optional Git sync — same pattern as dbt Transforms).

A workflow is a normal `async` function. Multi-step durability comes from named
**steps** (Inngest `step.run` / Hatchet child-task style). Triggers, connector
credentials, retries, and run history are platform concerns. The AI agent edits
workflow files and debugs failed runs — “vibe code / vibe fix,” not drag-and-drop.

This is a **new product surface**, separate from Sync Flows (ELT into warehouses).
Sync stays the high-throughput data plane. Workflows cover event automation,
reverse-ETL-style SaaS writes, and (later) compute/OCR pipelines that Sync cannot
express cleanly.

---

## 2. Motivation

### 2.1 Jobs Sync Flows cannot own

| Use case | Why Sync is the wrong tool |
| --- | --- |
| Calendly webhook → create Close opportunity | Multi-step side effects, branching, CRM writes |
| Reverse-ETL: dbt mart → Close / RealAdvisor | Warehouse → SaaS mutate, not table materialization |
| Document OCR → BigQuery | Long-running compute + structured extract |
| Slack-driven ops / self-heal loops | Event + agent + mutate, not CDC MERGE |

Today these live in n8n (or one-off scripts). n8n JSON is verbose, hostile to AI
editing, and disconnected from Mako connectors, marts, and auth.

### 2.2 Desired outcomes

1. **Vibe-code workflows** — agent (or human) writes ~50 lines of TS instead of an n8n graph.
2. **Deterministic jobs** — durable steps, retries, idempotency; not “ask an LLM every time.”
3. **Git-friendly files** — virtual FS now; GitHub binding later (dbt precedent).
4. **Mako as orchestrator + monitor** — triggers, secrets, runs, logs; no required canvas.
5. **Reuse connectors** — Close, Calendly, BQ, etc. injected; keys never in source files.
6. **Thin abstraction** — one clear `workflow()` + `step()` contract; engine swappable.

### 2.3 Non-goals (v1)

- Visual node editor / n8n-compatible import as source of truth
- Language-agnostic runtimes (Python/Ruby workers) — TypeScript only
- Replacing Sync Flows / CDC with workflows
- Full Inngest → Hatchet migration of existing platform jobs
- Self-healing Slack agents (follow-on once runs + files exist)
- YAML workflow DSLs

---

## 3. Product principles

1. **TypeScript is the source language.** Conditionals, loops, and fan-out are language features.
2. **Files are the artifact.** Same mental model as dbt models / app files — not Mongo form blobs.
3. **Steps make side effects durable.** Bare connector calls inside a workflow body are a lint error once we enforce it.
4. **Connectors are injected context.** Workflows never embed API keys.
5. **Canvas is optional projection.** Monitoring + code view first; lineage graph later if useful.
6. **Bicycle before rocket.** Static load of published workflows into a worker beats hot-reload architecture on day one.
7. **Keep Sync and Workflows distinct.** Shared credentials and UX chrome; different schemas and engines.

---

## 4. Goals & success metrics

### 4.1 Goals

| Horizon | Goal |
| --- | --- |
| MVP | One real n8n flow replaced (Calendly → Close opportunity) running in Mako |
| v1 | Reverse-ETL style mart → Close upsert as a second workflow; run history + agent edit |
| v1.5 | Optional GitHub binding; webhook + cron triggers; basic fixture tests |
| Later | OCR/compute steps; self-heal from Slack/run failures; engine consolidation |

### 4.2 Success metrics

- Time to author Calendly→Close workflow (agent-assisted) ≪ equivalent n8n build
- ≥1 production n8n workflow migrated and n8n dependency removed for that path
- Failed runs diagnosable from Mako UI + agent chat without leaving the product
- Zero secrets committed in workflow source (static check)
- Step retries do not double-create CRM objects when idempotency keys are set

---

## 5. Personas & jobs-to-be-done

| Persona | JTBD |
| --- | --- |
| RevOps / founder (Jonas) | Replace n8n with vibe-coded TS jobs tied to Mako connectors |
| Platform eng (Kirill) | Thin runtime abstraction; durable execution without Inngest UI pain at scale |
| AI agent | Read connector shapes + write/edit workflow files + explain failed steps |
| Workspace member | Enable/disable workflows, see runs, replay, inspect inputs/outputs |

---

## 6. Core abstraction

### 6.1 Mental model

```
Trigger  →  Workflow (async TS)  →  named Steps (durable I/O)  →  Result
                │
                ├── connectors.*  (injected)
                ├── step("name", fn)
                ├── step.sleep / waitForEvent
                └── normal if / map / try
```

**Multi-step convention (non-negotiable):**

> A workflow is a normal TypeScript `async` function. Every external side effect
> goes through `step("name", ...)`. Branching and loops are ordinary TS.
> On retry, completed step names are skipped and their results reused.

This matches battle-tested patterns in Inngest (`step.run`) and Hatchet
(`task.run` / durable child spawn). Mako should adopt this convention, not invent
a graph DSL on top.

### 6.2 Authoring API (proposed)

```ts
import { workflow, step } from "@mako/workflow";
import { z } from "zod";

const CalendlyInviteeCreated = z.object({
  invitee: z.object({
    uri: z.string(),
    email: z.string().email(),
    name: z.string().optional(),
  }),
  event_type: z.string(),
});

export default workflow({
  name: "calendly_to_close_opportunity",
  description: "Create a Close opportunity when a Calendly demo is booked",
  trigger: {
    type: "connector_webhook",
    connector: "calendly",
    event: "invitee.created",
  },
  input: CalendlyInviteeCreated,

  async run(input, ctx) {
    const close = ctx.connectors.close();
    const email = input.invitee.email.toLowerCase();

    const lead = await step("find_or_create_lead", async () => {
      return close.leads.upsert({
        email,
        name: input.invitee.name,
        idempotencyKey: `lead:${email}`,
      });
    });

    if (input.event_type !== "demo") {
      return { status: "skipped", reason: "not_demo", leadId: lead.id };
    }

    const opp = await step("create_opportunity", async () => {
      return close.opportunities.create({
        leadId: lead.id,
        name: `Demo — ${email}`,
        idempotencyKey: `opp:${input.invitee.uri}`,
      });
    });

    return { status: "ok", leadId: lead.id, opportunityId: opp.id };
  },
});
```

### 6.3 Reverse-ETL sketch

```ts
export default workflow({
  name: "sync_account_managers_to_close",
  trigger: { type: "cron", cron: "0 */6 * * *" },

  async run(_input, ctx) {
    const bq = ctx.connectors.bigquery(); // or ctx.databases.get("warehouse")
    const close = ctx.connectors.close();

    const rows = await step("fetch_mart", async () => {
      return bq.query(`
        select account_id, name, domain, owner_email, updated_at
        from \`proj.dbt.mart_accounts\`
        where updated_at > timestamp_sub(current_timestamp(), interval 12 hour)
      `);
    });

    await Promise.all(
      rows.map((row) =>
        step(`upsert_lead:${row.account_id}`, async () => {
          return close.leads.upsert({
            ...row,
            idempotencyKey: `acct:${row.account_id}`,
          });
        })
      )
    );

    return { upserted: rows.length };
  },
});
```

### 6.4 What belongs in a step vs inline

| Inline (OK) | Must be a `step` |
| --- | --- |
| Pure transforms, string/date math | Connector / HTTP / DB calls |
| Input Zod parse (platform) | Slack/email sends |
| Cheap deterministic branching predicates | Sleeps, wait-for-event, human approval |
| Building payloads from prior step outputs | Anything that must not double-fire on retry |

---

## 7. Project layout

Mirror Transforms (dbt) — Mongo virtual FS first; optional GitHub binding later.

```text
workflows/                              # project root (per workspace project)
  mako_workflows.yml                    # name, version, defaults
  calendlyToCloseOpportunity.ts
  syncAccountManagersToClose.ts
  _lib/                                 # shared helpers (optional)
    closeMappers.ts
  _fixtures/                            # sample payloads for local/CI replay
    calendly_invitee_created.json
```

`mako_workflows.yml` (minimal):

```yaml
name: revenue_ops_workflows
version: 1
# Environments bind logical connector names → workspace connector IDs
# (resolved at publish/run time; never store secrets here)
```

**Publish model (v1):** draft files in virtual FS → **Publish** snapshots a
version (SHA / `EntityVersion`) → worker loads **published** bundle only.
Editing draft does not affect production until publish (same spirit as apps/dbt).

---

## 8. Architecture

### 8.1 Context diagram

```
┌─ Authoring ─────────────────────────────────────────────────┐
│  In-Mako editor + agent  │  (later) GitHub sync / Cursor     │
│  Virtual FS (Mongo)      │  workflow_write_file tools        │
└────────────────────────────┬────────────────────────────────┘
                             │ publish snapshot
                             ▼
┌─ Control plane (Mako API) ──────────────────────────────────┐
│  Triggers: connector webhooks, cron, manual                  │
│  Credential injection: workspace connectors (encrypted)      │
│  Run records: status, step timeline, I/O redaction           │
│  Deploy registry: workspace → published workflow bundle      │
└────────────────────────────┬────────────────────────────────┘
                             │ enqueue
                             ▼
┌─ Execution plane ───────────────────────────────────────────┐
│  Durable engine (decision: Hatchet and/or Inngest — §15)     │
│  Worker(s): load published TS bundle, register workflows     │
│  step() → engine checkpoint / retry / concurrency            │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
              Close / Calendly / BQ / Slack / …
              via existing Mako connector clients
```

### 8.2 Relationship to existing systems

| System | Relationship |
| --- | --- |
| **Sync Flows (`IFlow`)** | Unchanged. ELT/CDC into destinations. Workflows may *call* SQL or react to sync completion later; they do not replace Sync. |
| **Connectors** | Read credentials + typed clients from workspace connectors. Prefer existing connector SDK surfaces; add thin “action” helpers where sync-only APIs are insufficient (e.g. Close create opportunity). |
| **dbt Transforms** | Virtual FS + GitHub binding + drafts/publish are the **pattern to copy**, not the storage to share. Workflows are a sibling project type. |
| **Inngest today** | Continues to run sync/CDC/dbt/dashboard jobs unless/until a deliberate migration. Workflows may use Inngest *or* Hatchet — see open decisions. |
| **n8n** | Migration target: reimplement flows as TS workflows; no requirement to import n8n JSON. |
| **Apps / MCP** | Out of scope for MVP. Later: agent/MCP tools to edit workflows headlessly (apps PRD precedent). |

### 8.3 Worker load model (bicycle)

**v1:** On publish (or worker boot), materialize published files to disk (or
esbuild bundle), register `workflow()` exports with the engine, restart or
hot-swap worker process for that workspace/pool.

**Not v1:** Arbitrary eval of draft code on every save; multi-tenant untrusted
code without sandbox. If user-defined npm deps become required, revisit
sandboxing (connector-builder PRD / E2B) as a separate workstream.

Trusted authors (workspace members) writing TS that imports `@mako/workflow` +
connector clients is enough for internal RevOps replacement of n8n.

---

## 9. Triggers

| Trigger | MVP | Notes |
| --- | --- | --- |
| `connector_webhook` | ✅ | Reuse webhook ingress patterns from sync/CDC where possible |
| `cron` | ✅ | Schedule stored on workflow publish config |
| `manual` | ✅ | “Run now” from UI with optional JSON payload |
| `flow.run.terminal` / sync completed | Later | Event bridge from existing Inngest bus |
| `http` (signed URL) | Later | Generic ingress |

Trigger config lives with the workflow export (or sibling config in
`mako_workflows.yml` for env-specific cron). Platform validates connector webhook
capability at publish time.

---

## 10. Data model (proposed)

New workspace-scoped collections (names illustrative):

### 10.1 `WorkflowProject`

- `workspaceId`, `name`, `slug`
- `defaultEnvironment` bindings (logical connector name → `connectorId` / `databaseConnectionId`)
- Optional `repoBinding` (same shape as `IDbtRepoBinding` — later)
- `publishedVersionId`, timestamps

### 10.2 `WorkflowFile`

- `projectId`, `path`, `content`, `updatedAt`, `updatedBy`
- Draft tree in Mongo (dbt `DbtFile` precedent)

### 10.3 `WorkflowVersion` (publish snapshot)

- Immutable file tree + compiled manifest (workflow names, triggers, step names if statically discoverable)
- `gitSha` optional
- Content hash

### 10.4 `Workflow` (deployed unit — denormalized for runtime)

- `projectId`, `versionId`, `name`, `trigger`, `enabled`
- Pointer used by scheduler / webhook router

### 10.5 `WorkflowRun`

- `workflowId`, `versionId`, `triggerKind`, `status` (`queued|running|succeeded|failed|cancelled`)
- `input` (redacted), `output`, `error`
- `steps[]`: `{ name, status, attempt, startedAt, finishedAt, error? }`
- Engine run id (Inngest/Hatchet) for deep links

Reuse `EntityVersion` / notification patterns where they already fit
(`NotificationResourceType` may gain `"workflow"`).

---

## 11. API surface (sketch)

All under workspace auth (`unifiedAuthMiddleware` + workspace context):

| Method | Path | Purpose |
| --- | --- | --- |
| CRUD | `/workspaces/:id/workflow-projects` | Project lifecycle |
| Files | `.../workflow-projects/:pid/files` | Virtual FS read/write (agent tools) |
| Publish | `.../workflow-projects/:pid/publish` | Snapshot → register worker |
| List | `.../workflows` | Deployed workflows + enabled flag |
| Run | `.../workflows/:wid/runs` | Manual trigger + history |
| Get run | `.../workflows/:wid/runs/:rid` | Step timeline |
| Webhook | existing or `.../hooks/workflows/:wid/...` | Ingress |

Agent tools (server-side): `workflow_write_file`, `workflow_read_file`,
`workflow_publish`, `workflow_explain_run`, `workflow_list_runs` — dedicated
agent mode/skill later (`api/src/agent-skills/workflows/`).

---

## 12. UI (thin)

MVP UI — **no node canvas**:

1. **Workflows explorer** — list projects / workflows, enabled toggle
2. **Code editor** — Monaco on virtual FS (reuse dbt/app editor patterns)
3. **Publish / versions**
4. **Run history** — status, duration, step timeline, input/output JSON
5. **Manual run** — paste fixture JSON
6. **Agent side chat** — edit files + explain failures (monitor, not canvas)

Lineage / graph view is a later projection of the compiled manifest + step
timeline, never the source of truth.

---

## 13. Security & tenancy

- Workspace-scoped everything; connector credentials decrypted only in worker/runtime path
- Redact secrets from run logs and step I/O
- Publish RBAC: member edit drafts; admin (or role TBD) publish to prod
- Idempotency keys required by convention for mutate steps; lint/guide in skill docs
- v1 assumes trusted workspace authors (same trust as writing sync config / dbt). Untrusted multi-tenant sandbox is out of scope
- Webhook signatures verified via existing connector webhook capabilities

---

## 14. Migration from n8n

1. Pick highest-pain flow (Calendly → Close)
2. Agent reimplements as TS workflow using connector guidelines / skills
3. Point Calendly webhook at Mako (or dual-run shadow)
4. Compare outcomes; disable n8n
5. Repeat for reverse-ETL and remaining automations

No automated n8n JSON importer in v1.

---

## 15. Open decisions

### 15.1 Execution engine: Hatchet vs Inngest

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Inngest for workflows** | Already in-repo; `step.run` matches convention; fastest MVP | Self-hosted UI pain at high event volume (scrapers signal); couples workflows to current bus |
| **B. Hatchet for workflows only** | Durable tasks/DAGs, workers, better high-churn ops story; keeps Sync on Inngest | Second runtime to operate; dynamic registration still required |
| **C. Migrate platform to Hatchet** | One engine long-term | Large rewrite; blocks bicycle |

**Recommendation:** Decide with a short spike — implement the same Calendly→Close
workflow against both `step` shims. Prefer **B** if scraper/event-volume pain is
already forcing Hatchet; else **A** for MVP speed with an engine-agnostic
`@mako/workflow` façade so B remains possible.

`@mako/workflow` must not leak engine types into user workflow files.

### 15.2 Dynamic registration

Engines expect workflows registered on workers. Approaches:

1. **Publish → rebuild bundle → restart/reload worker** (MVP)
2. Per-workspace worker pools with versioned bundles
3. Sandboxed eval / isolate (later, if untrusted code)

Document reload SLOs (e.g. publish visible within N seconds).

### 15.3 Connector action coverage

Sync connectors are pull/CDC oriented. Workflows need **outbound actions**
(create opportunity, upsert lead). Options:

- Extend connector classes with an `actions` surface
- Thin workflow-only clients wrapping existing APIs
- HTTP step + documented Close API (escape hatch)

MVP should ship Close lead/opportunity actions needed for the golden path.

### 15.4 Git

- **MVP:** Mongo virtual FS + publish versions (dbt-like)
- **Next:** `IWorkflowRepoBinding` copying `IDbtRepoBinding`
- Real git is valuable for AI/PRs; not a blocker for first production workflow

---

## 16. Workstreams

### WS0 — Package & convention (`@mako/workflow`)

- `workflow()` / `step()` / context types
- Zod input validation
- Engine adapter interface (`InngestAdapter` | `HatchetAdapter`)
- Fixture replay helper for tests
- Lint guidance: no secrets; mutate steps need idempotency keys

### WS1 — Persistence & virtual FS

- Schema: project, files, versions, runs
- Routes + Zustand store + Monaco editor shell
- Publish snapshot pipeline

### WS2 — Runtime worker

- Bundle published project
- Register workflows with chosen engine
- Inject connector clients
- Persist step timeline → `WorkflowRun`
- Manual + cron + one connector webhook trigger

### WS3 — Golden path: Calendly → Close

- Webhook trigger wiring
- Close action helpers
- End-to-end run in a workspace
- Agent skill: how to write workflows + connector action shapes

### WS4 — Reverse-ETL path

- Cron + BQ/SQL query step + Close upsert fan-out
- Concurrency limits / batching helpers
- Document pattern: mart → SaaS

### WS5 — Agent mode

- File tools + explain run + “fix from error” loop
- Skill under `api/src/agent-skills/workflows/`

### WS6 — GitHub binding (optional)

- Reuse GitHub App install + push sync + protected branch patterns from dbt

### WS7 — Hardening

- Redaction, RBAC, rate limits, replay, alerting (`flow.run.terminal`-style fanout)
- Metrics: run success rate, step latency, publish reload time

---

## 17. Implementation phases

### Phase 0 — Spike (engine + API shape)

- [ ] Spike Calendly→Close on Inngest `step.run` behind `@mako/workflow`
- [ ] Spike same on Hatchet durable tasks
- [ ] Choose engine for WS2; keep façade
- [ ] List Close actions required; gap vs current connector

### Phase 1 — MVP (bicycle)

- [ ] Virtual FS project + editor
- [ ] Publish → worker register
- [ ] `connector_webhook` + `manual` + `cron`
- [ ] Run history with step timeline
- [ ] Calendly → Close golden path in one workspace
- [ ] Minimal agent file edit tools

### Phase 2 — v1

- [ ] Reverse-ETL workflow example + helpers
- [ ] Agent skill + explain failed run
- [ ] Notifications on failure
- [ ] Fixture-based replay in CI/publish checks

### Phase 3 — Expand

- [ ] GitHub binding
- [ ] Sync-completion triggers
- [ ] Compute/OCR step type (kernel or worker)
- [ ] Self-heal experiments (agent reads failure + opens draft fix)
- [ ] Revisit engine consolidation

---

## 18. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Second orchestrator ops burden | Façade + single product surface; Sync stays on Inngest until deliberate migration |
| Double-writes on retry | Mandatory `step` + idempotency keys; tests with fixture replay |
| Dynamic registration complexity | Publish/restart bicycle first |
| Connector gaps for CRM writes | Explicit Close action work in Phase 0/1 |
| Scope creep into “n8n clone” | No canvas; TS files only; one golden path |
| Untrusted code execution | Trusted authors only in v1; sandbox later if needed |
| Confusion with Sync “Flows” | Product naming: **Workflows** vs **Sync**; separate nav |

---

## 19. Naming

| Term | Meaning |
| --- | --- |
| **Sync / Sync Flow** | Existing ELT/CDC `IFlow` into warehouse/DB tables |
| **Workflow** | This PRD — TS durable automation |
| **Step** | Named durable unit of side effect inside a workflow |
| **Workflow project** | Virtual FS bundle of workflow files (like a dbt project) |
| **Publish** | Immutable snapshot loaded by workers |

Avoid calling workflows “flows” in UI copy to prevent collision with Sync.

---

## 20. Appendix A — Why not X

| Alternative | Why not (for this product) |
| --- | --- |
| **n8n in Mako** | JSON graphs are AI-hostile; duplicates connectors; canvas-first |
| **YAML DSL (Kestra-style)** | Poor fit for branching; team preference is TS; YAML was illustrative only |
| **Stretch Sync `IFlow`** | Wrong write model (MERGE/tables vs CRM side effects) |
| **Cursor-only + raw Hatchet** | Works for one-shots; loses shared connectors, webhooks, workspace monitor, agent context |
| **Full Dagster/asset platform** | Right philosophy for data assets; heavy for RevOps automations; Python-first |
| **LLM does the job every run** | Costly, slow, nondeterministic — agents *author* workflows; engines *run* them |

---

## 21. Appendix B — Multi-step convention cheatsheet

```ts
// Sequence
const a = await step("a", () => ...);
const b = await step("b", () => ...);

// Branch
if (a.ok) {
  await step("c", () => ...);
} else {
  await step("d", () => ...);
}

// Fan-out
await Promise.all(
  items.map((item) => step(`work:${item.id}`, () => ...))
);

// Wait
await step.sleep("cooldown", "5m");
const evt = await step.waitForEvent("approved", { timeout: "48h" });

// Compose
const enriched = await step.run(enrichWorkflow, input);
```

**Remember:** the workflow function may be replayed; only `step` boundaries are
safe for side effects.

---

## 22. Appendix C — Thread consensus (internal)

Product direction distilled from internal discussion:

- n8n is cumbersome; target is thin TS workflows in Mako
- Hatchet is interesting (also for scrapers vs Inngest UI limits) but engine ≠ product
- Missing piece called out: **dynamic registration of code from storage into workers**
- Virtual FS (like dbt) is acceptable; git sync is valuable later, not a blocker
- Canvas not required — monitoring + code view
- Simplest useful shape: **trigger + data + keys + TypeScript function + success/failure**
- Mako’s unique value: connectors, webhooks, shared context, monitor/agent — not locking authoring away from Cursor

This PRD turns that consensus into an implementable convention and phased plan.
