/**
 * The workspace routes for people: list, deploy state, runs and logs,
 * starting/retrying runs, triggers and webhooks.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { WORKFLOWS_DIR } from "../../apps/app-paths";
import { listFiles, readFile } from "../../apps/worktree.service";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { AppProject } from "../../database/workspace-schema";
import {
  AuthenticatedContext,
  requireWorkspace,
} from "../../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { HatchetError, requireTenant, startRun } from "../../workflows/hatchet";
import {
  readWorkflowFlow,
  readWorkflowsOverview,
  retryRun,
} from "../../workflows/runs";
import {
  WORKFLOWS_ADMIN_ONLY,
  mayChangeWorkflows,
} from "../../workflows/policy";
import { readWorkflowCost } from "../../workflows/costs";
import { isSandboxRunId, startSandboxRun } from "../../workflows/sandbox";
import { waitForRun } from "../../workflows/status";
import { setTriggers } from "../../workflows/webhook";
import { fail } from "../lib/respond";
import { onRouteError } from "./shared";

/** How many recent runs the Workflows screen lists. */
const RUNS_SHOWN = 100;
// --- Workspace routes -------------------------------------------------------

export const workflowRoutes = createRouter();
workflowRoutes.onError(onRouteError);

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const NameParam = WorkspaceParam.extend({
  name: z.string().openapi({ param: { name: "name", in: "path" } }),
});

/** Viewers look; members start runs; admins activate and add webhooks. */
const mayRun = (c: AuthenticatedContext) =>
  ["owner", "admin", "member"].includes(c.get("memberRole") ?? "");
const mayChange = (c: AuthenticatedContext) =>
  mayChangeWorkflows(c.get("memberRole"));

workflowRoutes.use("*", unifiedAuthMiddleware, requireWorkspace);
workflowRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const allowed =
    c.req.method === "GET" ||
    (/\/(run|retry)$/.test(c.req.path) ? mayRun(c) : mayChange(c));
  if (!allowed) {
    return fail(
      c,
      403,
      mayRun(c) ? WORKFLOWS_ADMIN_ONLY : "Viewers cannot change workflows",
    );
  }
  await next();
});

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Workflows"],
    summary: "What is deployed, the workflows, schedules and recent runs",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      {
        success: true as const,
        ...(await readWorkflowsOverview(workspaceId, RUNS_SHOWN, mayChange(c))),
      },
      200,
    );
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/runs/{id}",
    tags: ["Workflows"],
    summary:
      "One run, deployed or sandbox (the caller's own): its steps in order, with status, output, error and logs. `wait` (seconds, at most 90) waits for it to end (`running: true` when it had not); `full` gives a sandbox run whole. A run an agent started also answers the connection writes it recorded instead of sending: `recordedWriteCount` and one page of `recordedWrites` (the next from `recordedFrom`, given as `recordedWritesNext`)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      query: z.object({
        wait: z.coerce.number().min(0).optional(),
        full: z
          .enum(["true", "false"])
          .optional()
          .transform(value => value === "true"),
        recordedFrom: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, id } = c.req.valid("param");
    const { wait, full, recordedFrom } = c.req.valid("query");
    const { run, done } = await waitForRun(workspaceId, c.get("user")?.id, id, {
      wait,
      full,
      recordedFrom,
    });
    return c.json(
      { success: true as const, run, ...(done ? {} : { running: true }) },
      200,
    );
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{name}/flow",
    tags: ["Workflows"],
    summary:
      "A deployed workflow's steps as its code defines them: each with the steps it waits for, its retries and timeout",
    security: AUTH_SECURITY,
    request: { params: NameParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, name } = c.req.valid("param");
    const flow = await readWorkflowFlow(await requireTenant(workspaceId), name);
    return c.json({ success: true as const, ...flow }, 200);
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{name}/cost",
    tags: ["Workflows"],
    summary:
      "A workflow's AI cost (its runs' model calls) over the last `days` days (default 30), in total and by day",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, name } = c.req.valid("param");
    const { days } = c.req.valid("query");
    const cost = await readWorkflowCost(workspaceId, name, days ?? 30);
    return c.json({ success: true as const, ...cost }, 200);
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/runs/{id}/retry",
    tags: ["Workflows"],
    summary:
      "Retry a deployed run in place. With `step`: that step and the ones after it run again, on what the earlier steps kept; without, the whole run",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ step: z.string().optional() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, id } = c.req.valid("param");
    if (isSandboxRunId(id)) {
      throw new HatchetError(
        "A sandbox run is not kept: start it again instead",
        400,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const step = typeof body?.step === "string" ? body.step : undefined;
    const retried = await retryRun(await requireTenant(workspaceId), id, step);
    return c.json({ success: true as const, ...retried }, 200);
  },
);

/**
 * `workflows/` as an app-shaped project, so the Apps file functions read it:
 * the person's own branch, from their sandbox while it runs.
 */
const workflowsProject = (workspaceId: string, userId: string) =>
  new AppProject({
    workspaceId: new Types.ObjectId(workspaceId),
    title: WORKFLOWS_DIR,
    slug: WORKFLOWS_DIR,
    path: WORKFLOWS_DIR,
    access: "workspace",
    createdBy: userId,
  });

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/files",
    tags: ["Workflows"],
    summary: "The files under workflows/, or one file's contents with ?path=",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({ path: z.string().optional() }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const { path } = c.req.valid("query");
    const userId = String(c.get("user")?.id);
    const project = workflowsProject(workspaceId, userId);
    if (!path) {
      const listing = await listFiles(project, userId).catch(() => null);
      const files = listing?.entries.map(entry => entry.path) ?? [];
      return c.json({ success: true as const, files }, 200);
    }
    const file = await readFile(project, path, userId).catch(() => null);
    if (!file) return fail(c, 404, "File not found");
    return c.json(
      { success: true as const, contents: file.isBinary ? "" : file.contents },
      200,
    );
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{name}/run",
    tags: ["Workflows"],
    summary:
      "Start a run of the deployed workflow (answers its runId), or with `sandbox` the caller's checkout in their sandbox. Answers the runId at once; follow it with GET /runs/{id}?wait=. Its connection writes are sent (a run started with an API key has them refused); with `dryRun` they are recorded instead, not sent, and its SQL only reads",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              input: z.record(z.string(), z.unknown()).optional(),
              sandbox: z.boolean().optional(),
              dryRun: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, name } = c.req.valid("param");
    const body = await c.req.json().catch(() => ({}));
    const auth = c.get("authType");
    const session = auth === "session";
    const dryRun = body?.dryRun === true;
    if (body?.sandbox === true) {
      const userId = c.get("user")?.id;
      if (!userId) {
        throw new HatchetError("A sandbox needs a signed-in user", 400);
      }
      // The person's own run, or one an MCP login started for them, writes
      // as them. One started with an API key (CI, a script: Mako cannot
      // tell who holds the key) has its writes refused, so it fails loudly.
      // A dry run records them instead.
      const { runId } = await startSandboxRun(
        workspaceId,
        userId,
        name,
        body.input,
        {
          writes: dryRun
            ? "record"
            : session || auth === "mcpOAuth"
              ? "send"
              : "refuse",
        },
      );
      return c.json({ success: true as const, runId, sandbox: true }, 200);
    }
    // As for a sandbox run; its trigger says which (runs.ts `runWritesOf`):
    // an MCP login's ("mcp") sends its writes, an API key's ("api") has them
    // refused.
    const runId = await startRun(await requireTenant(workspaceId), name, {
      input: body?.input,
      trigger: session ? "ui" : auth === "mcpOAuth" ? "mcp" : "api",
      startedBy: session ? "person" : "agent",
      ...(dryRun ? { dryRun } : {}),
    });
    return c.json({ success: true as const, runId }, 200);
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{name}/triggers",
    tags: ["Workflows"],
    summary:
      "Change what starts a workflow: `active` (its schedule and webhook), `webhook` (add: a new URL; remove)",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              active: z.boolean().optional(),
              webhook: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, name } = c.req.valid("param");
    const changed = await setTriggers(workspaceId, name, c.req.valid("json"));
    return c.json({ success: true as const, ...changed }, 200);
  },
);
