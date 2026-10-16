---
name: workflows
description: Load when writing, changing, testing, running or debugging a workflow — a scheduled or multi-step job written as a Hatchet TypeScript file in workflows/<name>/workflow.ts of the workspace repo — "run this every morning", "build a workflow that…", "test it in the sandbox", "why did the run fail".
entities:
  - workflows/
  - workflow.ts
  - hatchet
  - workflows_status
  - workflows_run
  - workflowId
  - activate
  - sandbox
  - cron
  - schedule
  - scheduled job
  - background job
  - build error
---

# Workflows

A workflow is a folder in the workspace repo. Hatchet runs it: schedules,
retries and timeouts are Hatchet's.

```
workflows/
  daily-digest/
    workflow.ts         the workflow named "daily-digest"
```

That one file is all a workflow needs. `../hatchet` (the Hatchet client) and
`../lib/mako` (Mako data access) are supplied when it is built: do not create
them, and they are not in the repo to read. `../lib/mako` exports `query`
(with `queryPage` and `queryPages`), `call`, `agent`, `model`, `decide` and
`tools`, each shown below.

With `workflowId: "daily-digest"`, file paths are relative to that folder:
the file above is `path: "workflow.ts"`.

## The loop

Three things, each one verb. **Sandbox**: `workflows_run` with
`sandbox: true` runs the workflow as it is in your checkout right now,
uncommitted edits included, inside your sandbox, with real data and no
schedule, and returns the finished run. **Main**: a commit on main is the
deploy. **Active**: a deployed workflow starts inactive (schedule and webhook
off, Run works); an admin switches it on. Like n8n: test, then activate.

1. Write `workflow.ts` with `workflow_write_file` / `workflow_edit_file` and
   `workflowId: "<name>"`. A new name creates the folder. No commit yet.
2. `workflows_run` with `sandbox: true` and an input. The answer is the run:
   each step's status, output, error and log lines, or the type errors if
   the file does not build. About ten seconds plus the workflow's own time.
3. Fix and repeat from 1 until the run is `COMPLETED`.
4. `workflow_commit`. On main that is the deploy; `workflows_status` until
   `deployment.liveSha` is your commit (`deployment.buildError` says why
   not; the previous version keeps running meanwhile). A member commits to
   a branch and asks an admin to merge: only admins put workflows on main.
5. Ask the user, then `workflows_triggers` with `active: true`: from then on its schedule and
   webhook start runs by themselves.

A sandbox run is real: `query` reads real data, and `call` and `agent` act
as you. Its engine is the sandbox's own, so the run is not in the
workspace's list and a schedule never fires there.

Changing an active workflow: the same loop; test in the sandbox, and say
before committing that the new commit is live as soon as it builds.

Nothing is committed until `workflow_commit`, at the end of a turn either: an
attempt you give up on is deleted from the checkout (`rm -rf` its folder with
`workflow_bash` on another workflow) and was never deployed. A workflow
already on main is removed by deleting its folder and committing that.

## A workflow file

```ts
// workflows/daily-digest/workflow.ts
import { hatchet } from "../hatchet";

type Input = { limit?: number };

const dailyDigest = hatchet.workflow<Input>({
  name: "daily-digest", // must equal the folder name
  on: { cron: "0 7 * * 1-5" }, // optional schedule, UTC
});

const load = dailyDigest.task({
  name: "load",
  retries: 2,
  executionTimeout: "5m",
  fn: async input => ({ rows: [], limit: input.limit ?? 100 }),
});

dailyDigest.task({
  name: "summarize",
  parents: [load],
  retries: 1,
  fn: async (_input, ctx) => {
    const { rows } = await ctx.parentOutput(load);
    return { count: rows.length };
  },
});

export default dailyDigest;
```

Rules:

- `name` equals the folder name, and the workflow is the **default export**.
  Otherwise the build fails.
- A step returns a JSON object. A later step reads it with
  `await ctx.parentOutput(step)`.
- Give every step `retries: 1` or more: a step interrupted by a deploy or a
  crash is retried, and a step with no retries left fails the run.
- A scheduled run has no input: read it as `input?.name ?? "default"`, or
  the first cron run fails on `null`.
- A step may run twice. Make writes safe to repeat.
- To log from a step use `ctx.logger.info("...")` (also `.warn`, `.error`).
  `console.log` does not reach the step's log lines.
- Only the packages of the workflow runtime can be imported:
  `@hatchet-dev/typescript-sdk`, `ai`, `@ai-sdk/mcp`, `zod`.
- Do not add an `index.ts`. Every folder with a `workflow.ts` is picked up.

## Reading Mako data in a step

```ts
import { query } from "../lib/mako";

const rows = await query<{ id: string; name: string }>(
  "<connectionId>",
  "select id, name from customers order by id",
);
```

`query` returns every row, exactly as the database returns it: no cell is
shortened and no `LIMIT` is added. Mako sends it 500 rows at a time and
`query` fetches all pages, so add `ORDER BY` and filter in SQL. For a result
too big to hold at once, read it a page at a time:

```ts
import { queryPages } from "../lib/mako";

for await (const page of queryPages("<connectionId>", sql)) {
  // page.rows: up to 500 rows (maxRows: 1 to 500)
}
```

Do not use `call("sql_execute_query", ...)` for data: it answers with a
table for a model to read, cut to a few rows. A refused or failed query
throws. Find the connection id and check the SQL first with
`list_connections`, `inspect_table` and `sql_execute_query`.

A workflow reads every connection. It writes (INSERT, UPDATE, MERGE, CREATE,
DROP) only through a connection whose Access tab lists that workflow, either
anywhere or only in one schema or table. An admin adds it there; the agent
cannot. Before building a workflow that writes, tell the user which
connection and which `schema.table` to allow it on. Name the target fully in
the statement (`INSERT INTO mako_out.labels ...`): a workflow allowed only
one place must say where it writes, in one statement. A write runs once;
`queryPage(connection, sql)` returns its `rowCount`, the rows it changed. A
sandbox run writes as the person running it, under their own access. A dbt
job (`call("dbt_run_job", { ... })`) remains the way to rebuild models.

## Calling a Mako tool in a step

Any Mako tool can be called by name with `call`. To refresh an app's data on
a schedule, rebuild its bindings:

```ts
import { call } from "../lib/mako";

await call("app_materialize", { appId: "<appId>", name: "<binding>" });
```

## Thinking in a step

Two ways. Both count in the workspace's usage, like a chat turn.

**Mako's agent**, for a job that needs judgement: the same agent as in chat,
with its skills and tools. A goal in, the answer out.

```ts
import { agent } from "../lib/mako";

const { text, toolCalls } = await agent(
  "Which accounts stopped using the product this week, and why?",
);
ctx.logger.info(`used: ${toolCalls.join(", ")}`);
```

Write the goal as you would brief a colleague: what to find, where, and what
to answer with. It acts as the person who set workflows up: its SQL is
read-only, like `query`, and it can change things in Mako (consoles, apps),
so say so when it should only read.

**A plain model call**, for one small judgement on data you already hold
(classify, summarize, extract). No tools unless you pass some.

```ts
import { generateText } from "ai";
import { model } from "../lib/mako";

const { text } = await generateText({
  model: model("anthropic/claude-haiku-4.5"),
  prompt: `Summarize in one line: ${notes}`,
});
```

When code reads the answer (a label, a score, fields), ask for a typed one
instead of parsing text. An answer that does not fit the schema throws, and
the step's retry asks again.

```ts
import { generateText, Output } from "ai";
import { z } from "zod";
import { model } from "../lib/mako";

const Label = z.object({
  category: z.enum(["bug", "billing", "feature", "other"]),
  confidence: z.number().min(0).max(1),
});

const { output } = await generateText({
  model: model("anthropic/claude-haiku-4.5"),
  output: Output.object({ schema: Label }),
  prompt: `Classify this conversation:\n${text}`,
});
// output.category is "bug" | "billing" | "feature" | "other"
```

Use `generateText`, not `streamText`. Use plain `call` or `query` when no
judgement is needed.

**A decision model** (e.g. TypeSafe's Jev, `typesafe-ai/jev`) answers fixed
questions about a JSON state instead of writing text. `decide` sends the
state and the questions as the model expects them and returns its
`answers` (and `providerMetadata`, where Jev puts its confidence); it is
counted in usage like `model`.

```ts
import { decide } from "../lib/mako";

const { answers } = await decide(
  "typesafe-ai/jev",
  { conversation },
  questions,
);
```

### Models

- **Reasoning models** (GLM, DeepSeek, MiMo, …) spend hidden reasoning
  against `maxOutputTokens`. At 2000 the longest inputs come back empty
  ("No output generated") or cut off; give them about 6000.
- **Some models ignore the schema's shape**: issues as bare strings,
  numbers as text, enums as free text. Put an example of the expected
  answer in the prompt, and normalise the answer after the call.
- **Open-weight models**: pin the hosts so data stays off the makers' own
  APIs, e.g. `providerOptions: { gateway: { only: ["deepinfra", "novita"] } }`.
- **Decision models** (Jev) are called with `decide()`, not `model()`.

```ts
const { output } = await generateText({
  model: model("zai/glm-4.6"),
  maxOutputTokens: 6000,
  providerOptions: { gateway: { only: ["deepinfra", "novita"] } }, // not "zai"
  output: Output.object({ schema: Label }),
  prompt: `Classify this conversation. Answer like:
{"category":"billing","confidence":0.8}

${text}`,
});
```

## What starts a run

- A schedule: `on: { cron: "0 6 * * *" }` in the workflow (UTC).
- A webhook: an admin adds it, with `workflows_triggers` (`webhook: true`) or on the workflow's
  tab. That gives a URL; a POST to it starts a run with the JSON body as
  input. Nothing to write in the code. Give the user the URL and tell them
  it is a secret.
- A person (Run) or you (`workflows_run`), on main or in a sandbox.

The schedule and the webhook work only while the workflow is **active**
(`workflows_triggers` with `active: true`, or the switch on its tab). Run and `workflows_run`
always work. The webhook URL with `?sandbox=<userId>` is a test URL: a POST
to it runs that person's sandbox version with the body as input and answers
with the finished run, whether or not the workflow is active.

## Hatchet's own documentation

For anything Hatchet does that is not shown here (child workflows, DAGs,
concurrency, rate limits, durable sleep), read its docs before guessing: fetch
`https://docs.hatchet.run/llms.txt` for the index, then the page you need as
markdown (`https://docs.hatchet.run/llms/<section>/<page>.md`).

## When something is wrong

| You see                                                          | It means                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `buildError` with `error TS…`                                    | The commit does not typecheck. The previous code keeps running. Fix and commit. |
| `buildError` with `must default-export the workflow named …`     | Folder name and `name` differ, or the export is not the default.                |
| `liveSha` is not `targetSha` after a minute, and no `buildError` | The worker is not running. Tell the user.                                       |
| A run stays `QUEUED`                                             | No worker has that workflow: its build failed. Check `workflows_status`.        |
| A sandbox run answers with type errors                           | Your checkout does not typecheck. Fix the file and run again.                   |
| The schedule did not fire                                        | The workflow is not active. `workflows_status` shows `active` per workflow.     |
| Step `FAILED`                                                    | Read that step's `error` and `logs` in `workflows_status({ runId })`.           |
