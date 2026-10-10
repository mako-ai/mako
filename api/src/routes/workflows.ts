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
import {
  ensureCommitLocally,
  ensureLocalRepo,
} from "../apps/cloud-repo.service";
import { GitError, assertSafeRelPath, isOid, runGitBuffer } from "../apps/git";
import {
  DEFAULT_BRANCH,
  listTree,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { hashApiKey } from "../auth/api-key.middleware";
import {
  hasWorkspaceApiKeyScope,
  resolveWorkspaceApiKeyScopes,
} from "../auth/api-key-scopes";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { checkBillingLimits } from "../billing/usage-limit.middleware";
import { AppWorktree, Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  AuthenticatedContext,
  requireWorkspace,
} from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { trackUsage } from "../services/llm-usage.service";
import { runStepAgent } from "../workflows/agent";
import {
  HatchetError,
  readWorkspaceTenant,
  requireTenant,
  startRun,
} from "../workflows/hatchet";
import { readRun, readWorkflowsOverview } from "../workflows/runs";
import { isWebhookSecret, setWebhook } from "../workflows/webhook";

const logger = loggers.api("workflows");

/** How many recent runs the Workflows screen lists. */
const RUNS_SHOWN = 100;

/** Every route answers an error the same way. */
function fail(error: unknown, c: Context): Response {
  if (error instanceof HatchetError) {
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 502;
    return c.json({ success: false, error: error.message }, status as 502);
  }
  if (error instanceof GitError) {
    return c.json({ success: false, error: "File not found" }, 404);
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

/** Viewers look; starting runs and changing webhooks need a member. */
const mayRun = (c: AuthenticatedContext) =>
  ["owner", "admin", "member"].includes(c.get("memberRole") ?? "");

workflowRoutes.use("*", unifiedAuthMiddleware, requireWorkspace);
workflowRoutes.use("*", async (c: AuthenticatedContext, next) => {
  if (c.req.method !== "GET" && !mayRun(c)) {
    return c.json(
      { success: false, error: "Viewers cannot change workflows" },
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
    summary:
      "What is deployed (live and preview), the workflows, schedules and recent runs",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      {
        success: true as const,
        ...(await readWorkflowsOverview(workspaceId, RUNS_SHOWN, mayRun(c))),
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
    summary: "One run: its steps in order, with status, output, error and logs",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, id } = c.req.valid("param");
    const run = await readRun(await requireTenant(workspaceId), id);
    return c.json({ success: true as const, run }, 200);
  },
);

/**
 * The commit a person's view of `workflows/` is read from: the branch their
 * checkout is on, so they see the work they are previewing, else main.
 */
async function filesRef(
  workspaceId: string,
  userId: string,
): Promise<{ repoDir: string; ref: string } | null> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return null;
  const worktree = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    userId,
  })
    .select("branch")
    .lean();
  for (const branch of [worktree?.branch, DEFAULT_BRANCH]) {
    if (!branch) continue;
    const ref = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (ref) return { repoDir, ref };
  }
  return null;
}

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
    const source = await filesRef(workspaceId, String(c.get("user")?.id));
    if (!source) return c.json({ success: true as const, files: [] }, 200);
    const prefix = `${WORKFLOWS_DIR}/`;
    if (!path) {
      const files = (await listTree(source.repoDir, source.ref))
        .map(entry => entry.path)
        .filter(file => file.startsWith(prefix))
        .map(file => file.slice(prefix.length));
      return c.json({ success: true as const, files }, 200);
    }
    const file = await readBlob(
      source.repoDir,
      source.ref,
      `${prefix}${assertSafeRelPath(path)}`,
    );
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
    summary: "Start a run of a workflow, or of its preview",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              input: z.record(z.string(), z.unknown()).optional(),
              preview: z.boolean().optional(),
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
    const runId = await startRun(await requireTenant(workspaceId), name, {
      input: body?.input,
      preview: body?.preview === true,
      trigger: c.get("authType") === "session" ? "ui" : "api",
    });
    return c.json({ success: true as const, runId }, 200);
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{name}/webhook",
    tags: ["Workflows"],
    summary: "Turn a workflow's webhook on (a new URL) or off",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      body: {
        required: true,
        content: {
          "application/json": { schema: z.object({ enabled: z.boolean() }) },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, name } = c.req.valid("param");
    await setWebhook(workspaceId, name, c.req.valid("json").enabled);
    return c.json({ success: true as const }, 200);
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
          .select("workflows.webhooks")
          .lean()
      : null;
    const tenant = isWebhookSecret(workspace?.workflows?.webhooks, name, secret)
      ? await readWorkspaceTenant(workspaceId)
      : null;
    // One answer for every wrong URL: it does not say which part was wrong.
    if (!tenant) return c.json({ error: "Not found" }, 404);
    const body: unknown = await c.req.json().catch(() => ({}));
    const input =
      body && typeof body === "object" && !Array.isArray(body)
        ? body
        : { body };
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

type Worker = { workspaceId: string; userId: string };

/** A worker key's workspace and the person who set the worker up. */
async function workerOf(c: Context): Promise<Worker | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer revops_")) return null;
  const keyHash = hashApiKey(header.substring(7));
  const workspace = await Workspace.findOne({ "apiKeys.keyHash": keyHash })
    .select("apiKeys")
    .lean();
  const key = workspace?.apiKeys?.find(k => k.keyHash === keyHash);
  if (!workspace || !key) return null;
  const scopes = resolveWorkspaceApiKeyScopes(key.scopes);
  if (!hasWorkspaceApiKeyScope(scopes, "workflows:runtime")) return null;
  return { workspaceId: workspace._id.toString(), userId: key.createdBy };
}

/** A runtime handler: it runs only for a worker key, and is given its worker. */
const asWorker =
  (handler: (c: Context, worker: Worker) => Promise<Response>) =>
  async (c: Context) => {
    const worker = await workerOf(c);
    return worker
      ? handler(c, worker)
      : c.json({ error: "Invalid worker key" }, 401);
  };

// What the worker should run. It polls this: the commit to switch to, the
// preview commit if there is one, and the Hatchet token to connect with, so
// the worker holds one credential only.
workflowRuntimeRoutes.get(
  "/head",
  asWorker(async (c, { workspaceId }) => {
    const [workspace, tenant] = await Promise.all([
      Workspace.findById(workspaceId)
        .select("workflows.target workflows.preview")
        .lean(),
      readWorkspaceTenant(workspaceId),
    ]);
    const { target, preview } = workspace?.workflows ?? {};
    return c.json({
      sha: target?.sha ?? null,
      tree: target?.tree ?? null,
      hatchetToken: tenant?.token ?? null,
      // Unmerged work to run next to the live code, or null.
      preview: preview ? { sha: preview.sha, tree: preview.tree } : null,
    });
  }),
);

// The worker reports each switch, for the live code or the preview: the
// commit it now runs, or the commit it could not start and why. This is what
// the UI shows as live and build error.
workflowRuntimeRoutes.post(
  "/status",
  asWorker(async (c, { workspaceId }) => {
    const body = (await c.req.json().catch(() => null)) as {
      sha?: unknown;
      error?: unknown;
      preview?: unknown;
    } | null;
    if (typeof body?.sha !== "string" || !isOid(body.sha)) {
      return c.json({ error: "Invalid commit" }, 400);
    }
    const live = body.preview === true ? "previewLive" : "live";
    const failed = body.preview === true ? "previewFailed" : "failed";
    await Workspace.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      typeof body.error === "string"
        ? {
            $set: {
              [`workflows.${failed}`]: {
                sha: body.sha,
                error: body.error.slice(-MAX_BUILD_ERROR_CHARS),
              },
            },
          }
        : {
            $set: { [`workflows.${live}`]: { sha: body.sha } },
            $unset: { [`workflows.${failed}`]: "" },
          },
    );
    return c.json({ ok: true });
  }),
);

// Model calls from a step go through Mako to the AI gateway: the worker holds
// no provider key, and the call is checked against the workspace's plan and
// counted in its usage like a chat turn. Language models only, not streamed:
// that is the one gateway call this route knows how to count.
workflowRuntimeRoutes.post(
  "/ai/language-model",
  asWorker(async (c, { workspaceId, userId }) => {
    const modelId = c.req.header("ai-language-model-id") ?? "";
    if (c.req.header("ai-language-model-streaming") === "true") {
      return c.json(
        { error: "Streaming is not available in a step; use generateText." },
        400,
      );
    }
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
    const res = await fetch(`${GATEWAY_BASE_URL}/language-model`, {
      method: "POST",
      headers,
      body: await c.req.arrayBuffer(),
    }).catch(() => {
      throw new HatchetError("The AI gateway is unreachable", 502);
    });
    const body = await res.text();
    if (res.ok) {
      const tokens = (value: unknown): number =>
        typeof value === "number"
          ? value
          : ((value as { total?: number } | undefined)?.total ?? 0);
      let usage: { inputTokens?: unknown; outputTokens?: unknown } = {};
      try {
        usage = (JSON.parse(body) as { usage?: typeof usage }).usage ?? {};
      } catch {
        // Not a generation result: nothing to count.
      }
      const inputTokens = tokens(usage.inputTokens);
      const outputTokens = tokens(usage.outputTokens);
      void trackUsage({
        workspaceId,
        userId,
        invocationType: "workflow",
        modelId,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        durationMs: Date.now() - startedAt,
      });
    }
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      },
    });
  }),
);

// Mako's own agent for a step (lib/mako `agent()`): a goal in, the answer and
// the tools it used out. It acts as the person who set the worker up.
workflowRuntimeRoutes.post(
  "/agent",
  asWorker(async (c, worker) => {
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

// `workflows/` at a commit, as a gzipped tarball. The key limits the worker to
// its own workspace's repository.
workflowRuntimeRoutes.get(
  "/source/:sha",
  asWorker(async (c, { workspaceId }) => {
    const sha = c.req.param("sha");
    if (!isOid(sha)) return c.json({ error: "Invalid commit" }, 400);
    // A fresh API instance has an empty disk: restore the repository and this
    // commit from the mirror first. A preview's commit is on its own branch.
    const workspace = await Workspace.findById(workspaceId)
      .select("workflows.preview")
      .lean();
    const preview = workspace?.workflows?.preview;
    await ensureCommitLocally(
      workspaceId,
      sha,
      preview?.sha === sha ? preview.branch : undefined,
    );
    const tarball = await runGitBuffer([
      "-C",
      repoDirFor(workspaceId),
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
