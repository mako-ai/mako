---
title: Workflows (preview)
description: Write scheduled and multi-step jobs as TypeScript files in your workspace repo. A merge to main deploys them, Hatchet runs them.
---

A workflow is a TypeScript file in your workspace repo, in the `workflows/` folder, written with [Hatchet](https://hatchet.run)'s own SDK. Merge to `main` and it is deployed. Hatchet runs it: schedules, retries and timeouts are Hatchet's.

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

A webhook is off until someone adds it on the workflow's tab. Its URL carries its own secret, so treat it like a password; removing the webhook and adding it again gives a new URL. A preview has no schedule and no webhook.

## Using Mako from a step

```ts
import { generateText } from "ai";
import { agent, call, model, query } from "../lib/mako";

// SQL on a workspace connection (read-only).
const rows = await query("<connectionId>", "select count(*) from orders");

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

## How a deploy works

1. You merge a change to `workflows/` into `main`.
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

3. Ask the agent for a workflow, or add `workflows/<name>/workflow.ts` to the workspace repo and merge to `main`.

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

| Variable                                                           | Set on                                | What                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `HATCHET_CLIENT_TOKEN`                                             | API                                   | The Hatchet token for the installation                                                                    |
| `HATCHET_DASHBOARD_URL`                                            | API                                   | Where Mako links admins to the Hatchet dashboard                                                          |
| `WORKFLOWS_WORKER_KEY`                                             | API, and the worker as `MAKO_API_KEY` | The worker's Mako API key                                                                                 |
| `MAKO_URL`, `MAKO_API_KEY`                                         | Worker                                | All the worker needs. It gets the Hatchet token from Mako.                                                |
| `HATCHET_API_URL`, `HATCHET_ADMIN_EMAIL`, `HATCHET_ADMIN_PASSWORD` | API                                   | Only for a Hatchet you operate: lets Mako create a Hatchet tenant per workspace. Used by the local setup. |

With none of these set, Mako runs without workflows.

## API

All under `/api/workspaces/<workspaceId>/workflows`:

| Route                                  | Does                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /`                                | What is deployed (live and preview), build errors, the workflows, schedules and recent runs |
| `GET /runs/<id>`                       | One run: its steps in order, with status, output, error and logs                            |
| `GET /files`, `GET /files?path=<file>` | The files under `workflows/`, or one file's contents                                        |
| `POST /<name>/run`                     | Start a run: `{ input, preview }`                                                           |
| `PUT /<name>/webhook`                  | Add or remove the workflow's webhook: `{ enabled }`                                         |
