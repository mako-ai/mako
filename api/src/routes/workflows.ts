/**
 * Workflows — `/api/workspaces/:workspaceId/workflows` for people, and
 * `/api/workflows/runtime` for a workspace's worker
 * (docs/src/content/docs/workflows.md).
 *
 * Mako keeps no copy of workflows, runs or logs: those handlers read Hatchet
 * and return Hatchet's own response shapes. What Mako does keep is the deploy
 * state on the workspace: the commit the worker should run, the commit it
 * reports running, and the last build error.
 *
 * The runtime routes accept only a workspace API key carrying the
 * `workflows:runtime` scope, which a person cannot put on a key. The key
 * decides the workspace; no id is taken from the request.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Types } from "mongoose";

import { ensureCommitLocally } from "../apps/cloud-repo.service";
import { isOid, runGitBuffer } from "../apps/git";
import { repoDirFor, repoExists } from "../apps/repository.service";
import { hashApiKey } from "../auth/api-key.middleware";
import {
  hasWorkspaceApiKeyScope,
  resolveWorkspaceApiKeyScopes,
} from "../auth/api-key-scopes";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { workspaceService } from "../services/workspace.service";
import {
  HatchetError,
  isHatchetId,
  readWorkspaceTenant,
  runAction,
  resolveHatchetRead,
  tenantFetch,
  triggerRun,
  type WorkspaceTenant,
} from "../workflows/hatchet";
import { WORKFLOWS_DIR } from "../workflows/on-push";
import { readWorkflowsStatus } from "../workflows/status";

const logger = loggers.api("workflows");

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

/** The workspace's tenant, or a response saying why there is none. */
async function tenantOr(
  c: Context,
  workspaceId: string,
): Promise<WorkspaceTenant | Response> {
  const tenant = await readWorkspaceTenant(workspaceId);
  if (!tenant) {
    return c.json(
      {
        success: false,
        error: "Workflows are not set up for this workspace.",
      },
      404,
    );
  }
  return tenant;
}

/** Viewers read runs; starting, cancelling and replaying need a member. */
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
    summary: "Whether workflows are on, and which commit the worker runs",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        { success: true as const, ...(await readWorkflowsStatus(workspaceId)) },
        200,
      );
    } catch (error) {
      return fail(c, error);
    }
  },
);

// Allowlisted Hatchet reads, in Hatchet's own response shapes. The tenant and
// its token are added here; the caller cannot name either.
workflowRoutes.get("/hatchet/*", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const tenant = await tenantOr(c, workspaceId);
    if (tenant instanceof Response) return tenant;
    const subPath = c.req.path.split("/workflows/hatchet/")[1] ?? "";
    const target = resolveHatchetRead(subPath, tenant.tenantId);
    if (!target) {
      return c.json({ success: false, error: "Not found" }, 404);
    }
    const res = await tenantFetch(tenant, target, {
      query: new URL(c.req.url).searchParams,
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    return fail(c, error);
  }
});

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
      const tenant = await tenantOr(c, workspaceId);
      if (tenant instanceof Response) return tenant;
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

for (const action of ["cancel", "replay"] as const) {
  workflowRoutes.openapi(
    createRoute({
      method: "post",
      path: `/runs/{id}/${action}`,
      tags: ["Workflows"],
      summary: action === "cancel" ? "Cancel a run" : "Replay a run",
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
            { success: false, error: `Viewers cannot ${action} runs` },
            403,
          );
        }
        const tenant = await tenantOr(c, workspaceId);
        if (tenant instanceof Response) return tenant;
        const result = await runAction(tenant, action, id);
        return c.json({ success: true as const, result }, 200);
      } catch (error) {
        return fail(c, error);
      }
    },
  );
}

// --- Runtime routes (the worker only) ----------------------------------------

export const workflowRuntimeRoutes = createRouter();

const MAX_BUILD_ERROR_CHARS = 8000;

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
