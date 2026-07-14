/**
 * Apps v2 routes — git-backed apps (see apps-v2.md).
 *
 * Classification: Authenticated + workspace-scoped
 * (`unifiedAuthMiddleware` + workspace verification).
 *
 * Runs in PARALLEL with the v1 `/apps` routes. The durable store is the
 * workspace's linked GitHub repo (see /link, repo-binding.service); apps are
 * subdirectories in it, worked on inside E2B sandboxes. Always available (no
 * feature flag).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import {
  AppProjectV2,
  GitHubInstallation,
  type IAppProjectV2,
} from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { canReadResource, canWriteResource } from "../utils/resource-acl";
import {
  getGitHubAppSlug,
  getGitHubDevToken,
  isGitHubAppConfigured,
} from "../integrations/github/config";
import { isMakoCloudConfigured } from "../integrations/github/cloud-app-auth";
import {
  getInstallationToken,
  resolveRepoToken,
} from "../integrations/github/app-auth";
import {
  getRepoInfo,
  listInstallationRepos,
} from "../integrations/github/github-api";
import {
  getAppsRepoBinding,
  linkAppsRepo,
  unlinkAppsRepo,
} from "../apps-v2/repo-binding.service";
import {
  WorktreeConflictError,
  chatActorFor,
  chatBranchFor,
  commitWorktree,
  createProject,
  deleteProject,
  discardWorktree,
  ensureWorktree,
  execInWorktree,
  listBranches,
  listFiles,
  mergeBranchToMain,
  projectHistory,
  readFile,
  worktreeStatus,
  writeFile,
} from "../apps-v2/worktree.service";
import { APPS_V2_EXEC_MAX_TIMEOUT_MS } from "../apps-v2/config";
import {
  mintDevPreviewGrant,
  mintPreviewGrant,
} from "../apps-v2/preview.service";
import { ensureDevServer } from "../apps-v2/dev-server.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.api("apps-v2");

export const appsV2Routes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const ProjectParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

appsV2Routes.use("*", unifiedAuthMiddleware);

appsV2Routes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (workspace) {
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
    } else if (user) {
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    } else {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

function actingUserId(c: AuthenticatedContext): string | undefined {
  return c.get("user")?.id;
}

async function memberRoleFor(
  workspaceId: string,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const member = await workspaceService.getMember(workspaceId, userId);
  return member?.role;
}

async function loadProject(
  c: AuthenticatedContext,
  opts: { write: boolean },
): Promise<
  { project: IAppProjectV2; userId?: string } | { errorResponse: Response }
> {
  const workspaceId = c.req.param("workspaceId");
  const id = c.req.param("id");
  if (!id || !Types.ObjectId.isValid(id)) {
    return {
      errorResponse: c.json({ success: false, error: "Invalid app id" }, 400),
    };
  }
  const project = await AppProjectV2.findOne({
    _id: new Types.ObjectId(id),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!project) {
    return {
      errorResponse: c.json({ success: false, error: "App not found" }, 404),
    };
  }
  const userId = actingUserId(c);
  if (userId) {
    const role = await memberRoleFor(workspaceId, userId);
    const allowed = opts.write
      ? canWriteResource(project, userId, role)
      : canReadResource(project, userId, role);
    if (!allowed) {
      return {
        errorResponse: c.json({ success: false, error: "App not found" }, 404),
      };
    }
  }
  return { project, userId };
}

function toProjectJson(p: IAppProjectV2) {
  return {
    id: p._id.toString(),
    title: p.title,
    description: p.description,
    access: p.access,
    owner_id: p.owner_id,
    defaultBranch: p.defaultBranch,
    publishedSha: p.publishedSha,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function handleError(c: AuthenticatedContext, error: unknown) {
  if (error instanceof WorktreeConflictError) {
    return c.json({ success: false, error: error.message }, 409);
  }
  logger.error("Apps v2 route error", { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    },
    500,
  );
}

// ---------------------------------------------------------------------------
// Status probe — Apps v2 is always available (no feature flag). The frontend
// still calls this to learn readiness (later: whether the workspace has a
// GitHub repo linked). Registered before /:id so the param route can't shadow
// it.
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/status-probe",
    tags: ["Apps v2"],
    summary: "Apps v2 availability for this workspace",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const binding = await getAppsRepoBinding(workspaceId);
    return c.json(
      {
        success: true as const,
        enabled: true,
        linked: Boolean(binding),
        // Creation works without a linked repo when Mako-hosted cloud
        // storage is configured (per-app repos under MAKO_CLOUD_GITHUB_ORG).
        canCreate: Boolean(binding) || isMakoCloudConfigured(),
        repo: binding
          ? {
              owner: binding.owner,
              repo: binding.repo,
              defaultBranch: binding.defaultBranch,
              subdirectory: binding.subdirectory,
            }
          : null,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Repo linking — reuses the dbt GitHub App integration (installations, token
// minting, repo listing). A workspace must link a GitHub repo before creating
// apps; apps then live as subdirectories in it.
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/github-status",
    tags: ["Apps v2"],
    summary: "GitHub connectivity + current apps repo link",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const installations = await GitHubInstallation.find({
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .select("installationId accountLogin accountType repositorySelection")
      .lean();
    const binding = await getAppsRepoBinding(workspaceId);
    return c.json(
      {
        success: true as const,
        appConfigured: isGitHubAppConfigured(),
        appSlug: getGitHubAppSlug() ?? null,
        devTokenAvailable: Boolean(getGitHubDevToken()),
        installations,
        linkedRepo: binding ?? null,
      },
      200,
    );
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/github-repos",
    tags: ["Apps v2"],
    summary: "Repos an installation can access (for the link picker)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({ installationId: z.coerce.number().int() }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { installationId } = c.req.valid("query");
      const installation = await GitHubInstallation.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        installationId,
      });
      if (!installation) {
        return c.json({ success: false, error: "Installation not found" }, 404);
      }
      const token = await getInstallationToken(installationId);
      const repos = await listInstallationRepos(token);
      return c.json({ success: true as const, repos }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "delete",
    path: "/github-installations/{installationId}",
    tags: ["Apps v2"],
    summary: "Forget a GitHub App installation binding for this workspace",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({
        installationId: z.coerce
          .number()
          .int()
          .openapi({ param: { name: "installationId", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId, installationId } = c.req.valid("param");
    const user = c.get("user");
    // Same admin/owner bar as linking/reinstalling — this is local bookkeeping
    // only (it never calls GitHub's uninstall API); the doc lingering after a
    // real uninstall/reinstall on github.com is exactly the stale-binding bug
    // this lets an admin clear without DB access.
    if (user && !(await workspaceService.isAdmin(workspaceId, user.id))) {
      return c.json(
        {
          success: false,
          error: "Disconnecting GitHub requires the admin or owner role",
        },
        403,
      );
    }
    await GitHubInstallation.deleteOne({
      workspaceId: new Types.ObjectId(workspaceId),
      installationId,
    });
    return c.json({ success: true as const }, 200);
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/link",
    tags: ["Apps v2"],
    summary: "Link a GitHub repo for this workspace's apps",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              owner: z.string().min(1),
              repo: z.string().min(1),
              defaultBranch: z.string().optional(),
              subdirectory: z.string().optional(),
              installationId: z.number().int().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const user = c.get("user");
      // Linking is a workspace-config mutation → admin/owner only (matches
      // the dbt GitHub connect policy).
      if (user && !(await workspaceService.isAdmin(workspaceId, user.id))) {
        return c.json(
          {
            success: false,
            error: "Linking a repo requires the admin or owner role",
          },
          403,
        );
      }
      const body = c.req.valid("json");
      // Validate the repo is reachable + resolve its default branch when the
      // caller didn't pin one (reuses the dbt token resolver).
      const token = await resolveRepoToken(body.installationId);
      const info = await getRepoInfo(body.owner, body.repo, token);
      const binding = await linkAppsRepo({
        workspaceId,
        owner: body.owner,
        repo: body.repo,
        defaultBranch: body.defaultBranch || info.defaultBranch || "main",
        subdirectory: body.subdirectory,
        installationId: body.installationId,
        linkedBy: user?.id ?? "api-key",
      });
      return c.json({ success: true as const, repo: binding }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/unlink",
    tags: ["Apps v2"],
    summary: "Unlink the workspace's apps repo",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const user = c.get("user");
      if (user && !(await workspaceService.isAdmin(workspaceId, user.id))) {
        return c.json(
          {
            success: false,
            error: "Unlinking a repo requires the admin or owner role",
          },
          403,
        );
      }
      await unlinkAppsRepo(workspaceId);
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Apps v2"],
    summary: "List Apps v2 projects",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const userId = actingUserId(c);
      const role = await memberRoleFor(workspaceId, userId);
      const docs = await AppProjectV2.find({
        workspaceId: new Types.ObjectId(workspaceId),
      }).sort({ updatedAt: -1 });
      const visible = docs.filter(
        d => !userId || canReadResource(d, userId, role),
      );
      return c.json(
        { success: true as const, apps: visible.map(toProjectJson) },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Apps v2"],
    summary: "Create an Apps v2 project",
    description:
      "Creates the project record and its Mako-managed bare git repository seeded with a Vite + React scaffold.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              description: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { title, description } = c.req.valid("json");
      const userId = actingUserId(c);
      // Instant start: with no BYO repo linked, apps are stored in a
      // Mako-hosted cloud repo (per-project, under MAKO_CLOUD_GITHUB_ORG).
      // Only refuse when NEITHER path exists, so the failure stays actionable.
      const binding = await getAppsRepoBinding(workspaceId);
      if (!binding && !isMakoCloudConfigured()) {
        return c.json(
          {
            success: false,
            error:
              "No GitHub repo is linked and Mako Cloud storage is not configured. Link a repo (Settings → GitHub) or set MAKO_CLOUD_GITHUB_*.",
          },
          409,
        );
      }
      const project = await createProject({
        workspaceId,
        title,
        description,
        userId,
      });
      return c.json(
        { success: true as const, app: toProjectJson(project) },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Apps v2"],
    summary: "Get an Apps v2 project",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      return c.json(
        { success: true as const, app: toProjectJson(loaded.project) },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Apps v2"],
    summary: "Delete an Apps v2 project (repo included)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      await deleteProject(loaded.project);
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Files (durable reads; writes go through the actor's worktree)
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/files",
    tags: ["Apps v2"],
    summary: "List files (committed + uncommitted, sandbox-independent)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { ref, entries } = await listFiles(loaded.project, loaded.userId);
      return c.json({ success: true as const, ref, files: entries }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/file",
    tags: ["Apps v2"],
    summary: "Read a file at the actor's latest durable state",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ path: z.string().min(1) }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { path: relPath } = c.req.valid("query");
      try {
        const file = await readFile(loaded.project, relPath, loaded.userId);
        return c.json({ success: true as const, file }, 200);
      } catch {
        return c.json({ success: false, error: "File not found" }, 404);
      }
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/file",
    tags: ["Apps v2"],
    summary: "Write a file through the actor's worktree (flushes WIP ref)",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              path: z.string().min(1),
              contents: z.string(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = loaded.userId ?? "api-key";
      const { path: relPath, contents } = c.req.valid("json");
      const handle = await ensureWorktree(loaded.project, userId);
      const flush = await writeFile(handle, relPath, contents);
      return c.json({ success: true as const, flush }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/exec",
    tags: ["Apps v2"],
    summary: "Run a shell command in the actor's sandbox session",
    description:
      "Executes in the session working tree via the configured sandbox provider, then flushes the working tree to the durable WIP ref.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              command: z.string().min(1),
              cwd: z.string().optional(),
              timeoutMs: z
                .number()
                .int()
                .positive()
                .max(APPS_V2_EXEC_MAX_TIMEOUT_MS)
                .optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = loaded.userId ?? "api-key";
      const { command, cwd, timeoutMs } = c.req.valid("json");
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await execInWorktree(handle, command, { cwd, timeoutMs });
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Status / history / commit / discard
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/status",
    tags: ["Apps v2"],
    summary: "Worktree status (base, WIP, changed files)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = loaded.userId ?? "api-key";
      const status = await worktreeStatus(loaded.project, userId);
      return c.json({ success: true as const, status }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Apps v2"],
    summary: "Commit history of the default branch",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { limit } = c.req.valid("query");
      const commits = await projectHistory(loaded.project, limit ?? 20);
      return c.json({ success: true as const, commits }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/commit",
    tags: ["Apps v2"],
    summary: "Commit the actor's WIP onto the branch (CAS)",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ message: z.string().min(1) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = loaded.userId ?? "api-key";
      const { message } = c.req.valid("json");
      const user = c.get("user");
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await commitWorktree(
        handle,
        message,
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/branches",
    tags: ["Apps v2"],
    summary: "List branches (main + one per chat conversation)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const branches = await listBranches(loaded.project);
      return c.json({ success: true as const, branches }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/merge",
    tags: ["Apps v2"],
    summary: "Merge a branch into main (fast-forward or merge commit)",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ branch: z.string().min(1) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { branch } = c.req.valid("json");
      const user = c.get("user");
      const result = await mergeBranchToMain(
        loaded.project,
        branch,
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/preview",
    tags: ["Apps v2"],
    summary: "Build the app in its session and mint a preview link",
    description:
      "Runs `npm install` (when needed) and `npm run build` in the actor's sandbox session, then returns a short-lived token-gated URL serving the built dist/. The URL is cookie-free and meant for a sandboxed iframe. Pass `chatId` to build the conversation's `chat/<chatId>` branch instead of the caller's own worktree — the caller's own worktree always starts on main, so building it while a chat is actively working on this app previews stale, unrelated content.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ chatId: z.string().optional() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const chatId = c.req.valid("json")?.chatId;
      const handle = chatId
        ? await ensureWorktree(loaded.project, chatActorFor(chatId), {
            branch: chatBranchFor(chatId),
          })
        : await ensureWorktree(loaded.project, loaded.userId ?? "api-key");

      const install = await execInWorktree(
        handle,
        // Install only when node_modules is missing/stale-empty — repeat
        // previews stay fast on the warm session.
        "[ -d node_modules ] || npm install --no-audit --no-fund",
        { timeoutMs: 300_000 },
      );
      if (install.exitCode !== 0) {
        return c.json(
          {
            success: false,
            error: "npm install failed",
            stdout: install.stdout.slice(-4000),
            stderr: install.stderr.slice(-4000),
          },
          422,
        );
      }

      // --base=./ makes the emitted asset URLs relative so they resolve
      // under the token-prefixed preview path (works for apps whose
      // vite.config predates the scaffold's relative base too).
      const build = await execInWorktree(handle, "npm run build -- --base=./", {
        timeoutMs: 300_000,
      });
      if (build.exitCode !== 0) {
        return c.json(
          {
            success: false,
            error: "Build failed",
            stdout: build.stdout.slice(-4000),
            stderr: build.stderr.slice(-4000),
          },
          422,
        );
      }

      // npm install can leave a new/updated lockfile in the worktree (e.g.
      // the scaffold ships without one). Commit it immediately rather than
      // leaving it as WIP — every mutating action here should end in a real
      // commit, same as chat turns, not just an in-progress build.
      const user = c.get("user");
      await commitWorktree(
        handle,
        "chore: install dependencies",
        user?.email ? { name: user.email, email: user.email } : undefined,
      );

      const grant = mintPreviewGrant({
        workspaceId: loaded.project.workspaceId.toString(),
        projectId: loaded.project._id.toString(),
        rootDir: `${handle.sessionDir}/dist`,
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `/api/apps-v2-preview/${grant.token}/`,
          expiresAt: grant.expiresAt,
          buildOutput: build.stdout.slice(-2000),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/dev-preview",
    tags: ["Apps v2"],
    summary: "Start (or reuse) a live `vite dev` preview for this app",
    description:
      "Prototype of apps-v2.md §4.7's 'dev preview' tier — LOCAL SANDBOX PROVIDER ONLY (returns 501 under the e2b provider, whose public-URL exposure isn't built yet). Runs `npm install` if needed, starts a persistent `vite dev` process bound to the worktree's session directory, and returns a token-gated URL that proxies to it — HMR works, no rebuild step required as files change. Pass `chatId` for the same reason as POST /preview: your own worktree always starts on main.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ chatId: z.string().optional() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const chatId = c.req.valid("json")?.chatId;
      const handle = chatId
        ? await ensureWorktree(loaded.project, chatActorFor(chatId), {
            branch: chatBranchFor(chatId),
          })
        : await ensureWorktree(loaded.project, loaded.userId ?? "api-key");

      const install = await execInWorktree(
        handle,
        "[ -d node_modules ] || npm install --no-audit --no-fund",
        { timeoutMs: 300_000 },
      );
      if (install.exitCode !== 0) {
        return c.json(
          {
            success: false,
            error: "npm install failed",
            stdout: install.stdout.slice(-4000),
            stderr: install.stderr.slice(-4000),
          },
          422,
        );
      }

      let devPort: number;
      let devToken: string;
      try {
        ({ port: devPort, token: devToken } = await ensureDevServer(handle));
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to start dev server",
          },
          501,
        );
      }

      const grant = mintDevPreviewGrant({
        workspaceId: loaded.project.workspaceId.toString(),
        projectId: loaded.project._id.toString(),
        devPort,
        token: devToken,
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `/api/apps-v2-preview/${grant.token}/`,
          expiresAt: grant.expiresAt,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/discard",
    tags: ["Apps v2"],
    summary: "Discard all uncommitted work and re-base on branch head",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = loaded.userId ?? "api-key";
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await discardWorktree(handle);
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
