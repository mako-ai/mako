---
title: Workflows (preview)
description: Write scheduled and multi-step jobs as TypeScript files in your workspace repo. A commit on main deploys them, Hatchet runs them.
---

A workflow is a TypeScript file in your workspace repo, in the `workflows/` folder, written with [Hatchet](https://hatchet.run)'s own SDK. Commit it on `main` and it is deployed. Hatchet runs it: schedules, retries and timeouts are Hatchet's.

Three things, each one verb. **Sandbox**: Run → Sandbox (or `workflows_run` with `sandbox: true`) runs the workflow as it is in your sandbox right now, uncommitted edits included, with real data and no schedule, and shows the finished run. It runs inside your sandbox on a Hatchet engine of its own ([embedded mode](https://docs.hatchet.run/v1/embedded)), so nothing touches production and the run is in nobody's list. **Main**: a commit on `main` is the deploy. **Active**: a deployed workflow starts inactive, runnable with Run, schedule and webhook off; when a run looks right, an admin flips it to Active on its tab, and from then on it runs by itself. The same as testing and then activating an n8n workflow.

**Preview.** Workflows are optional: an installation without a Hatchet runs without them. With one, they have their own panel in Mako: the workflows, their files and their runs.

## A workflow

A workflow is a folder: `workflows/<name>/workflow.ts`. The folder name is the workflow's name.

```
workflows/
  daily-digest/
    workflow.ts
```

That file is all a workflow needs. `../hatchet` (the Hatchet client) and `../lib/mako` (Mako data access) are supplied when the workflow is built. Add your own `workflows/hatchet.ts` or `workflows/lib/mako.ts` only to replace them.

```ts
// workflows/daily-digest/workflow.ts
import { hatchet } from "../hatchet";

const dailyDigest = hatchet.workflow({
  name: "daily-digest", // same as the folder
  on: { cron: "0 7 * * 1-5" }, // weekdays at 07:00 UTC
});

dailyDigest.task({
  name: "build-digest",
  retries: 1,
  fn: async () => ({ date: new Date().toISOString().slice(0, 10) }),
});

export default dailyDigest;
```

Every folder with a `workflow.ts` is picked up. There is no list to keep.

## What starts a run

| Trigger  | How                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Schedule | `on: { cron: "0 7 * * 1-5" }` in the workflow, in UTC                                                  |
| Webhook  | **Add webhook** on a live workflow's tab gives a URL. A POST to it starts a run with the JSON as input |
| A person | The Run button, with a JSON input                                                                      |
| An agent | `workflows_run`                                                                                        |

Anyone with the member role writes workflows in their sandbox and tests them there; only workspace admins put them on `main`, activate them and add webhooks. A webhook is off until an admin adds it on the workflow's tab. Its URL carries its own secret, so treat it like a password; removing the webhook and adding it again gives a new URL. The schedule and the webhook start runs only while the workflow is active; Run always works. The webhook URL with `?sandbox=<your user id>` is a test URL: a POST to it runs your sandbox's version with the body as input and answers with the finished run, whether or not the workflow is active.

## Using Mako from a step

```ts
import { generateText } from "ai";
import { agent, call, model, query, queryPage } from "../lib/mako";

// SQL on a workspace connection: every row, with values exactly as the
// database returns them. Name the row type for typed rows.
const orders = await query<{ id: string; total: number }>(
  "<connectionId>",
  "select id, total from orders order by id",
);

// Writing needs the workflow on the connection's writers list (Access tab).
// rowCount is the number of rows the write changed.
const { rowCount } = await queryPage(
  "<connectionId>",
  "update mako_out.orders set flagged = true where total > 1000",
);

// Any Mako tool by name: here, rebuild an app's data.
await call("app_materialize", { appId: "<appId>", name: "orders_daily" });

// Mako's own agent, as in chat: a goal in, the answer out.
const { text, toolCalls } = await agent(
  "Which accounts stopped using the product this week, and why?",
);

// A plain model call, with Mako's tools if you pass them.
const summary = await generateText({
  model: model("anthropic/claude-haiku-4.5"),
  prompt: `Summarize in one line: ${text}`,
});
```

### Query results

`query()` returns every row of the result, fetched from Mako 500 rows at a time. Nothing is shortened: long text and JSON values come back whole, and no `LIMIT` is added. Add an `ORDER BY` so that the pages do not overlap or skip rows.

- `query(connection, sql, { database?, maxRows? })` returns all rows as an array.
- `queryPages(connection, sql, options?)` yields one page at a time (`for await`). Use it for results too big to keep in memory at once.
- `queryPage(connection, sql, { cursor?, ... })` makes one request and returns `{ rows, fields, rowCount, nextCursor? }`. Pass `nextCursor` back as `cursor` for the next page. For a write, `rowCount` is the number of rows changed.

A query passes the same checks as the agent's `sql_execute_query`: every workflow reads, and only the workflows on a connection's writers list write. A refused or failed query throws with the reason. Workflow code calls the route `POST /api/workflows/runtime/query` with the worker's key.

## How a deploy works

1. You commit a change to `workflows/` on `main`. Mako records the commit as the workspace's target, durably (an Inngest function, like app deploys), and checks every deployed workspace against `main` once an hour in case a push was missed.
2. Mako saves that commit as the one to run.
3. The worker notices within ten seconds, typechecks the commit and starts it.
4. Once the new code is up, the old code finishes its running tasks and stops.

If the commit does not typecheck, the worker reports the error and **keeps running the previous commit**. To roll back, revert the commit.

## Set it up

Mako needs two things: a Hatchet API token, and a worker.

### Try it locally

1. In `.env`, uncomment the workflows lines from `.env.example`. Set `WORKFLOWS_WORKER_KEY` to any value of your own that starts with `revops_`.
2. Start Hatchet and the worker:

   ```bash
   docker compose --profile workflows up -d
   ```

3. Ask the agent for a workflow, or add `workflows/<name>/workflow.ts` to the workspace repo on `main`.

Hatchet dashboard: `http://localhost:8086` (`admin@example.com` / `Admin123!!`). The link icon in the Workflows panel opens it. This bundled Hatchet is for testing, not for production.

### Production

1. Create an API token in [Hatchet Cloud](https://cloud.onhatchet.run), or in a Hatchet you run yourself.
2. Set `HATCHET_CLIENT_TOKEN` on the Mako API.
3. Choose a `WORKFLOWS_WORKER_KEY` (long, random, starting with `revops_`) and set it on the Mako API.
4. Build the worker image from the Mako repository and run it anywhere that can reach Mako and Hatchet:

   ```bash
   docker build -f deploy/workflows/runtime/Dockerfile -t mako-workflows-runtime .
   docker run -e MAKO_URL=https://your-mako -e MAKO_API_KEY=$WORKFLOWS_WORKER_KEY \
     mako-workflows-runtime
   ```

5. Turn workflows on for the workspace, as in step 3 above.

A worker run this way serves one workspace and has **no sandbox**: workflow code runs with the container's access. Use it for your own team's code.

## Settings

| Variable                                                           | Set on                                | What                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HATCHET_CLIENT_TOKEN`                                             | API                                   | One Hatchet tenant for the whole installation, so one workspace: the first to deploy keeps it, a second is refused. Multi-workspace installs set the admin variables below instead, and Mako makes a tenant per workspace |
| `HATCHET_DASHBOARD_URL`                                            | API                                   | Where Mako links admins to the Hatchet dashboard                                                                                                                                                                          |
| `WORKFLOWS_WORKER_KEY`                                             | API, and the worker as `MAKO_API_KEY` | The worker's Mako API key                                                                                                                                                                                                 |
| `MAKO_URL`, `MAKO_API_KEY`                                         | Worker                                | All the worker needs. It gets the Hatchet token from Mako.                                                                                                                                                                |
| `HATCHET_API_URL`, `HATCHET_ADMIN_EMAIL`, `HATCHET_ADMIN_PASSWORD` | API                                   | Only for a Hatchet you operate: lets Mako create a Hatchet tenant per workspace. Used by the local setup.                                                                                                                 |

With none of these set, Mako runs without workflows.

## API

All under `/api/workspaces/<workspaceId>/workflows`:

| Route                                  | Does                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                | What is deployed, build errors, the workflows (with `active`), schedules and recent runs                                                        |
| `GET /runs/<id>`                       | One run: its steps in order, with status, output, error and logs                                                                                |
| `GET /files`, `GET /files?path=<file>` | The files under `workflows/`, or one file's contents                                                                                            |
| `POST /<name>/run`                     | Start a run: `{ input }` answers `runId`; `{ input, sandbox: true }` runs the caller's checkout in their sandbox and answers the finished `run` |
| `PUT /<name>/triggers`                 | Change what starts it: `{ active }` (its schedule and webhook), `{ webhook }` (add: answers the new URL; remove). Admins                        |

Over MCP, an API key needs the `workflows:run` scope to start runs or add webhooks; looking needs only `mcp`.
