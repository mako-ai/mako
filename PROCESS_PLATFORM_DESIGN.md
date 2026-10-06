# Processes — durable agentic business processes in Mako

Status: v1 vertical slice implemented (`api/src/processes/**`, Processes rail in the
app). Research behind it: [`PIPORY_RESEARCH.md`](./PIPORY_RESEARCH.md).
Author's guide (for humans and coding agents): [`api/src/processes/README.md`](./api/src/processes/README.md).

---

## 0. The one-paragraph version

A **Process** is a TypeScript function `run(ctx, input)` written against five
durable primitives: `ctx.step`, `ctx.agent`, `ctx.approval`, `ctx.task`, and
`ctx.wait`. Every primitive call is a **durable checkpoint** and a **row in the
run timeline**. Mako executes the function on **Inngest** behind a small
`Driver` interface. Mako also writes its own **append-only `ProcessEvent`
journal**, and that journal drives the UI, the audit trail, memoization across
retries and re-runs, and agent traces. **Tools** are Mako objects with typed I/O
and an **effect class** (`read` / `write` / `destructive`). Processes declare
their tools explicitly, and agents get only the tools they are handed. **Agents
are harness-agnostic:** an `AgentHarness` runs the loop, and the runtime owns
tools, limits and tracing. The code is the source of truth. The UI shows the
*business* process (one row per primitive call), and each agent's internal trace
sits behind its row.

---

## 1. Naming: **Process**

| Candidate | Verdict |
|---|---|
| Flow | **Taken.** Flows are Mako's sync/ETL pipelines (`flows/<slug>.yml`). Reusing the word would be a permanent source of confusion. |
| Workflow | Generic. Connotes graph builders (n8n, Pipory) and dev-infra (GitHub Actions). |
| Job | Implies one unit of work; does not fit a run that waits 3 days for a human. |
| Automation | Implies "no humans". Approvals and tasks are first-class here. |
| **Process** | It is literally a *business process*: it has owners, approvals, an audit trail, and it outlives deploys. "Process run #1234" reads well. |

The only ambiguity is with OS processes. In the code we keep the namespace
explicit (`processes/`, `ProcessRun`) and never shadow Node's `process` global:
the SDK factory is `defineProcess`, not `process`.

---

## 2. Design principles

1. **Code is the program; the UI is the projection.** There is no serialized node
   graph. The "flow" view is derived from the code (call sites) and from runs.
2. **Business process vs agent trace.** One `ctx.agent()` call is one step in the
   timeline, however many tool calls it makes inside. Its trace opens on click.
3. **Few primitives, normal language features.** No `ctx.parallel`/`ctx.map`:
   `Promise.all` and `for` loops work because every primitive call has a stable
   name.
4. **Our journal, their scheduler.** The engine (Inngest) wakes, retries and
   memoizes. Mako's `ProcessEvent` journal records what happened and is enough on
   its own to resume a run. That makes the engine replaceable (§6).
5. **Agents propose; deterministic steps dispose.** Agents get read tools by
   default. Write tools need an explicit opt-in. Destructive tools are refused
   inside agents altogether. They run in `ctx.step`, after `ctx.approval`, under
   a ledger that prevents double execution.
6. **Least privilege by construction.** A process can reach exactly the tools it
   declares. A tool can reach exactly the connection slots it declares, and only
   if the workspace bound them.

---

## 3. The SDK

```ts
import { defineProcess, trigger, z } from "../sdk";
import { crm, mail, warehouse } from "../tools/...";

export default defineProcess({
  id: "dsar-deletion",
  name: "DSAR deletion",
  description: "Find, plan, approve, delete and verify a data-subject erasure request.",
  triggers: [trigger.manual(), trigger.event("dsar.requested")],
  input: z.object({ email: z.string().email(), requestId: z.string() }),
  tools: [crm.searchContacts, crm.deleteContact, warehouse.findSubject, mail.send],

  run: async (ctx, input) => {
    const findings = await ctx.agent("Investigate subject", {
      instructions: "Find every record of this person. Read-only.",
      prompt: input,
      tools: [crm.searchContacts, warehouse.findSubject],
      output: Findings,                       // zod → typed result
    });

    const review = await ctx.approval("Approve deletion plan", {
      data: plan, schema: Plan,               // approver may edit, validated
      description: "Review what will be deleted in each system.",
    });
    if (!review.approved) return { outcome: "rejected" as const };

    for (const target of review.data.targets) {
      await ctx.step(`Delete from ${target.system}`, s =>
        s.call(crm.deleteContact, { id: target.recordId }),  // ledgered, once
      );
    }

    await ctx.wait("Grace period", { for: "1h" });
    await ctx.step("Send confirmation", s => s.call(mail.send, {...}));
    return { outcome: "completed" as const };
  },
});
```

### 3.1 Primitives (the whole surface)

| Call | Returns | Durable semantics |
|---|---|---|
| `ctx.step(name, fn, opts?)` | `T` (JSON) | Runs `fn` at least once and memoizes its result. Not re-executed after it succeeds, even across worker crashes, retries, deploys or a manual re-run. `opts`: `retries`, `timeout`. `fn` receives `s` (`log`, `artifact`, `call(tool, input)`, `previousOutput()`, `idempotencyKey`, `signal`, `attempt`). |
| `ctx.agent(name, spec)` | `z.infer<output>` | A bounded tool loop through an `AgentHarness`. It is one step in the timeline, and its trace is recorded. The harness resumes from its own trace after a crash (§5.3). |
| `ctx.approval(title, spec)` | `{ approved, outcome, data, comment, by, at }` | Pauses the run with **nothing running**, as a durable human request. `data` is immutable once requested. If `schema` is given, the approver may edit it and the edit is validated. A timeout gives `outcome: "expired"`. |
| `ctx.task(title, spec)` | `{ data, by, at }` | Pauses until someone submits the form (`form: zod object`). The same mechanism as approval. Throws `HumanRequestExpiredError` on timeout. |
| `ctx.wait(name, { for } \| { until })` | `void` | A durable sleep. The deadline is computed once and journaled. |
| `ctx.wait(name, { event, match?, timeout? })` | event data, or `null` on timeout | Waits for a **business event** emitted into the workspace (§7). |

And `ctx.run`: `{ id, number, processId, workspaceId, trigger }`, which is read-only.

**Why only these five.**

- **`parallel` and `map`** are just `Promise.all(items.map(i => ctx.step(\`x ${i.id}\`, …)))`.
  Step names make the calls deterministic. One less concept.
- **`sleep` and `waitForEvent`** are both "suspend until X", so they share one
  verb, `wait`.
- **`approval` and `task`** are one primitive underneath (`HumanRequest`). They
  are two methods only because the call sites read better and the return types
  differ. The evaluation is in §8.
- **No `ctx.log`** outside steps. Code outside steps re-executes on every replay,
  so a top-level log would duplicate. Logging is `s.log()` inside a step, and the
  primitives already log themselves.

### 3.2 Determinism rules (the only rules authors must learn)

1. **Side effects only inside primitives.** Code between primitive calls re-runs
   on every resume, so it must be pure: no `Date.now()`, no `Math.random()`, no
   I/O. Put those in a `ctx.step`.
2. **Names identify steps.** The same name in a loop gets `#2`, `#3`, and so on,
   in call order. Put an id in the name (`` `Enrich ${lead.id}` ``) when the
   order might change.
3. **Return JSON.** Step results are serialized, so Dates become strings.
   Results are capped at 1 MB; put big things in `s.artifact()`.

### 3.3 Tools

```ts
export const deleteContact = defineTool({
  name: "crm.contact.delete",
  description: "Permanently delete a contact from the CRM.",
  effect: "destructive",                     // read | write | destructive
  connections: ["crm"],                      // binding slots this tool may resolve
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  timeout: "30s",
  execute: async ({ id }, t) => {            // t: workspaceId, runId, idempotencyKey,
    const conn = await t.connection("crm");  //    signal, log, connection(slot)
    ...
  },
  reconcile: async ({ id }, t) => ...,       // optional: "did a lost call already happen?"
});
```

- **Reusable across processes.** Tools live in `api/src/processes/tools/**`.
- **Provisioning is explicit at two levels.**
  - `defineProcess({ tools })` is the envelope: everything the process could ever
    touch. The UI shows it, and a workspace admin can audit it ("this process can
    *destroy* CRM contacts").
  - `ctx.agent({ tools })` must be a subset of the envelope.
  - `s.call(tool)` in a step must be inside the envelope too.
- **Effects.**
  - `read` can be retried freely.
  - `write` is passed a stable `idempotencyKey` and must be idempotent.
  - `destructive` is never retried blindly (see §9). It is refused inside
    `ctx.agent` in v1.
- **Credentials.** A tool never sees Mako's credential store. It asks for a
  *slot* it declared, and that resolves only if the workspace's installation of
  the process bound a connection to that slot (`Process.bindings`). Undeclared
  slot → error. Unbound slot → error that names the slot.
- **Audit.** Every call, from an agent or a step, writes `tool.started` and
  `tool.completed` / `tool.failed` journal events. They carry input, output
  (capped), duration, effect, caller (step or agent iteration) and the process
  version.

### 3.4 Agents and the harness seam

```ts
interface AgentHarness {
  readonly id: string;                       // "ai-sdk", "claude-agent-sdk", "scripted", …
  run(req: AgentRequest, rt: AgentRuntime): Promise<AgentResult>;
}
interface AgentRequest {
  model: string; instructions: string; prompt: string;
  tools: RuntimeTool[];                      // name, description, JSON schema, invoke()
  output: z.ZodType;                         // final structured result
  limits: { maxIterations; maxToolCalls; timeoutMs };
  signal: AbortSignal;
}
interface AgentRuntime {
  emitTurn(turn: AgentTurn): Promise<void>;  // trace + checkpoint in one
  previousTurns(): Promise<AgentTurn[]>;     // what earlier attempts already did
}
```

- The **runtime owns** tool provisioning, invocation and audit (`RuntimeTool.invoke`
  goes through the ledger), limits, timeouts, trace storage, and usage/cost
  rollup. The **harness owns** the loop.
- **v1 harness: `aiSdkHarness`.** It runs Vercel AI SDK `generateText` through
  Mako's AI Gateway (`getModel`), one model call per iteration, with tool
  execution delegated to `RuntimeTool.invoke`. Structured output arrives as a
  forced `submit_result` tool call validated against `output`; a validation
  failure goes back to the model as a tool error.
- **Tests harness: `scriptedHarness`.** A deterministic script, so process tests
  run without a model.
- A Claude Agent SDK or OpenAI Agents SDK harness would expose `RuntimeTool`s as
  an in-process MCP server or as function tools, and use session resume as its
  checkpoint. Nothing in the runtime changes.
- Choose the harness per call (`ctx.agent(name, { harness })`) or per deployment
  (the default).

---

## 4. Persistence model (MongoDB, 5 collections)

| Collection | What | Mutability |
|---|---|---|
| `processes` | A workspace's **installation** of a process definition: `enabled`, connection `bindings` (slot → connectionId), `runCounter`, schedule bookkeeping (`lastScheduledAt`). Created lazily. | mutable config |
| `process_versions` | `{ processId, hash, number, source, outline, manifest(tools+effects, triggers, input JSON schema), firstSeenBuild }`. Unique `(processId, hash)`. | immutable |
| `process_runs` | `{ workspaceId, processId, number, versionId, status, waitingOn, input, output, error, trigger, idempotencyKey, usage rollup, startedAt/endedAt }` | status projection |
| `process_events` | **Append-only journal.** `{ runId, workspaceId, ts, type, stepKey?, versionId, data, dedupeKey? }`. Unique partial index `(runId, dedupeKey)`. | append-only |
| `process_human_requests` | `{ runId, stepKey, kind: approval\|task, title, description, payload (frozen), schema (JSON schema), assignees, status, response, respondedBy, expiresAt, versionId }` | one-way transition pending → final |

**Why not ten tables.**

- Steps, tool invocations, agent runs, model calls, logs and artifacts are all
  **events** in one stream, keyed by `stepKey`.
- One pure reducer, `projectRun(events)`, folds them into the step view for the
  UI. The same function is used in tests.
- Human requests get their own collection because they are queried *across runs*
  (the inbox) and need an atomic "first decision wins" update.
- Versions are split out so that hundreds of runs share one stored source
  snapshot.

**The journal is load-bearing, not just observability.**

- `step.completed` (with `dedupeKey: "step:<key>"`) is the memo. A step whose
  completion is journaled returns the stored output, even in a brand-new engine
  execution (manual "retry run").
- `tool.started` / `tool.completed` with dedupe keys form the **effect ledger**
  (§9).
- `agent.turn` events are both the agent transcript *and* the agent's
  checkpoint.

### 4.1 Event model

| Type | Data |
|---|---|
| `run.created` / `run.started` / `run.completed` / `run.failed` / `run.cancelled` | trigger, input, output, error |
| `run.version_changed` | from → to (a resume executed on newer code) |
| `step.started` / `step.completed` / `step.failed` | kind (step/agent/approval/task/wait), attempt, output, error, willRetry, durationMs |
| `log` | level, message, data |
| `artifact.created` | name, mimeType, content (≤1 MB) |
| `agent.started` / `agent.turn` / `agent.completed` | model, harness, tools; per turn: messages, text, tool calls, usage; totals |
| `tool.started` / `tool.completed` / `tool.failed` | tool, effect, input, output, durationMs, caller |
| `human.requested` / `human.responded` / `human.expired` | request id, title, by, decision |
| `wait.started` / `wait.completed` | until / event, matched payload |

The run timeline in the UI is exactly this stream, grouped by `stepKey`.

### 4.2 Run state machine

```
            ┌──────────────── cancel ─────────────────┐
queued ──► running ──► waiting ──► running ──► completed
              │  ▲          │                 └──► failed ──(retry run)──► queued
              │  └──────────┘ (signal / timer)
              └──► failed
```

- `status ∈ queued | running | waiting | completed | failed | cancelled`.
- `waitingOn = { kind: approval | task | sleep | event, stepKey, title, until?, requestId? }`.
  This replaces `WAITING_FOR_APPROVAL` and `WAITING_FOR_HUMAN`: one status plus
  *what* the run is waiting on gives the UI everything, without a state per wait
  type.
- Business outcomes like "the approver rejected" are **not** run statuses. The
  run *completed*, with an output that says `rejected`. Failure means the
  machinery failed.
- Terminal states are final. "Retry run" on a `failed` run re-queues the *same*
  run. The journal memoizes everything that completed, so execution resumes at
  the failed step.

---

## 5. Execution architecture

```
 defineProcess(...)  ─►  registry  ─►  Process service (start/cancel/respond/emit)
                                              │
                                    ExecutionEngine (enqueue, signal, cancel)
                                     ┌────────┴─────────┐
                              InngestEngine        LocalEngine (tests, dev without Inngest)
                                     │                    │
                       inngest fn "process-run"     in-process re-execution
                                     │                    │
                                 Driver (run / sleepUntil / waitForSignal)
                                     └────────┬─────────┘
                                   executeRun(runId, driver)
                                              │
                              ProcessContext (step/agent/approval/task/wait)
                                              │
                                  Journal (process_events) + models
```

### 5.1 Engine choice: **Inngest**, behind `Driver`

| | Inngest | Hatchet |
|---|---|---|
| Already deployed in Mako | **yes** (v4, 20+ functions, dev server in `pnpm dev`) | no: new Postgres, gRPC worker fleet, second dashboard |
| Code-step memoization | `step.run` by ID, a direct match for `ctx.step` | none for arbitrary code inside durable tasks; side effects must become child tasks |
| Code changing under sleeping runs | step-ID matching, tolerant | replay must be deterministic between checkpoints |
| Human waits | `waitForEvent` + timeout → `null` | `waitFor` + **lookback** (better) |
| Fairness / multi-tenant | concurrency keys, throttle, priority (enough) | stronger |
| License | SSPL server (fine for SaaS; a concern only for a bundled on-prem edition) | MIT |

**Decision: Inngest.** Hatchet would win only for a bundled on-prem edition, for
heavy fair-share scheduling, or for non-TS workers. The `Driver` seam (three
methods) is where a Hatchet adapter would plug in. Because our journal carries
the memo, an adapter only has to provide *scheduling, retries, sleeping and
waking*.

We designed around Inngest's sharp edges:

- **No `waitForEvent` lookback.** Before waiting, a check step reads the request
  state from Mongo. After a response is written, the signal is sent twice:
  immediately, and again ~20 s later via a tiny redelivery function. The second
  copy catches a wait that registered late. On timeout there is a final re-check.
- **32 MiB run state / 4 MiB per step.** Step outputs are capped at 1 MB. Agent
  transcripts and artifacts go to Mongo, never into Inngest state.
- **1000 steps per run.** About 1 step per `ctx.step`/`ctx.agent` and 4 per human
  wait. A whole agent loop is *one* Inngest step. Fan-outs over 200+ items
  should spawn child runs (future: `ctx.step` → `runs.start`).
- **Code outside steps re-runs on every invocation.** Every journal write happens
  inside a driver step.

### 5.2 How a primitive maps onto the driver

```
ctx.step(name, fn)
  driver.run(key, async attempt => {
     memo = journal.completed(key)        → return memo        (engine-independent memo)
     assert run not cancelled
     journal step.started(attempt)
     out = await timeout(fn(s))
     journal step.completed(out)          (dedupeKey step:<key>)
     return out
  }, { retries })                          (Inngest: attempt ≥ retries → NonRetriableError)

ctx.approval(title, spec)
  driver.run(key:request)  → upsert HumanRequest, journal human.requested, run → waiting
  driver.waitForSignal(key, { check: read HumanRequest, timeout })
     Inngest: run(check) → waitForEvent("process/signal", if runId&&key) → run(recheck)
  driver.run(key:resume)   → run → running, journal step.completed(decision)

ctx.wait(name, { for })
  driver.run(key:plan)  → until = now+for (journaled once)
  driver.sleepUntil(key, until); driver.run(key:resume)
```

### 5.3 Agent durability

An agent call is **one** driver step, so Inngest state stays tiny. Inside it, the
harness emits an `agent.turn` event after every model call and its tool calls.
If the worker dies mid-loop, the step retries, and the harness calls
`rt.previousTurns()` and resumes from the transcript. It does not start over.

A partially executed turn (a crash between a tool call and the turn record) is
re-asked of the model. That is safe because agent tools are `read`, or `write`
with idempotency keys. Destructive tools never run inside agents.

### 5.4 Versioning

- A **version** is `sha256(run.toString() + manifest)`. The manifest is the
  declared tools and effects, the triggers and the input JSON schema. Each
  distinct hash gets a row in `process_versions` with an incrementing number
  (v1, v2, …), the exact source text, and the build that first ran it.
- Every run records `versionId` at creation. Every journal event records the
  `versionId` of the code that wrote it. If a waiting run resumes after a deploy
  that changed the process, the journal records `run.version_changed`.
  - Later steps carry the new version.
  - Completed steps are never re-executed: step-ID memoization, the Inngest
    model.
  - We always know exactly which definition executed each step.
- Approvals freeze `payload` and `versionId` at request time.
- **Pinning** (Trigger.dev style: a run always finishes on its starting version)
  needs immutable deployable bundles. That falls out naturally from
  workspace-repo processes running in sandboxes (§12), where a version *is* a git
  SHA. Mako-repo processes deploy with Mako and use the Inngest semantics above.
- Breaking change while runs are waiting: rename the process `id` (new
  function), or keep step names stable. The UI warns when a waiting run's version
  is not current.

### 5.5 Triggers

`trigger.manual()`, `trigger.event(name)`, `trigger.schedule(cron, { timezone })`.

- **Manual / API.** `POST /processes/:id/runs` with input. An optional
  `idempotencyKey` is unique per process, so duplicates return the existing run.
- **Event.** `POST /processes/events { name, data, idempotencyKey }`, or the
  internal `emitProcessEvent()`. It starts every enabled process with that
  trigger *and* delivers to every run waiting on that event (§7). Webhooks are an
  authenticated thin wrapper over this (next increment).
- **Schedule.** One Inngest cron (`process-scheduler`, every 5 minutes) checks
  `isCronDue` per enabled installation and claims it optimistically, the same
  pattern as flows and dashboards. Disabled in dev, like the other schedulers.
- The model is extensible: a trigger is `{ type, ... }`, and adding `webhook` or
  `queue` means adding an ingestion endpoint that calls `startRun`.

---

## 6. Reliability

| Concern | Answer |
|---|---|
| Worker crash mid-run | The Inngest re-invokes the function. Completed steps are memoized by Inngest *and* the journal. The in-flight step retries. |
| Duplicate trigger events | `idempotencyKey` unique index on runs. Inngest event ids dedupe for 24 h. |
| Duplicate signals | Human decisions are an atomic `pending → decided` update, so the first decision wins. Waits read state, not the event count. |
| Step retries | Per-step `retries` (default 3). Inngest function retries = max. A step at its limit throws `NonRetriableError`. A permanently failed step propagates as an exception that the process can `try/catch`. |
| Model / tool timeouts | Each step, agent and tool has a `timeout`, enforced with an `AbortSignal` plus a race. Agents have `maxIterations` and `maxToolCalls`. |
| Rate limits | Tools throw `RetryableToolError({ after })`, mapped to Inngest `RetryAfterError` (future); the AI Gateway handles provider failover. |
| Partial completion | Each destructive action is its own step, so the journal shows exactly which systems are done. Retrying the run resumes at the first incomplete step. |
| **Destructive action twice** | The **effect ledger**: `tool.started` is journaled (unique dedupeKey) *before* execution and `tool.completed` after. On re-entry: completed → return the stored result. Started but not completed → **outcome unknown**: call `tool.reconcile()` if defined, else fail the step non-retriably with "manual reconciliation required". It is never blindly re-executed. Tools also receive a stable `idempotencyKey` to forward to vendor APIs. |
| Deploy while waiting | Inngest keeps the wait. Resume runs the new code. Memoized steps hold, the version change is journaled, and the UI flags stale-version waiting runs. |
| Cancel | `status = cancelled` + `process/run.cancel` → Inngest `cancelOn`. Pending human requests are cancelled. Every step checks run status before executing. |
| Re-run a failed step | "Retry run" re-enqueues the same run: memoized steps return instantly and the failed step runs again. |
| Exactly-once? | Steps are **at-least-once with memoization**. Effects are **at-most-once for destructive tools** (ledger + reconcile) and **idempotent-at-least-once for write tools** (idempotency key). No vendor gives true exactly-once across third-party APIs; we make the gap visible and safe. |

---

## 7. Business events and waits

- `emitProcessEvent(workspaceId, name, data)`:
  1. starts the processes triggered by `name`;
  2. finds runs with `status = waiting, waitingOn.kind = event, waitingOn.event = name`
     whose `match` is a subset of `data`;
  3. journals `wait.matched` (dedupe per run and step) and signals each run.
- This routing is ours, so it works identically on any engine.

---

## 8. Approval and Human Task: one mechanism, two call sites

**Evaluated.**

- **(A) Separate primitives.** Clear call sites, but duplicated storage, inbox
  and resume logic.
- **(B) One generalized `ctx.human()`.** One concept, but every call site needs a
  discriminator, and the return type is a union.

**Chosen: one runtime mechanism (`HumanRequest`), two SDK methods.**

- `ctx.approval(title, { data, schema?, description?, assignees?, timeout? })` →
  `{ approved, outcome: approved|rejected|expired, data, comment, by, at }`.
  Data is editable only if `schema` is given; edits are validated, and the
  original stays in the request for audit.
- `ctx.task(title, { form: zodObject, description?, prefill?, assignees?, timeout? })`
  → `{ data, by, at }`.
- Same collection, same inbox, same resume path. The UI renders an approval as a
  data view with Approve / Reject (+ edit), and a task as a form generated from
  the JSON schema.

**Lifecycle.** `pending → approved | rejected | submitted | expired | cancelled`,
which is one-way and atomic. Who may respond: the listed `assignees`
(emails or user ids), else workspace owners and admins. Responses record user,
time, comment and the edited payload. Notifications (email/Slack via the existing
notification channels) come next. The inbox is visible in-app today.

---

## 9. Security

- **Least privilege.** Process tool envelope → agent subset → tool connection
  slots → workspace bindings. No process inherits Mako's credentials.
- **Effect classes are enforced at runtime.**
  - Agents default to `read`.
  - `allowEffects: ["write"]` is an opt-in on an agent call.
  - `destructive` inside agents is rejected.
  - Destructive calls run only in steps, behind the ledger. The DSAR reference
    puts them after an approval; a lint (future) can require that structurally.
- **RBAC.**
  - Members can view and start runs.
  - Admins can enable processes and set bindings.
  - Approvers are the assignees, else admins and owners.
  - Viewers can view only.
- **Audit.** The journal is append-only and records the version id. Human
  decisions are immutable records.
- **Workspace isolation.** Every query is scoped by `workspaceId`, and every
  event and request carries it.
- **Sandbox boundary (future).** Tools and agents that need a filesystem, browser
  or code execution get a `ctx.sandbox` / tool resource backed by the existing
  `SandboxProvider` (E2B). It would be ephemeral, with explicit network
  allowlists and only the secrets bound to the process injected. Nothing in the
  runtime assumes in-process execution of tool code.

---

## 10. Observability & UI

The **Processes** rail section (Build / Observe in one place):

- **Explorer:** an **Inbox** row with a pending count, then each process with its
  status dot (last run) and success rate.
- **Process tab:**
  - header: name, description, triggers, version, tool envelope with effect
    badges;
  - **vertical outline** derived from the code (trigger → each primitive call
    with a kind badge: agent / step / approval / task / wait);
  - "Run" with a JSON input editor;
  - runs table: #, status, waiting-on, started, duration, version.
- **Run tab:**
  - header: status, waiting-on, duration, cost, version (+ stale warning),
    Cancel / Retry;
  - **timeline**: one expandable row per step, with status, duration, attempts,
    input/output, logs, errors, artifacts, tools used, model and tokens;
  - an agent row expands to its **trace** (turns → assistant text → tool calls →
    tool results);
  - an inline approval card when the run is waiting on a human.
- **Inbox tab:** pending approvals and tasks across all processes, with
  approve / reject / edit / submit.

Costs: `agent.turn` usage is rolled up per step and per run (`run.usage`), with
cost from the gateway when it is reported.

---

## 11. Repository reuse

| Need | Reused |
|---|---|
| Engine | `api/src/inngest/client.ts`, registry `api/src/inngest/index.ts`, served at `/api/inngest` |
| Cron | `services/cron-due.ts` (`isCronDue`) |
| Models | `agent-lib/ai-gateway.ts` `getModel`, `ai-models.ts` `getDefaultModelId`, AI SDK `generateText` |
| DB tools | `databaseConnectionService.executeQuery` (read-only option) for `mako.sql.query` |
| Auth | `unifiedAuthMiddleware`, `workspaceService.hasAccess` / `getMember` |
| Routing / OpenAPI | `openapi/core.ts` `createRouter`, `OPEN_RESPONSES`; `pnpm openapi:sync` |
| Logging | `loggers.inngest()` / `loggers.api()` |
| Sandbox (future) | `apps/sandbox/provider.ts` `getSandboxProvider()` |
| UI | rail (`lib/explorer-nav.ts`), tab kinds (`store/lib/types.ts`, `tab-routing.ts`, breadcrumbs, `Editor.tsx`), Zustand + typed `api` client |

---

## 12. Where process code lives, now and next

- **v1: in the Mako repo,** `api/src/processes/library/*.ts`, registered in
  `library/index.ts`. Every workspace sees the library, and an admin enables the
  ones they use and binds their connections. This is what "a coding agent editing
  the Mako repo builds a workflow" needs.
- **Next: in the workspace repo** (`processes/<slug>.ts`, like `flows/`, apps and
  dbt), executed in the workspace sandbox by a thin worker that speaks the same
  `Driver` protocol over HTTP. This gives tenant-authored processes isolation and
  true version pinning (a version is a commit SHA). The runtime, journal, UI and
  tools model don't change. Only "where `run()` executes" does.

---

## 13. Vibe-code test (Phase 5): three workflows on the unchanged runtime

All three were written the way a newcomer would write them: read the SDK, copy
the DSAR file's shape. None needed a runtime change. One gap led to a small,
generic SDK addition.

| Process | Shape | Lines | What it exercised | Friction found |
|---|---|---|---|---|
| `churn-risk-review` | schedule → step (scan) → N parallel agents → step per CSM | ~110 | `trigger.schedule` with fixed input; `Promise.all` over `ctx.agent`; grouping in plain code | none |
| `lead-enrichment` | event/manual → step → N agents → **one editable approval over the batch** → step per lead (write tool) | ~85 | approval over a list, edited before write-back; write tools from steps | none |
| `competitor-watch` | schedule → N agents (web tools) → "what changed since last week?" → agent → artifact + email | ~100 | artifacts; agents with web tools | **needed the previous run's output.** Added `s.previousOutput()` (a read inside a step, so memoized). It is generic: any diff-against-last-time monitor needs it. |

Smaller observations, kept in mind but not changed:

- **Helpers are not part of a version.** Functions called by `run` but defined
  outside it (DSAR's `execute`) are not in the hash. The deploy SHA is
  recorded per version, and workspace-repo processes will hash the file.
- **Narrowing in callbacks.** TypeScript does not narrow `input.replyTo` inside
  a step callback (`as string`). A language papercut, not an SDK one.
- **Large fan-outs.** `Promise.all` over 500 accounts means 500 agent steps,
  which is fine. 2 000 would hit Inngest's 1 000-step limit. Next primitive
  candidate: start a child run (`ctx.step` + `startRun`, plus an event wait for
  its completion) as a documented pattern before considering an API.
- **One approval per item vs per batch.** Both work: per-item creates N inbox
  entries. Batch review with an editable table was the better UX for leads.

Outcome: the primitive set stayed at five. `ctx.parallel`, `ctx.map` and
`ctx.log` were never wanted.

## 14. Verification

- **`api/src/processes/processes.test.ts`** (21 tests; real Mongo, LocalEngine,
  scripted agents) covers:
  - DSAR end to end, including an approver edit that removes a record;
  - rejection;
  - outline extraction;
  - flaky-step retries;
  - PermanentError plus "retry run" resuming at the failed step without
    re-running memoized steps;
  - the ledger: an interrupted destructive call without `reconcile` fails
    closed, and with `reconcile` it is not repeated; a completed destructive
    call is returned from the ledger when its step retries;
  - task form validation;
  - durable sleep with a controlled clock;
  - event waits with `match`;
  - idempotent event triggers that start only when enabled;
  - cancel, which cancels the pending request and refuses late responses;
  - assignee authorization;
  - approval expiry;
  - a version change under a waiting run;
  - agent provisioning (destructive and out-of-envelope tools refused);
  - connection-slot binding;
  - the AI SDK harness against a mock model;
  - all three vibe-code processes;
  - the scheduler (once per tick, only when enabled).
- **`runtime/inngest-driver.test.ts`** pins the Inngest mapping: boxing,
  retry → NonRetriableError, check → waitForEvent → re-read.
- **Manual, against the real Inngest dev server (`inngest-cli dev`) plus the
  API on in-memory Mongo with scripted agents:**
  - a DSAR run paused on `waitForEvent` with nothing running;
  - the approval resumed it in about 4 s and it completed (`engine: inngest`);
  - cancelling a waiting run produced an Inngest run status of `CANCELLED`;
  - the signal-redelivery function ran and correctly did nothing;
  - no errors in the dev-server log.
- **Manual, in the app (Playwright):** the process list, process page (derived
  flow and tool envelope with effect badges), the inbox (plan rendered as a
  table, edit plus comment), the run timeline (PAUSED marker, agent trace,
  tool calls), the event log, and the completed run.

## 15. What v1 does not do (yet)


Webhook ingestion, notifications for approvals, `RetryAfter` mapping, child
runs/fan-out beyond ~200 steps, per-step "re-run this step only" (vs retry run),
realtime push (the UI polls), pinning, workspace-repo processes, sandbox
resource, quorum approvals, SLA/escalation, billing integration of process LLM usage
(`trackUsage` needs an invocation type and a payer), a UI for binding
connection slots (the API exists: `PATCH /processes/:id { bindings }`),
sidebar "reveal" for process tabs (the explorer is a flat list), and real
vendor tools for DSAR (Close, SendGrid, Zendesk) to replace the sample
systems.
