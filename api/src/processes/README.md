# Processes — authoring guide

A **Process** is a durable business process written as normal TypeScript. You
write `run(ctx, input)`. Mako provides triggers, durability, retries, human
approvals and tasks, waits, agent execution with traces, a tool audit trail,
versioning, permissions, and the run UI (Processes in the left rail).

Design and rationale: [`PROCESS_PLATFORM_DESIGN.md`](../../../PROCESS_PLATFORM_DESIGN.md).

## Create a process in 4 steps

1. Create `library/<id>.ts` and default-export `defineProcess({...})`.
2. Add it to the list in `library/index.ts`.
3. Reuse tools from `tools/` or add new ones (`defineTool`, see below).
4. Add a test case to `processes.test.ts`. Script the agents with
   `scripts.set("<step-slug>", async a => ...)` and drive it with
   `startRun` → `settle()` → `respondToHumanRequest`.

There is no step 5. The process shows up in the UI, and runs on Inngest in
deployed environments.

```ts
import { defineProcess, trigger, z } from "../sdk";
import { emailSend } from "../tools/mako";
import { sample } from "../tools/sample-systems";

export default defineProcess({
  id: "renewal-risk",                       // kebab-case, stable forever
  name: "Renewal risk check",
  description: "Investigate accounts renewing in 30 days and alert the owner.",
  triggers: [trigger.schedule("0 7 * * 1"), trigger.manual()],
  input: z.object({ days: z.number().default(30) }),
  tools: [sample.crmAccountList, sample.productUsageWeekly, emailSend], // envelope

  run: async (ctx, input) => {
    const accounts = await ctx.step("Load accounts", s =>
      s.call(sample.crmAccountList, {}),
    );

    const assessments = await Promise.all(
      accounts.accounts.map(a =>
        ctx.agent(`Assess ${a.name}`, {
          instructions: "Score renewal risk 0-100 and explain why.",
          prompt: a,
          tools: [sample.productUsageWeekly],     // read-only by default
          output: z.object({ risk: z.number(), why: z.string() }),
        }),
      ),
    );

    const ok = await ctx.approval("Send alerts?", { data: assessments });
    if (!ok.approved) return { sent: 0 };

    await ctx.step("Alert owners", s =>
      s.call(emailSend, { to: ["cs@example.com"], subject: "Renewal risk", text: "…" }),
    );
    return { sent: 1 };
  },
});
```

## The five primitives

| | Use for | Returns |
|---|---|---|
| `ctx.step(name, s => …, { retries?, timeout? })` | Deterministic code: queries, API calls, transforms. Memoized once it succeeds. | Your value (as JSON) |
| `ctx.agent(name, { instructions, prompt, tools?, output, model?, maxIterations?, allowEffects? })` | Judgement: investigate, plan, classify, write. A bounded tool loop with a typed result, shown as one timeline row with its trace behind it. | `z.infer<output>` |
| `ctx.approval(title, { data, schema?, description?, assignees?, timeout? })` | A person approves or rejects. With `schema`, they may edit `data`. | `{ approved, outcome, data, comment, by, at }` |
| `ctx.task(title, { form, description?, prefill?, assignees?, timeout? })` | A person fills in a form. | `{ data, by, at }` (throws `HumanRequestExpiredError` on timeout) |
| `ctx.wait(name, { for } \| { until } \| { event, match?, timeout? })` | A durable sleep, or waiting for a business event. Nothing runs while waiting. | `void`, or the event data (`null` on timeout) |

There are no `parallel` or `map` primitives. `Promise.all(items.map(i => ctx.step(\`… ${i.id}\`, …)))`
and `for` loops work as-is.

Inside a step, `s` gives you:

- `s.call(tool, input)`: an audited, ledgered tool call;
- `s.log(msg, data?)`;
- `s.artifact(name, text, { mimeType })`: files on the run, up to 1 MB;
- `s.previousOutput()`: the last completed run's output;
- `s.idempotencyKey`, `s.signal`, `s.attempt`.

## The three rules

1. **Side effects only inside primitives.** The `run` function is re-executed
   from the top on every resume, and completed primitives return their stored
   results. Code *between* primitives must be pure: no `Date.now()`, no
   `Math.random()`, no fetch, no DB writes. Put those in a `ctx.step`.
2. **The step name is the step's identity.** It must be unique per call. The
   same name in a loop is suffixed `#2`, `#3`, … in call order. If the order
   can change between executions, put an id in the name:
   `` `Enrich ${lead.id}` ``. Renaming a step in code means that step runs again
   for runs that are currently waiting.
3. **Return JSON, keep it small.** Results are serialized, so Dates become
   strings. Results are capped at 1 MB. Large outputs go in `s.artifact()`;
   return a summary.

## Tools

```ts
export const deleteContact = defineTool({
  name: "crm.contact.delete",            // dotted, stable: it is the audit name
  description: "Permanently delete a CRM contact by id.",  // written for a model
  effect: "destructive",                 // read | write | destructive
  connections: ["crm"],                  // slots this tool may resolve
  input: z.object({ contactId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  async execute({ contactId }, t) {
    const conn = await t.connection("crm");  // only declared + bound slots
    // ... call the vendor with t.idempotencyKey ...
    return { deleted: true };
  },
  async reconcile({ contactId }, t) {    // optional, destructive only
    return (await exists(contactId)) ? { done: false } : { done: true, output: { deleted: true } };
  },
});
```

- **`read`**: retried freely. Agents get read tools by default.
- **`write`**: must be idempotent (forward `t.idempotencyKey`). Agents only get
  write tools with `allowEffects: ["read", "write"]`.
- **`destructive`**: **never available to agents.** Call it from `ctx.step`,
  normally after `ctx.approval`. The effect ledger guarantees a destructive call
  never runs twice:
  - If a call was interrupted and its outcome is unknown, `reconcile` decides
    what happened.
  - Without `reconcile`, the step fails and asks for manual reconciliation.
  - Throw only when the effect did *not* happen.
- **Provisioning:**
  - A process can call only tools in its `tools` envelope.
  - An agent can call only the tools passed to that `ctx.agent()` call.
  - A tool can resolve only the connection slots it declares, and only if a
    workspace admin bound them on the process.

Available tools:

- `tools/mako.ts`: `mako.sql.query` (read-only SQL on the `warehouse` slot),
  `web.search`, `web.fetch`, `email.send`.
- `tools/sample-systems.ts`: an in-memory CRM, marketing, support, billing and
  product-analytics set, for demos and tests only.

## Triggers

- `trigger.manual()`: the UI, or `POST /api/workspaces/:ws/processes/:id/runs { input, idempotencyKey? }`
  with a workspace API key.
- `trigger.event("dsar.requested")`: `POST /api/workspaces/:ws/processes/events { name, data, idempotencyKey? }`,
  or `emitProcessEvent()` from server code. The same call wakes runs that are
  waiting in `ctx.wait({ event })`. The process must be **enabled**.
- `trigger.schedule("0 7 * * 1", { timezone?, input? })`: checked every 5
  minutes in deployed environments (schedulers are off in dev). The process
  must be **enabled**.

## Agents and harnesses

- **Default harness:** `aiSdkHarness()`. It uses the Vercel AI SDK via Mako's
  AI Gateway, makes one model call per iteration and requires a
  `submit_result` call validated against `output`.
- **Per call:** `ctx.agent(name, { harness })`.
- **Tests:** `scriptedHarness(async a => { await a.call("crm__contact__search", {...}); return {...}; })`.
  Model-facing tool names replace `.` with `__`.
- **Durability:** the trace is the checkpoint. If a worker dies mid-agent, the
  retry resumes from the recorded turns.

## Running locally

- **With Inngest:** `pnpm dev`. Runs execute on Inngest and are visible in the
  Inngest dev UI.
- **Without Inngest:** set `PROCESS_ENGINE=local` and runs execute in the API
  process. Timers are not durable in this mode.

To watch a run, open **Processes** in the left rail and pick the run.
**Inbox** lists everything waiting for a person.

## Debugging a run

- **Event log view:** the raw journal (`process_events`), in order.
- **Failed run:** "Retry from failed step" re-queues the same run. Everything
  that completed is reused from the journal.
- **Agent row:** shows instructions, input, every turn (text, tool calls with
  inputs and outputs), tokens and model.
- **Versions:** every run records the version it started on, and every event
  the version that wrote it. A waiting run that resumes on new code journals
  `run.version_changed`.
