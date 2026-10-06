# Pipory (and friends) — research note

Internal note feeding [`PROCESS_PLATFORM_DESIGN.md`](./PROCESS_PLATFORM_DESIGN.md).
Written 2026-10-06.

**What this is based on.** Pipory's whole public docs site (every concepts and
features page, the generated node reference, the guides and the blog), read in
full. Its homepage, rendered in headless Chromium: the interactive editor demo,
the live-run rows and the assistant "Apply / Dismiss" mock. The app's sidebar
shell, which leaks into the raw HTML of `/templates`.

**What it is not based on.** The logged-in product. `/executions`, `/tasks`,
`/templates/*` and the editor all redirect to a Clerk "Continue with Google"
sign-in. This research ran in a cloud container with no access to the user's
browser, and we did not create an account. Every statement below about runtime
internals is therefore either **stated** in their docs or **inferred** (marked).
If someone with an account clicks through Executions → a run → a paused
Approval, they can confirm the inferred points in about 10 minutes.

The docs contradict themselves in places, a sign of a fast-moving and partly
AI-written docs site:

- "203 / 226 / 229 node types"
- "37 templates" vs "eight seed templates"
- "assistant can't edit yet" vs "Build/edit mode shipped"
- "no workspace model" vs full RBAC

Product status: early access, free, content dated June–July 2026.

---

## Pipory

### 1. Core abstractions

| Object | Notes |
|---|---|
| **Workflow** | A React Flow graph of nodes and edges, with exactly one trigger node |
| **Node** | `{ type, config, credentialIds, variableName }` |
| **Edge** | Connects an output handle to an input handle. Handles include true/false, loop/done, approved/rejected and error |
| **Execution** | One run of a workflow. "Built on Inngest" |
| **Credential** | Typed and encrypted; per user, moving to per workspace |
| **Variables** (`{{vars.X}}`), **Data Tables** | Workspace data |
| **Interface** | A hosted form at `/i/<token>`, bound to a published workflow |
| **Template** | A workflow in export format |
| **Custom App** | A user-defined integration, optionally imported from an OpenAPI spec |
| **Tasks inbox** | Where Human Task nodes land |
| **Workspace** | Roles VIEWER / EDITOR / ADMIN / OWNER, plus an audit log |
| **Tests** | Saved trigger payloads with assertions |

App sidebar IA: **Build** (Workflows, Templates, Interfaces), **Data** (Tables,
Variables, Credentials), **Observe** (Executions, Tasks), plus "Ask AI".

### 2. Workflow model

The graph is the program. The engine "walks the graph in topological order",
threading a single accumulating **run context**:

- The trigger seeds a namespaced key (`webhook`, `form`, `stripe`, …).
- Each node adds `context[variableName]`.
- Config fields are Handlebars templates (91 helpers) over that context. "Nothing
  throws": a broken expression becomes an empty string.

Untaken branches are rendered as **skipped**, not hidden.

There is a draft graph and a published (live) version. Interfaces and the chat
trigger require at least one publish.

### 3. Node types

Roughly 200 nodes:

- **Triggers (37):** manual, webhook, schedule, form, chat, Stripe, polling
  triggers for about 20 SaaS products and databases, and "on workflow failure".
- **Core actions:** HTTP, Code (Node `vm` / Pyodide with no network, filesystem
  or modules), Email, Slack, MCP Tool, AI Agent, AI Transform, Structured Output
  (JSON-Schema validation with optional one-shot LLM repair), and the
  OpenAI / Anthropic / Gemini nodes.
- **Flow control:** Branch (optionally an **AI condition**), Switch, Loop
  (capped at 100), Sub-Workflow, Stop, **Approval**, **Human Task**, Delay.
- **Data utilities:** Set, Merge, Filter, Sort, Dedupe, …
- **App "mega-nodes":** Stripe 150 operations, Close 163, HubSpot 68, Shopify
  119.

### 4. Agent execution model

The **AI Agent node** is a Claude-only tool loop on the user's own Anthropic key.
It defaults to 5 iterations, with a hard cap of 10.

- Its tools are **opt-in toggles**, and only two are documented: an HTTP tool
  and "read the run context".
- It streams live status on the canvas like any other node.
- **Not documented:** memory, sub-agents, model choice, how iterations map to
  Inngest steps, and per-iteration checkpointing. Inferred: the whole loop runs
  inside one node, so probably one `step.run`.

There is a separate **editor assistant** with three modes: Understand, Build/edit
(typed graph mutations, previewed, applied by clicking Apply) and Debug (reads
the last execution and proposes a patch).

- "Agent mode" auto-applies mutations within a per-session budget (default 6,
  server maximum 20).
- AI governance: a workspace AI on/off toggle and daily caps.

### 5. Tool model

There is no first-class tool abstraction. "Tools" are:

- the agent's two built-in toggles;
- the **MCP Tool node**, which calls one tool on an external MCP server
  (bearer-token auth);
- app nodes, which are operations, not agent tools. You cannot hand the agent an
  app node.

Inbound, Pipory is itself an MCP server: every webhook-enabled workflow is one
tool. There is also a REST API to list and trigger workflows and to read
executions.

Permissions are workspace roles. Nothing marks a node as "destructive".

### 6. Trigger model

One trigger per workflow:

- **Manual:** sample payload, or "run with inputs".
- **Webhook:** per-workflow secret header.
- **Schedule:** cron plus timezone. "A single minutely Inngest cron checks every
  workflow's due schedules and fans out" (stated).
- **Form, chat, polling and native event triggers:** registered on publish.
- **On workflow failure.**

Two pieces of trigger plumbing worth copying:

- **Trigger filters**, evaluated before an execution exists. A non-match returns
  `200 {filtered:true}`.
- **Trigger History**, which lists every inbound event (started / filtered /
  queued / dropped) with **Replay** and **Test against draft**.

**Queue policy** is set per trigger:

- parallel with a maximum concurrency, or ordered (one at a time);
- a backlog limit with an overflow policy: queue, 429, or drop.

### 7. Human approval model

The **Approval node** takes a message and a channel (email or Slack). It sends
**signed approve/reject links** and routes to the `approved` / `rejected`
handles. An optional timeout **auto-rejects**. The run is "durably paused" while
it waits (stated). Inferred: Inngest `waitForEvent`.

There is no structured payload editing, no assignee model and no quorum.

### 8. Human task model

The **Human Task node** creates an item in the **Tasks inbox**: "fill a form or
confirm an action". On submit the run resumes with `{{humanTask.values.*}}`.

Assignment, SLA, timeout and escalation are not documented. Test runs that hit
an Approval or Human Task node time out after 90 seconds.

**Takeaway:** Approval and Human Task are two node types over the same pause
mechanism. Approval is a Human Task whose form is a fixed yes/no and whose
output feeds a branch.

### 9. Run model

One execution per trigger event. Statuses are `RUNNING / success / failed /
cancelled`, plus per-node `skipped`.

- **A durable wait keeps the status RUNNING.** That is a weakness: a run waiting
  for approval looks the same as a running one.
- Cancel is immediate.
- Per-workflow concurrency caps queue the excess runs.
- Sub-workflows can be fire-and-forget or wait. The wait **polls** the child for
  up to 1 minute.
- The Webhook Response node holds the HTTP request open for up to 10 seconds,
  then returns 202 with the execution id.

### 10. State / checkpoints

State is the accumulating context. Per-node input and output are persisted in
Pipory's own execution log.

**Re-run from node** reuses that node's recorded input from the original run, so
upstream side effects are not repeated. Inferred: this is Pipory's own log acting
as a checkpoint, not Inngest replay, because Inngest memoization is scoped to one
Inngest run.

There is no explicit checkpoint API.

### 11. Retry / failure

- Per-node retries, capped at 5, with backoff defaulting to 1 second. Inferred to
  be Pipory's own loop rather than Inngest step retries.
- The **error edge** catches a failure that survives all retries and exposes
  `{{error}}`.
- **Stop** ends the run with a chosen outcome.
- Fail-soft expressions and AI conditions (a failed judgement routes down the
  false branch).
- Failure alerts go to email or Slack, plus the on-failure trigger.
- Recovery: **re-run** (same payload), **re-run from node**, and **replay** from
  trigger history.

### 12. Observability

- Live per-node status on the canvas (running / done / failed / skipped).
- A global executions list.
- A per-workflow run dashboard: total runs, success rate, p50 and p95 duration,
  last failure, over 7 or 30 days.
- Trigger history, including filtered and dropped events.
- An audit log, retained 90 days.

### 13. Logs / tracing

The execution timeline is "a real row you can open, not a log file". Each row
shows type, node id, duration, status, input and output JSON, and the **error
with its stack trace attached to the node**.

There is no documented OpenTelemetry export, token or cost accounting, or agent
transcript view.

### 14. Testing / debugging

- **Pin / mock node output.** The pin is prefilled from the last real output and
  honoured only on manual runs.
- **Workflow tests:** a named trigger payload plus assertions on a final-context
  path (`equals / contains / exists / matches`). Tests run against the draft and
  are excluded from stats.
- Expression autocomplete from real upstream outputs.
- The AI Debug assistant.

### 15. Versioning / deployment

- Draft vs published, with native webhooks registered on publish.
- The last 50 versions are kept, with restore.
- Export to `<name>.pipory.json`: nodes, edges, a format version, and credential
  ids stripped down to type placeholders. Templates use the same round trip.
- There is no git integration, no environments and no promotion.
- **Not documented:** which version an in-flight paused run resumes on. Inferred:
  a run carries its graph snapshot or a version id, because the interpreter needs
  the graph it started with.

### 16. UI patterns worth copying

1. **Status on every step**, including **skipped** for untaken paths.
2. **Execution timeline as expandable rows:** type badge, name, duration, status
   pill. Input, output and error sit inline on the row that failed.
3. **Re-run from a step**, using recorded inputs.
4. **Trigger history with replay**, including events that never became runs.
5. **Assistant proposes typed changes; a human clicks Apply.** For us the
   equivalent is the coding agent writing the code.
6. **Run rollups** per workflow (success rate, p50 / p95, last failure).
7. **Tasks inbox** as a top-level "Observe" destination.
8. **Pin output from the last real run** for testing.
9. **Build / Data / Observe** information architecture.

### 17. Things we should NOT copy

- **The graph as the programming model.** Handlebars over an accumulating context
  is exactly what makes n8n-style tools painful past about 15 nodes. The context
  is untyped, there are no unit tests and there are no real loops or functions.
- **Fail-soft everything:** empty-string expressions, and AI conditions that fail
  to `false`. In a DSAR, silent mis-routing is a compliance incident.
- **Waiting runs reported as `RUNNING`.**
- **Mega app nodes** with 150 operations. They are broad, shallow and impossible
  to permission per operation.
- **No effect classification:** a delete is the same kind of node as a read.
- **Arbitrary low caps** (loop 100, agent 10 iterations, sub-workflow wait 1
  minute) as a substitute for durable design.
- **Sub-workflows that wait by polling** instead of an event.
- **A single-vendor agent** tied to a per-user API key.

### 18. What Pipory relies on Inngest for

| | Status |
|---|---|
| Durable execution engine | stated |
| Durable delay (`step.sleep` / `step.sleepUntil`) | stated |
| The minutely cron that fans out due schedules | stated |
| Runs started by Inngest events (the API accepts "the trigger's event id" before the execution row exists) | inferred |
| Per-node `step.run` memoization | inferred |
| `waitForEvent` for Approval and Human Task | inferred |
| Concurrency and cancellation | inferred |

### 19. What Pipory adds on top of Inngest

Inngest handles "durable function with steps". Pipory adds:

- an interpreter for JSON graphs (cf. Inngest Workflow Kit) with its own
  expression language;
- the node catalog and generated docs;
- encrypted credentials, OAuth and Custom Apps;
- **its own execution log store** (I/O, errors, durations, stats) — the run UI
  reads this, not Inngest;
- re-run, re-run-from-node, pin and tests;
- trigger ingestion: secrets, filters, queue policies, history and replay;
- human-in-the-loop UX: signed links and the Tasks inbox;
- the AI nodes and the editor assistant with governance;
- MCP and REST;
- RBAC, audit and versions.

**Key insight for Mako:** even a product "built on Inngest" keeps its *own*
durable log of what each step did. That log powers the UI, re-run-from-step and
audit. Inngest provides scheduling, waking, retries and memoization *within one
Inngest run*.

---

## The other systems (brief)

### n8n

- **Model:** a visual graph is the program. Execution data is stored in the DB.
  The **Wait** node handles webhook, form or time waits. n8n 2.0 made
  sub-workflows with waits return to their parent.
- **AI:** the LangChain **AI Agent** node can require approval of tool calls.
- **Scaling and durability:** queue mode (Redis plus workers). There is no step
  memoization in code, and retries are per node.
- **License:** "Sustainable Use License" (fair-code), so it cannot be embedded in
  a SaaS.
- **Lesson:** good for glue, but cumbersome as soon as logic is real. This is the
  thing we are replacing.

### Inngest (the TS SDK v4 that Mako already runs)

- **Durability:** event-triggered functions. `step.run` results are memoized by
  **step ID**, and the handler is re-executed from the top on each step. v4
  checkpoints eagerly by default.
- **Steps:** `step.run`, `step.sleep` / `step.sleepUntil` (up to 1 year),
  `step.waitForEvent({event, if|match, timeout})` (returns `null` on timeout),
  `step.invoke`, `step.sendEvent`, `step.ai.infer` / `step.ai.wrap`,
  `step.realtime.publish`.
- **Function config:** `retries` (0–20, applied per step), `concurrency`
  (keyed), `throttle`, `rateLimit`, `debounce`, `priority`, `idempotency`
  (24-hour window), `cancelOn`, `onFailure`, `timeouts`.
- **Errors:** `NonRetriableError`, `RetryAfterError`, and `StepError` (catchable
  in the handler).
- **Versioning:** new step IDs run, previously seen IDs return memoized results,
  and there is no non-determinism error. For incompatible changes you create a
  new function ID.
- **Limits:**
  - 1000 steps per run
  - 4 MiB per step output
  - **32 MiB total run state**
  - steps up to about 2 hours
  - maximum run duration by plan: 30, 90 or 366 days
- **Gotcha:** `waitForEvent` does **not** see events sent before the wait was
  registered. There is no lookback.
- **Self-host and license:** `inngest start` (SQLite, or Postgres plus Redis).
  The server is SSPL with delayed Apache-2.0 release; the SDKs are Apache-2.0.
- **AgentKit:** model calls through `step.ai`, approvals through
  `waitForEvent`.

### Hatchet

- **Engine:** Postgres-only, with long-lived gRPC workers. MIT.
- **Model:** DAG workflows, plus **durable tasks** (`ctx.sleepFor`,
  `ctx.waitFor`, `ctx.waitForEvent` with a **lookbackWindow**).
- **Durability** is an event log that checkpoints at waits and child spawns.
  Code in between must be deterministic, and side effects go into child tasks.
  There is no `step.run`-style memoization of arbitrary code.
- **Flow control:** strong fairness and rate-limiting (round-robin by key, slot
  cost, tenant-scoped concurrency).
- **AI:** "orchestration for AI agents". Workflows can be exposed as MCP tools.
- **Lesson:** a good engine, but it needs a new Postgres, a new worker fleet and
  a second ops surface.

### Trigger.dev (v4)

- **Model:** plain async tasks in containers. Durability through **CRIU
  snapshot/restore** at waits, so there is no replay and no determinism rules.
- **Human-in-the-loop:** `wait.createToken()` gives a URL and token, and
  `wait.forToken()` resumes the task.
- **Versioning:** runs are **pinned to the deploy version they started on**. This
  is the cleanest versioning story.
- **Self-hosting:** Apache-2.0, but heavy (Docker or K8s plus a supervisor).
- **Lesson:** version pinning plus waitpoint tokens are the gold-standard UX.
  Pinning needs immutable deployed bundles, which we can get later from
  sandbox-executed processes.

### Windmill

- **Two models:** visual flows (each step is a job whose result lives in
  Postgres), and **workflows-as-code** (`task()`, `step()`, `sleep()`,
  `waitForApproval()` with replay over cached results).
- **Approval steps:** resume URLs, approval counts, forms, timeouts, "continue on
  disapproval", group restrictions, Slack and Teams.
- **License:** AGPL core plus proprietary EE. It is a platform, not a library.
- **Lesson:** its approval step is the most complete one we saw. Copy: forms,
  required approvers, timeout behaviour.

### Reference points

- **Temporal:** the correctness gold standard. Event-sourced history, strict
  replay, signals and updates for human-in-the-loop, `patched()` plus
  worker-versioning pinning. Heavy and verbose.
- **Vercel Workflow** (`"use workflow"` / `"use step"`): event-log replay in a
  deterministic sandbox, hooks for approvals, `DurableAgent` on the AI SDK, and
  pluggable "Worlds" (backends). This is close to the shape we want, and evidence
  that "code with step primitives" is the convergent design.

---

## What this means for Mako (summary; the details are in the design doc)

1. **Code is the program, and steps are the unit of observability.** Every modern
   engine (Inngest, Trigger.dev, Hatchet durable tasks, Windmill WAC, Vercel
   Workflow, Temporal) converged on this. Only the graph tools didn't.
2. **Keep our own run journal**, as Pipory does. The engine's memoized state is
   not an audit log, is size-limited (32 MiB), and is scoped to one engine run.
   Our journal drives the UI, audit, re-run-from-failure and approvals.
3. **Approval and Human Task are one mechanism** (a durable human request) with
   two ergonomic call sites.
4. **Waiting is not running.** Give `waiting` its own status, plus *what* the
   run is waiting on.
5. **Classify tool effects** (read / write / destructive). Nobody we looked at
   does this well, and it is the thing that makes agentic DSAR safe.
6. **Inngest is the right first engine for Mako.** It is already deployed, its
   step-ID memoization tolerates code changes under sleeping runs, and
   `waitForEvent` fits approvals. Its lookback gap and size limits have to be
   designed around.
