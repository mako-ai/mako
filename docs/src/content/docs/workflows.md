---
title: Workflows (preview)
description: Write scheduled and multi-step jobs as TypeScript files in your workspace repo. A merge to main deploys them, Hatchet runs them.
---

A workflow is a TypeScript file in your workspace repo, in the `workflows/` folder, written with [Hatchet](https://hatchet.run)'s own SDK. Merge to `main` and it is deployed. Hatchet runs it: schedules, retries and timeouts are Hatchet's.

**Preview.** Workflows are optional, off by default, and have no screens in Mako yet. You start and inspect runs through the API or the Hatchet dashboard.

## A workflow

A workflow is a folder: `workflows/<name>/workflow.ts`. The folder name is the workflow's name.

```
workflows/
  hatchet.ts            the Hatchet client, shared
  lib/                  shared code
  daily-digest/
    workflow.ts
```

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

Starter files are in the Mako repository under `deploy/workflows/template/workflows/`.

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

3. Turn workflows on for a workspace. Signed in to Mako as a super admin (`SUPER_ADMIN_EMAILS`), run this in the browser console:

   ```js
   await fetch("/api/admin/workspaces/<workspaceId>/workflows", {
     method: "PUT",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ enabled: true }),
   }).then(r => r.json());
   ```

4. Copy the starter files into your workspace repo as `workflows/` and merge to `main`.

Hatchet dashboard: `http://localhost:8085` (`admin@example.com` / `Admin123!!`). This bundled Hatchet is for testing, not for production.

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
