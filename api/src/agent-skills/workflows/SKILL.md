---
name: workflows
description: Load when writing, changing, testing, running or debugging a workflow — a scheduled or multi-step job written as a Hatchet TypeScript file in workflows/<name>/workflow.ts of the workspace repo — "run this every morning", "build a workflow that…", "why did the run fail".
entities:
  - workflows/
  - workflow.ts
  - hatchet
  - workflows_status
  - workflows_run
  - workflowId
  - preview run
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
`../lib/mako` (Mako data access) are supplied when it is built; do not create
them.

With `workflowId: "daily-digest"`, file paths are relative to that folder:
the file above is `path: "workflow.ts"`.

## The loop

Main is live: a merge to main is the deploy. So never write on main.

1. Switch to a branch: `app_bash` with `workflowId` and
   `git checkout -b workflow/<name>`. Skip if the checkout is already on a
   branch other than main.
2. Write `workflow.ts` with `app_write_file` / `app_edit_file` and
   `workflowId: "<name>"`. A new name creates the folder.
3. `app_commit` with the same `workflowId`. The commit is pushed, and the
   branch becomes the workspace's **preview**: the same code, registered next
   to the live one, with schedules off.
4. `workflows_status`. Wait until `preview.deploying` is false. If
   `preview.buildError` is set, read it, fix the file, commit again.
5. `workflows_run` with `preview: true` and an input.
6. `workflows_status` with the `runId`: each step's status, output, error and
   log lines. Fix and repeat from 2 until the run is `COMPLETED`.
7. `app_merge_to_main`. Then `workflows_status` until
   `deployment.liveSha` equals `deployment.targetSha`.

Tell the user before step 7: merging makes the workflow live and starts its
schedule.

There is one preview per workspace. If `preview.branch` is not your branch,
someone else's work is being previewed; committing replaces it.

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
- A step may run twice. Make writes safe to repeat.
- To log from a step use `ctx.logger.info("...")` (also `.warn`, `.error`).
  `console.log` does not reach the step's log lines.
- Only the packages of the workflow runtime can be imported:
  `@hatchet-dev/typescript-sdk`, `ai`, `@ai-sdk/mcp`, `zod`.
- Do not add an `index.ts`. Every folder with a `workflow.ts` is picked up.

## Reading Mako data in a step

```ts
import { query } from "../lib/mako";

const rows = await query("<connectionId>", "select id, name from customers limit 100");
```

Find the connection id and check the SQL first with `list_connections`,
`inspect_table` and `sql_execute_query`. Queries from a workflow are
read-only.

## When something is wrong

| You see | It means |
| --- | --- |
| `buildError` with `error TS…` | The commit does not typecheck. The previous code keeps running. Fix and commit. |
| `buildError` with `must default-export the workflow named …` | Folder name and `name` differ, or the export is not the default. |
| `deploying: true` for more than a minute | The worker is not running. Tell the user. |
| A run stays `QUEUED` | No worker has that workflow: its build failed, or (for `preview: true`) there is no preview. Check `workflows_status`. |
| Step `FAILED` | Read that step's `error` and `logs` in `workflows_status({ runId })`. |
