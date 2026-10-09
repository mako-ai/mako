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
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { trackUsage } from "../services/llm-usage.service";
import { workspaceService } from "../services/workspace.service";
import {
  HatchetError,
  isHatchetId,
  readWorkspaceTenant,
  cancelRun,
  triggerRun,
  type WorkspaceTenant,
} from "../workflows/hatchet";
import {
  PREVIEW_PREFIX,
  readRun,
  readWorkflowsOverview,
} from "../workflows/runs";
import { isWebhookSecret, setWebhook } from "../workflows/webhook";

const logger = loggers.api("workflows");

/** How many recent runs the Workflows screen lists. */
const RUNS_SHOWN = 100;

// --- Workspace routes -------------------------------------------------------

export const workflowRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const RunParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const NameParam = WorkspaceParam.extend({
  name: z.string().openapi({ param: { name: "name", in: "path" } }),
});

workflowRoutes.use("*", unifiedAuthMiddleware);

workflowRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Invalid workspace ID format" },
      400,
    );
  }
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  if (!(await workspaceService.hasAccess(workspaceId, user.id))) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  }
  await next();
});

function fail(c: Context, error: unknown): Response {
  if (error instanceof HatchetError) {
    const status =
      error.status === 404 ? 404 : error.status === 503 ? 503 : 502;
    return c.json({ success: false, error: error.message }, status);
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

/** The workspace's tenant; without one the route answers 404. */
async function tenantOf(workspaceId: string): Promise<WorkspaceTenant> {
  const tenant = await readWorkspaceTenant(workspaceId);
  if (!tenant) {
    throw new HatchetError("Workflows are not set up for this workspace.", 404);
  }
  return tenant;
}

/** A live workflow's name, safe as a key and in a URL. A preview has no webhook. */
const mayHaveWebhook = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) && !name.startsWith(PREVIEW_PREFIX);

/** Viewers read runs; starting and cancelling need a member. */
async function mayRun(c: AuthenticatedContext): Promise<boolean> {
  return workspaceService.hasRole(
    c.req.param("workspaceId") as string,
    c.get("user")!.id,
    ["owner", "admin", "member"],
  );
}

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
    try {
      const { workspaceId } = c.req.valid("param");
      const tenant = await readWorkspaceTenant(workspaceId).catch(() => null);
      return c.json(
        {
          success: true as const,
          ...(await readWorkflowsOverview(
            workspaceId,
            tenant,
            RUNS_SHOWN,
            await mayRun(c),
          )),
        },
        200,
      );
    } catch (error) {
      return fail(c, error);
    }
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "get",
    path: "/runs/{id}",
    tags: ["Workflows"],
    summary: "One run: its steps in order, with status, output, error and logs",
    security: AUTH_SECURITY,
    request: { params: RunParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId, id } = c.req.valid("param");
      if (!isHatchetId(id)) {
        return c.json({ success: false, error: "Invalid run id" }, 400);
      }
      const tenant = await tenantOf(workspaceId);
      return c.json(
        { success: true as const, run: await readRun(tenant, id) },
        200,
      );
    } catch (error) {
      return fail(c, error);
    }
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
    try {
      const { workspaceId } = c.req.valid("param");
      const { path } = c.req.valid("query");
      const source = await filesRef(workspaceId, String(c.get("user")!.id));
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
        {
          success: true as const,
          path,
          contents: file.isBinary ? "" : file.contents,
        },
        200,
      );
    } catch (error) {
      if (error instanceof GitError) {
        return c.json({ success: false, error: "File not found" }, 404);
      }
      return fail(c, error);
    }
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{name}/run",
    tags: ["Workflows"],
    summary: "Start a run of a workflow",
    security: AUTH_SECURITY,
    request: {
      params: NameParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              input: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId, name } = c.req.valid("param");
      if (!(await mayRun(c))) {
        return c.json(
          { success: false, error: "Viewers cannot start runs" },
          403,
        );
      }
      const tenant = await tenantOf(workspaceId);
      const body = await c.req.json().catch(() => ({}));
      const run = await triggerRun(tenant, name, body?.input ?? {}, {
        trigger: c.get("authType") === "session" ? "ui" : "api",
        triggeredBy: String(c.get("user")!.id),
      });
      return c.json({ success: true as const, run }, 200);
    } catch (error) {
      return fail(c, error);
    }
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
    try {
      const { workspaceId, name } = c.req.valid("param");
      if (!mayHaveWebhook(name)) {
        return c.json({ success: false, error: "Invalid workflow name" }, 400);
      }
      if (!(await mayRun(c))) {
        return c.json(
          { success: false, error: "Viewers cannot change webhooks" },
          403,
        );
      }
      const { enabled } = c.req.valid("json");
      return c.json(
        {
          success: true as const,
          webhookUrl: await setWebhook(workspaceId, name, enabled),
        },
        200,
      );
    } catch (error) {
      return fail(c, error);
    }
  },
);

workflowRoutes.openapi(
  createRoute({
    method: "post",
    path: "/runs/{id}/cancel",
    tags: ["Workflows"],
    summary: "Cancel a run",
    security: AUTH_SECURITY,
    request: { params: RunParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId, id } = c.req.valid("param");
      if (!isHatchetId(id)) {
        return c.json({ success: false, error: "Invalid run id" }, 400);
      }
      if (!(await mayRun(c))) {
        return c.json(
          { success: false, error: "Viewers cannot cancel runs" },
          403,
        );
      }
      const result = await cancelRun(await tenantOf(workspaceId), id);
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return fail(c, error);
    }
  },
);

// --- Webhooks (public; the URL is the credential) ----------------------------

export const workflowHookRoutes = createRouter();

workflowHookRoutes.post("/:workspaceId/:name/:secret", async c => {
  const { workspaceId, name, secret } = c.req.param();
  // One answer for every wrong URL: it does not say which part was wrong.
  const notFound = () => c.json({ error: "Not found" }, 404);
  if (!Types.ObjectId.isValid(workspaceId) || !mayHaveWebhook(name)) {
    return notFound();
  }
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows.enabled workflows.webhooks")
    .lean();
  const state = workspace?.workflows;
  const tenant =
    state?.enabled === true && isWebhookSecret(state.webhooks?.[name], secret)
      ? await readWorkspaceTenant(workspaceId)
      : null;
  if (!tenant) return notFound();
  const body: unknown = await c.req.json().catch(() => ({}));
  const input =
    body && typeof body === "object" && !Array.isArray(body) ? body : { body };
  try {
    const run = (await triggerRun(tenant, name, input, {
      trigger: "webhook",
    })) as { run?: { metadata?: { id?: string } } };
    return c.json({ runId: run.run?.metadata?.id }, 202);
  } catch (error) {
    return fail(c, error);
  }
});

// --- Runtime routes (the worker only) ----------------------------------------

export const workflowRuntimeRoutes = createRouter();

const MAX_BUILD_ERROR_CHARS = 8000;
const GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1/ai"
).replace(/\/+$/, "");

/** The workspace a worker key belongs to, or null when the key is not one. */
async function workerWorkspaceId(c: Context): Promise<string | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer revops_")) return null;
  const keyHash = hashApiKey(header.substring(7));
  const workspace = await Workspace.findOne({ "apiKeys.keyHash": keyHash })
    .select("apiKeys workflows.enabled")
    .lean();
  const key = workspace?.apiKeys?.find(k => k.keyHash === keyHash);
  if (!workspace || !key || workspace.workflows?.enabled !== true) return null;
  const scopes = resolveWorkspaceApiKeyScopes(key.scopes);
  if (!hasWorkspaceApiKeyScope(scopes, "workflows:runtime")) return null;
  return workspace._id.toString();
}

// What the worker should run. It polls this: the commit to switch to, the
// preview commit if there is one, and the Hatchet token to connect with, so
// the worker holds one credential only.
workflowRuntimeRoutes.get("/head", async c => {
  const workspaceId = await workerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "Invalid worker key" }, 401);
  try {
    const [workspace, tenant] = await Promise.all([
      Workspace.findById(workspaceId)
        .select("workflows.target workflows.preview")
        .lean(),
      readWorkspaceTenant(workspaceId),
    ]);
    const preview = workspace?.workflows?.preview;
    return c.json({
      sha: workspace?.workflows?.target?.sha ?? null,
      tree: workspace?.workflows?.target?.tree ?? null,
      hatchetToken: tenant?.token ?? null,
      // Unmerged work to run next to the live code, or null.
      preview: preview ? { sha: preview.sha, tree: preview.tree } : null,
    });
  } catch (error) {
    return fail(c, error);
  }
});

// The worker reports each switch, for the live code or the preview: the
// commit it now runs, or the commit it could not start and why. This is what
// the UI shows as live and build error.
workflowRuntimeRoutes.post("/status", async c => {
  const workspaceId = await workerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "Invalid worker key" }, 401);
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
});

// `workflows/` at a commit, as a gzipped tarball. The key limits the worker to
// its own workspace's repository.
// Model calls from a step go through Mako to the AI gateway: the worker holds
// no provider key, and the call is checked against the workspace's plan and
// counted in its usage like a chat turn.
workflowRuntimeRoutes.post("/ai/*", async c => {
  const workspaceId = await workerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "Invalid worker key" }, 401);
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
  let res: Response;
  try {
    res = await fetch(
      `${GATEWAY_BASE_URL}/${c.req.path.split("/runtime/ai/")[1] ?? ""}`,
      { method: "POST", headers, body: await c.req.arrayBuffer() },
    );
  } catch (error) {
    logger.warn("Workflow model call failed", { workspaceId, error });
    return c.json({ error: "The AI gateway is unreachable" }, 502);
  }
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
      userId: "workflow",
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
});

workflowRuntimeRoutes.get("/source/:sha", async c => {
  try {
    const workspaceId = await workerWorkspaceId(c);
    if (!workspaceId) return c.json({ error: "Invalid worker key" }, 401);
    const sha = c.req.param("sha");
    if (!isOid(sha)) return c.json({ error: "Invalid commit" }, 400);
    // A fresh API instance has an empty disk: restore the repository and
    // this commit from the mirror before reading it.
    await ensureCommitLocally(workspaceId, sha);
    const repoDir = repoDirFor(workspaceId);
    if (!(await repoExists(repoDir))) {
      return c.json({ error: "The workspace has no repository" }, 404);
    }
    const tarball = await runGitBuffer([
      "-C",
      repoDir,
      "archive",
      "--format=tar.gz",
      sha,
      WORKFLOWS_DIR,
    ]);
    return new Response(new Uint8Array(tarball), {
      status: 200,
      headers: { "Content-Type": "application/gzip" },
    });
  } catch (error) {
    logger.warn("Workflow source fetch failed", { error });
    return c.json({ error: "No workflows/ folder at that commit" }, 404);
  }
});
