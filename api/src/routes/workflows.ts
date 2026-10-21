/**
 * Workflows (docs/src/content/docs/workflows.md): the workspace routes for
 * people, a webhook per workflow, and the runtime routes for the worker.
 *
 * Workflows, runs and logs are read from Hatchet and trimmed
 * (workflows/runs.ts); Mako keeps only the deploy state on the workspace. The
 * runtime routes accept a workspace API key with the `workflows:runtime`
 * scope, which a person cannot put on a key; the key decides the workspace.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Types } from "mongoose";

import { WORKFLOWS_DIR } from "../apps/app-paths";
import { ensureCommitLocally } from "../apps/cloud-repo.service";
import { isOid, runGitBuffer } from "../apps/git";
import { repoDirFor, resolveCommit } from "../apps/repository.service";
import { listFiles, readFile } from "../apps/worktree.service";
import {
  hasWorkspaceApiKeyScope,
  queryAccessFromScopes,
  resolveWorkspaceApiKeyScopes,
} from "../auth/api-key-scopes";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { checkBillingLimits } from "../billing/usage-limit.middleware";
import { AppProject, Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  AuthenticatedContext,
  requireWorkspace,
} from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { trackUsage } from "../services/llm-usage.service";
import { workspaceService } from "../services/workspace.service";
import { runStepAgent } from "../workflows/agent";
import {
  HatchetError,
  readWorkspaceTenant,
  requireTenant,
  startRun,
} from "../workflows/hatchet";
import {
  WORKFLOW_QUERY_MAX_ROWS,
  WORKFLOW_QUERY_MAX_TIMEOUT_MS,
  WorkflowQueryError,
  runWorkflowQuery,
} from "../workflows/query";
import { readWorkflowsOverview } from "../workflows/runs";
import { WORKFLOWS_ADMIN_ONLY, mayChangeWorkflows } from "../workflows/policy";
import { startSandboxRun } from "../workflows/sandbox";
import { waitForRun } from "../workflows/status";
import { isWebhookSecret, setTriggers } from "../workflows/webhook";

const logger = loggers.api("workflows");

/** How many recent runs the Workflows screen lists. */
const RUNS_SHOWN = 100;

/**
 * Every route answers an error the same way. An upstream failure is a 500
 * with its reason, never a 502: the proxy in front of Mako replaces an
 * origin's 502 with its own page, and the reason is lost.
 */
function fail(error: unknown, c: Context): Response {
  if (error instanceof HatchetError) {
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 500;
    return c.json({ success: false, error: error.message }, status as 500);
  }
  logger.error("Workflows route error", { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    },
    500,
  );
}

// --- Workspace routes -------------------------------------------------------

export const workflowRoutes = createRouter();
workflowRoutes.onError(fail);

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
    (c.req.path.endsWith("/run") ? mayRun(c) : mayChange(c));
  if (!allowed) {
    return c.json(
      {
        success: false,
        error: mayRun(c)
          ? WORKFLOWS_ADMIN_ONLY
          : "Viewers cannot change workflows",
      },
      403,
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
      "One run, deployed or sandbox (the caller's own): its steps in order, with status, output, error and logs. `wait` (seconds, at most 90) waits for it to end (`running: true` when it had not); `full` gives a sandbox run whole",
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
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, id } = c.req.valid("param");
    const { wait, full } = c.req.valid("query");
    const { run, done } = await waitForRun(workspaceId, c.get("user")?.id, id, {
      wait,
      full,
    });
    return c.json(
      { success: true as const, run, ...(done ? {} : { running: true }) },
      200,
    );
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
    if (!file) return c.json({ success: false, error: "File not found" }, 404);
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
      "Start a run of the deployed workflow (answers its runId), or with `sandbox` the caller's checkout in their sandbox. Answers the runId at once; follow it with GET /runs/{id}?wait=",
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
    if (body?.sandbox === true) {
      const userId = c.get("user")?.id;
      if (!userId) {
        throw new HatchetError("A sandbox needs a signed-in user", 400);
      }
      const { runId } = await startSandboxRun(
        workspaceId,
        userId,
        name,
        body.input,
      );
      return c.json({ success: true as const, runId, sandbox: true }, 200);
    }
    const runId = await startRun(await requireTenant(workspaceId), name, {
      input: body?.input,
      trigger: c.get("authType") === "session" ? "ui" : "api",
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

// --- Webhooks (public; the URL is the credential) ----------------------------

export const workflowHookRoutes = createRouter();
workflowHookRoutes.onError(fail);

workflowHookRoutes.post(
  "/:workspaceId/:name/:secret",
  bodyLimit({ maxSize: 1024 * 1024 }),
  async c => {
    const { workspaceId, name, secret } = c.req.param();
    const workspace = Types.ObjectId.isValid(workspaceId)
      ? await Workspace.findById(workspaceId)
          .select("workflows.webhooks workflows.active")
          .lean()
      : null;
    const { webhooks, active } = workspace?.workflows ?? {};
    // One answer for every wrong URL: it does not say which part was wrong.
    if (!isWebhookSecret(webhooks, name, secret)) {
      return c.json({ error: "Not found" }, 404);
    }
    const body: unknown = await c.req.json().catch(() => ({}));
    const input =
      body && typeof body === "object" && !Array.isArray(body)
        ? body
        : { body };
    // The test URL: `?sandbox=<user id>` runs that member's checkout in
    // their sandbox with this body and answers its runId (202). It
    // works whether or not the workflow is active.
    const tester = c.req.query("sandbox");
    if (tester) {
      const member = await workspaceService.hasRole(workspaceId, tester, [
        "owner",
        "admin",
        "member",
      ]);
      if (!member) return c.json({ error: "Not found" }, 404);
      return c.json(
        await startSandboxRun(workspaceId, tester, name, input),
        202,
      );
    }
    // The production URL works while the workflow is active, like its schedule.
    const tenant = active?.includes(name)
      ? await readWorkspaceTenant(workspaceId)
      : null;
    if (!tenant) return c.json({ error: "Not found" }, 404);
    const runId = await startRun(tenant, name, { input, trigger: "webhook" });
    return c.json({ runId }, 202);
  },
);

// --- Runtime routes (the worker only) ----------------------------------------

export const workflowRuntimeRoutes = createRouter();
workflowRuntimeRoutes.onError(fail);

const MAX_BUILD_ERROR_CHARS = 8000;
const GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1/ai"
).replace(/\/+$/, "");

// Decision models are served only by the gateway's v4 API (the base
// `@ai-sdk/gateway` v4 uses), and only to clients that state the gateway
// protocol version. A custom base without a version is left as it is.
const DECISION_GATEWAY_BASE_URL = GATEWAY_BASE_URL.replace(
  /\/v\d+\/ai$/,
  "/v4/ai",
);
const GATEWAY_PROTOCOL_VERSION = "0.0.1";

/**
 * Where a language-model call goes. The gateway answers in the shape of the
 * spec version its path names: `/v1/ai` returns flat token counts
 * (`inputTokens: 13`), `/v3/ai` the per-side objects (`inputTokens:
 * { total: 13 }`) that ai@6 reads. `@ai-sdk/gateway` passes the gateway's
 * result through untouched, so a v3 client sent to `/v1/ai` read every
 * call's usage as 0 tokens. Follow the version the client states; a client
 * that states none (a plain fetch) keeps the configured base.
 */
export function languageModelGatewayBase(
  specificationVersion: string | undefined,
): string {
  const version = Number(specificationVersion);
  if (!Number.isInteger(version) || version < 3) return GATEWAY_BASE_URL;
  return GATEWAY_BASE_URL.replace(/\/v\d+\/ai$/, `/v${version}/ai`);
}

type Worker = { workspaceId: string; userId: string };

// Mako's own auth resolves the key; a session or a key without the worker's
// scope is turned away here (scoped-key-routes.ts already refuses the latter).
workflowRuntimeRoutes.use("*", unifiedAuthMiddleware);

/** The worker behind the request: its workspace and who set it up. */
function workerOf(c: AuthenticatedContext): Worker | null {
  const key = c.get("apiKey") as
    { scopes?: string[]; createdBy?: string } | undefined;
  const workspace = c.get("workspace");
  if (c.get("authType") !== "apiKey" || !key || !workspace) return null;
  const scopes = resolveWorkspaceApiKeyScopes(key.scopes);
  if (!hasWorkspaceApiKeyScope(scopes, "workflows:runtime")) return null;
  return {
    workspaceId: workspace._id.toString(),
    userId: String(key.createdBy),
  };
}

/**
 * A person running workflow code themselves (`mako workflow run`, a sandbox
 * run) with their own login or API key. They act as themselves, exactly as
 * over /api/mcp: the same reads and writes, billed to the workspace. The
 * workflow name they send (X-Mako-Workflow) grants nothing.
 */
function personOf(c: AuthenticatedContext): Worker | null {
  const user = c.get("user") as { id?: string } | undefined;
  const workspace = c.get("workspace");
  const kind = c.get("authType");
  if ((kind !== "apiKey" && kind !== "mcpOAuth") || !user?.id || !workspace) {
    return null;
  }
  return { workspaceId: workspace._id.toString(), userId: String(user.id) };
}

/** A runtime handler: it runs only for a worker key, and is given its worker. */
const asWorker =
  (
    handler: (c: Context, worker: Worker) => Promise<Response>,
    { person = false } = {},
  ) =>
  async (c: AuthenticatedContext) => {
    const worker = workerOf(c) ?? (person ? personOf(c) : null);
    return worker
      ? handler(c, worker)
      : c.json({ error: "Invalid worker key" }, 401);
  };

/** The SQL, model and agent routes, which a person's own run calls too. */
const asWorkerOrPerson = (
  handler: (c: Context, worker: Worker) => Promise<Response>,
) => asWorker(handler, { person: true });

// What the worker should run. It polls this: the commit, which workflows
// have their triggers on, and the Hatchet token to connect with, so the
// worker holds one credential only.
workflowRuntimeRoutes.get(
  "/head",
  asWorker(async (c, { workspaceId }) => {
    const [workspace, tenant] = await Promise.all([
      Workspace.findById(workspaceId)
        .select("workflows.live workflows.active")
        .lean(),
      readWorkspaceTenant(workspaceId),
    ]);
    const wanted = workspace?.workflows?.live;
    const live = wanted ? { sha: wanted.sha, tree: wanted.tree } : null;
    return c.json({
      hatchetToken: tenant?.token ?? null,
      live,
      active: workspace?.workflows?.active ?? [],
    });
  }),
);

// The worker reports each switch: the commit it now runs, or the commit it
// could not start and why. This is what the UI shows as live and build
// error. A report for a commit that is no longer wanted changes nothing.
workflowRuntimeRoutes.post(
  "/status",
  asWorker(async (c, { workspaceId }) => {
    const body = (await c.req.json().catch(() => null)) as {
      sha?: unknown;
      error?: unknown;
    } | null;
    if (typeof body?.sha !== "string" || !isOid(body.sha)) {
      return c.json({ error: "Invalid report" }, 400);
    }
    await Workspace.updateOne(
      { _id: new Types.ObjectId(workspaceId), "workflows.live.sha": body.sha },
      typeof body.error === "string"
        ? {
            $set: {
              "workflows.live.failed": {
                sha: body.sha,
                error: body.error.slice(-MAX_BUILD_ERROR_CHARS),
              },
            },
          }
        : {
            $set: { "workflows.live.running": { sha: body.sha } },
            $unset: { "workflows.live.failed": "" },
          },
    );
    return c.json({ ok: true });
  }),
);

// Model calls from a step go through Mako to the AI gateway: the worker holds
// no provider key, and the call is checked against the workspace's plan and
// counted in its usage like a chat turn. Only the gateway calls this file
// knows how to count are forwarded: unstreamed language models, and decision
// models (e.g. TypeSafe's `typesafe-ai/jev`).
async function forwardToGateway(
  c: Context,
  { workspaceId, userId }: Worker,
  kind: "language-model" | "decision-model",
  modelId: string,
): Promise<Response> {
  const limits = await checkBillingLimits(workspaceId, modelId);
  if (!limits.allowed) {
    return c.json(
      { error: limits.error?.message ?? "Usage limit reached" },
      (limits.statusCode ?? 402) as 402,
    );
  }
  const headers = new Headers({
    Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY ?? ""}`,
  });
  c.req.raw.headers.forEach((value, name) => {
    // The gateway's own protocol headers and the content type, nothing else.
    if (name === "content-type" || name.startsWith("ai-")) {
      headers.set(name, value);
    }
  });
  const startedAt = Date.now();
  const decision = kind === "decision-model";
  if (decision && !headers.has("ai-gateway-protocol-version")) {
    // `@ai-sdk/gateway` sends it; a plain fetch from a step does not.
    headers.set("ai-gateway-protocol-version", GATEWAY_PROTOCOL_VERSION);
  }
  const base = decision
    ? DECISION_GATEWAY_BASE_URL
    : languageModelGatewayBase(
        c.req.header("ai-language-model-specification-version"),
      );
  const res = await fetch(`${base}/${kind}`, {
    method: "POST",
    headers,
    body: await c.req.arrayBuffer(),
  }).catch(() => {
    throw new HatchetError("The AI gateway is unreachable", 502);
  });
  const body = await res.text();
  if (res.ok) {
    // A language model reports `{ total }` per side, a decision model a number.
    const tokens = (value: unknown): number =>
      typeof value === "number"
        ? value
        : ((value as { total?: number } | undefined)?.total ?? 0);
    let usage: { inputTokens?: unknown; outputTokens?: unknown } = {};
    let gatewayCost: unknown;
    try {
      const result = JSON.parse(body) as {
        usage?: typeof usage;
        providerMetadata?: { gateway?: { cost?: unknown } };
      };
      usage = result.usage ?? {};
      gatewayCost = result.providerMetadata?.gateway?.cost;
    } catch {
      // Not a model result: nothing to count.
    }
    const inputTokens = tokens(usage.inputTokens);
    const outputTokens = tokens(usage.outputTokens);
    // Mako's price list has no decision models; the gateway says what the
    // call cost, so a decision is billed at that.
    const costUsd = decision ? Number(gatewayCost) : NaN;
    void trackUsage({
      workspaceId,
      userId,
      invocationType: "workflow",
      modelId,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs: Date.now() - startedAt,
      ...(Number.isFinite(costUsd) ? { costUsd } : {}),
    });
  }
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

workflowRuntimeRoutes.post(
  "/ai/language-model",
  asWorkerOrPerson(async (c, worker) => {
    if (c.req.header("ai-language-model-streaming") === "true") {
      return c.json(
        { error: "Streaming is not available in a step; use generateText." },
        400,
      );
    }
    const modelId = c.req.header("ai-language-model-id") ?? "";
    return forwardToGateway(c, worker, "language-model", modelId);
  }),
);

workflowRuntimeRoutes.post(
  "/ai/decision-model",
  asWorkerOrPerson(async (c, worker) =>
    forwardToGateway(
      c,
      worker,
      "decision-model",
      c.req.header("ai-model-id") ?? "",
    ),
  ),
);

// Mako's own agent for a step (lib/mako `agent()`): a goal in, the answer and
// the tools it used out. It acts as the person who set the worker up.
workflowRuntimeRoutes.post(
  "/agent",
  asWorkerOrPerson(async (c, worker) => {
    const body = (await c.req.json().catch(() => null)) as {
      goal?: unknown;
      model?: unknown;
      maxSteps?: unknown;
    } | null;
    if (typeof body?.goal !== "string" || !body.goal.trim()) {
      return c.json({ error: "A goal is required" }, 400);
    }
    return c.json(
      await runStepAgent({
        ...worker,
        goal: body.goal,
        modelId: typeof body.model === "string" ? body.model : undefined,
        maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
      }),
    );
  }),
);

// SQL for a step (lib/mako `query()` / `execute()`): the statement runs
// once and its rows come back as the driver returns them, up to a cap, after
// the same checks as the agent's sql_execute_query (workflows/query.ts). A
// refused, failed, capped or timed-out query is a 400 with its reason.
workflowRuntimeRoutes.post(
  "/query",
  asWorkerOrPerson(async (c, worker) => {
    const body = (await c.req.json().catch(() => null)) as {
      connectionId?: unknown;
      query?: unknown;
      database?: unknown;
      maxRows?: unknown;
      timeoutMs?: unknown;
    } | null;
    if (typeof body?.connectionId !== "string" || !body.connectionId) {
      return c.json({ error: "A connectionId is required" }, 400);
    }
    if (typeof body.query !== "string" || !body.query.trim()) {
      return c.json({ error: "A query is required" }, 400);
    }
    const whole = (value: unknown, max: number) =>
      value === undefined ||
      (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= max);
    if (!whole(body.maxRows, WORKFLOW_QUERY_MAX_ROWS)) {
      return c.json(
        {
          error: `maxRows must be a whole number from 1 to ${WORKFLOW_QUERY_MAX_ROWS}`,
        },
        400,
      );
    }
    if (!whole(body.timeoutMs, WORKFLOW_QUERY_MAX_TIMEOUT_MS)) {
      return c.json(
        {
          error: `timeoutMs must be a whole number of milliseconds up to ${WORKFLOW_QUERY_MAX_TIMEOUT_MS}`,
        },
        400,
      );
    }
    // The key's scopes, or a login's (query:read: it reads, as over /api/mcp).
    const key = c.get("apiKey") as { scopes?: string[] } | undefined;
    const scopes = key?.scopes ?? c.get("mcpOAuthScopes");
    try {
      return c.json(
        await runWorkflowQuery(
          {
            ...worker,
            queryAccess: queryAccessFromScopes(
              resolveWorkspaceApiKeyScopes(scopes),
            ),
          },
          {
            connectionId: body.connectionId,
            query: body.query,
            database:
              typeof body.database === "string" && body.database
                ? body.database
                : undefined,
            maxRows: body.maxRows as number | undefined,
            timeoutMs: body.timeoutMs as number | undefined,
          },
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowQueryError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  }),
);

// `workflows/` at a commit, as a gzipped tarball. The key limits the worker to
// its own workspace's repository.
workflowRuntimeRoutes.get(
  "/source/:sha",
  asWorker(async (c, { workspaceId }) => {
    const sha = c.req.param("sha") ?? "";
    if (!isOid(sha)) return c.json({ error: "Invalid commit" }, 400);
    // A fresh API instance has an empty disk: restore the repository and this
    // commit from the mirror first.
    const workspace = await Workspace.findById(workspaceId)
      .select("workflows.live")
      .lean();
    // Only what the worker was told to run: no browsing the repository.
    if (sha !== workspace?.workflows?.live?.sha) {
      return c.json({ error: "Not a deployed commit" }, 404);
    }
    await ensureCommitLocally(workspaceId, sha);
    const repoDir = repoDirFor(workspaceId);
    const present = await resolveCommit(repoDir, sha).catch(() => null);
    if (!present) {
      // Another instance took the push and the mirror does not have it yet:
      // the worker asks again later.
      return c.json({ error: "That commit is not on this instance" }, 404);
    }
    const tarball = await runGitBuffer([
      "-C",
      repoDir,
      "archive",
      "--format=tar.gz",
      sha,
      WORKFLOWS_DIR,
    ]).catch(() => null);
    return tarball
      ? new Response(new Uint8Array(tarball), {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        })
      : c.json({ error: "No workflows/ folder at that commit" }, 404);
  }),
);
