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
  Workspace,
  type IAppProjectV2,
} from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { canReadResource, canWriteResource } from "../utils/resource-acl";
import {
  getGitHubAppClientId,
  getGitHubAppSlug,
  getGitHubDevToken,
  isGitHubAppConfigured,
} from "../integrations/github/config";
import { isMakoCloudConfigured } from "../integrations/github/cloud-app-auth";
import { signInstallState } from "../integrations/github/install-state";
import {
  getInstallationToken,
  resolveRepoToken,
} from "../integrations/github/app-auth";
import {
  getRepoInfo,
  listInstallationRepos,
} from "../integrations/github/github-api";
import {
  connectWorkspaceRepo,
  disconnectWorkspaceRepo,
  listWorkspaceRepos,
} from "../services/workspace-repos.service";
import {
  ensureProjectRow,
  PUBLISH_ACTOR,
  WorktreeConflictError,
  autoCommitFileEdit,
  boxCtx,
  checkoutBranch,
  checkoutInBox,
  commitWorktree,
  createProject,
  defaultBranchSha,
  deleteProject,
  discardWorktree,
  ensureWorktree,
  execInWorktree,
  fileVersions,
  forgetBoxCaches,
  gitPathsAction,
  listAppFolders,
  listBranches,
  listFiles,
  mergeBranchToMain,
  projectHistory,
  promoteToMain,
  readFile,
  synthesizeProjectFromFolder,
  trialMerge,
  worktreeStatus,
  writeFile,
} from "../apps-v2/worktree.service";
import {
  APPS_V2_EXEC_MAX_TIMEOUT_MS,
  previewStagingDir,
} from "../apps-v2/config";
import { registerPublicShareRoutes } from "./lib/public-share-routes";
import {
  buildApp,
  buildLogPath,
  deployBuild,
  setPublishedSha,
  deploymentExists,
  serveDeploymentFile,
} from "../apps-v2/deployment.service";
import {
  adoptConnectedRepo,
  type ConnectedRepoAdoption,
  mirrorPushNow,
} from "../apps-v2/cloud-repo.service";
import { updateRefCas } from "../apps-v2/repository.service";
import fs from "node:fs/promises";
import { readBoxDir } from "../apps-v2/box";
import {
  mintPreviewGrant,
  mintPublishedGrant,
} from "../apps-v2/preview.service";
import {
  forgetTerminalCaches,
  killAllTerminalSessions,
  killTerminalSession,
} from "../apps-v2/terminal-ws";
import {
  devLogPath,
  devServerStatus,
  ensureDevServer,
  isServingApp,
  discoverDevServers,
  releaseDevServerSlot,
} from "../apps-v2/dev-server.service";
import { getBoxState, markBoxOffline } from "../apps-v2/box-state.service";
import { getSandboxProvider } from "../apps-v2/sandbox/provider";
import { Readable } from "node:stream";
import {
  bindingArtifactKeyByName,
  getBindingState,
  materializeAppV2Binding,
  readBindings,
} from "../apps-v2/bindings.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
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
  if (!id) {
    return {
      errorResponse: c.json({ success: false, error: "Invalid app id" }, 400),
    };
  }
  // Apps are addressable by SLUG as well as by id. The slug is the folder name
  // in the workspace repo (§10) — the real identity now that an app is a
  // directory rather than a document — and the filesystem already guarantees
  // it is unique, since two apps cannot occupy `apps/<slug>` at once. Ids
  // still resolve so existing links keep working.
  const project =
    (Types.ObjectId.isValid(id)
      ? await AppProjectV2.findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        })
      : await AppProjectV2.findOne({
          slug: id,
          workspaceId: new Types.ObjectId(workspaceId),
        })) ??
    // No row: the app may still exist as a folder in the repo. Opening one
    // must not require a database write, so it is synthesized instead —
    // a row appears only when someone restricts, publishes, or shares it.
    (await synthesizeProjectFromFolder(workspaceId, id));
  if (!project) {
    return {
      errorResponse: c.json({ success: false, error: "App not found" }, 404),
    };
  }
  const userId = actingUserId(c);
  if (userId) {
    const role = await memberRoleFor(workspaceId, userId);
    if (opts.write && !canWriteResource(project, userId, role)) {
      // Distinguish "can't touch it" from "doesn't exist". If the caller can
      // READ the app but not write it, a write-gated action (like starting a
      // dev preview) must NOT masquerade as "App not found" — the app is
      // right there in their list. Say it's read-only instead. Only when the
      // app is invisible to them too do we fall through to the 404, which
      // deliberately does not reveal that a private app exists.
      if (canReadResource(project, userId, role)) {
        return {
          errorResponse: c.json(
            {
              success: false,
              error:
                "You have read-only access to this app. Ask an editor or the owner to run it in dev mode (or to share edit access with you).",
            },
            403,
          ),
        };
      }
      return {
        errorResponse: c.json({ success: false, error: "App not found" }, 404),
      };
    }
    if (!opts.write && !canReadResource(project, userId, role)) {
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
    slug: p.slug,
    title: p.title,
    description: p.description,
    access: p.access,
    owner_id: p.owner_id,
    defaultBranch: p.defaultBranch,
    publishedSha: p.publishedSha,
    publishedAt: p.publishedAt,
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
    // The rollout flag, per workspace (Settings › Super Admin › Feature
    // flags). Off = the rail entry and everything behind it stay hidden.
    const workspace = await Workspace.findById(workspaceId)
      .select("settings.appsV2Enabled")
      .lean();
    const enabled = workspace?.settings?.appsV2Enabled === true;
    const repos = enabled ? await listWorkspaceRepos(workspaceId) : [];
    return c.json(
      {
        success: true as const,
        enabled,
        linked: repos.length > 0,
        // Creation works without a connected repo when Mako-hosted cloud
        // storage is configured (per-app repos under MAKO_CLOUD_GITHUB_ORG).
        canCreate: repos.length > 0 || isMakoCloudConfigured(),
        repos: repos.map(r => ({
          owner: r.owner,
          repo: r.repo,
          defaultBranch: r.defaultBranch,
          subdirectory: r.subdirectory,
          installationId: r.installationId,
        })),
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
    const repos = await listWorkspaceRepos(workspaceId);
    return c.json(
      {
        success: true as const,
        appConfigured: isGitHubAppConfigured(),
        appSlug: getGitHubAppSlug() ?? null,
        devTokenAvailable: Boolean(getGitHubDevToken()),
        installations,
        repos,
      },
      200,
    );
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/github-sync-url",
    tags: ["Apps v2"],
    summary: "URL that syncs the user's existing GitHub App installations",
    description:
      "Starts GitHub's user-authorization OAuth flow. GitHub never fires the install callback for an account where the app is already installed, so already-installed accounts can only be (re)bound by authorizing and listing the installations the user controls.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const user = c.get("user");
    if (!user || !(await workspaceService.isAdmin(workspaceId, user.id))) {
      return c.json(
        {
          success: false,
          error: "Connecting GitHub requires the admin or owner role",
        },
        403,
      );
    }
    const clientId = getGitHubAppClientId();
    if (!clientId) {
      return c.json(
        {
          success: false,
          error:
            "GitHub App OAuth client is not configured (GITHUB_APP_CLIENT_ID)",
        },
        400,
      );
    }
    const state = signInstallState({
      workspaceId,
      userId: user.id,
      clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
    });
    // No redirect_uri: GitHub falls back to the app's registered callback
    // URL, and the cross-environment relay on /api/github/setup bounces the
    // callback home to whichever environment minted this state.
    return c.json(
      {
        success: true as const,
        url: `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}`,
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
      const binding = await connectWorkspaceRepo({
        workspaceId,
        owner: body.owner,
        repo: body.repo,
        defaultBranch: body.defaultBranch || info.defaultBranch || "main",
        subdirectory: body.subdirectory,
        installationId: body.installationId,
        linkedBy: user?.id ?? "api-key",
      });
      // §13.17: the connected repo IS the durable mirror. Reconcile it with
      // any existing workspace history now — import, seed, or refuse — and
      // roll the binding back if reconciliation refuses, so pushes never
      // target a repo we did not adopt.
      let adoption: ConnectedRepoAdoption;
      try {
        adoption = await adoptConnectedRepo(workspaceId, {
          owner: binding.owner,
          repo: binding.repo,
          installationId: binding.installationId,
        });
      } catch (error) {
        await disconnectWorkspaceRepo(
          workspaceId,
          binding.owner,
          binding.repo,
        ).catch(() => undefined);
        throw error;
      }
      return c.json({ success: true as const, repo: binding, adoption }, 200);
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
    summary: "Disconnect a workspace repo",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              owner: z.string().min(1),
              repo: z.string().min(1),
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
      if (user && !(await workspaceService.isAdmin(workspaceId, user.id))) {
        return c.json(
          {
            success: false,
            error: "Disconnecting a repo requires the admin or owner role",
          },
          403,
        );
      }
      const body = c.req.valid("json");
      await disconnectWorkspaceRepo(workspaceId, body.owner, body.repo);
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

      // The REPO is the list. An app exists because `apps/<name>/mako.json`
      // exists, so a folder pushed from a local checkout shows up with no
      // registration step (§13). Mongo is consulted only for what cannot live
      // in a repo the customer can clone: visibility, the deployed sha, and
      // the share token.
      const folders = await listAppFolders(workspaceId);
      const docs = await AppProjectV2.find({
        workspaceId: new Types.ObjectId(workspaceId),
      });
      const stateBySlug = new Map(
        docs.filter(d => d.slug).map(d => [d.slug as string, d]),
      );

      const apps = folders
        .filter(folder => {
          const state = stateBySlug.get(folder.slug);
          // No record yet means nothing has restricted it — a folder someone
          // pushed is workspace content, visible like any other file in the
          // repo.
          if (!state) return true;
          return !userId || canReadResource(state, userId, role);
        })
        .map(folder => {
          const state = stateBySlug.get(folder.slug);
          return {
            id: state?._id.toString() ?? folder.slug,
            slug: folder.slug,
            title: folder.title,
            description: folder.description,
            access: state?.access ?? "workspace",
            publishedSha: state?.publishedSha,
            publishedAt: state?.publishedAt,
          };
        });

      return c.json({ success: true as const, apps }, 200);
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
      // Instant start: with no repo connected, apps are stored in a
      // Mako-hosted cloud repo (per-project, under MAKO_CLOUD_GITHUB_ORG).
      // Only refuse when NEITHER path exists, so the failure stays actionable.
      const repos = await listWorkspaceRepos(workspaceId);
      if (repos.length === 0 && !isMakoCloudConfigured()) {
        return c.json(
          {
            success: false,
            error:
              "No GitHub repo is connected and Mako Cloud storage is not configured. Connect a repo (Settings → GitHub) or set MAKO_CLOUD_GITHUB_*.",
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
    summary: "List files (committed + uncommitted)",
    description:
      "Lists the sandbox's working copy when it is running — so a file created in the terminal is simply there — and the last commit on the branch when it is not. Asking which is deliberately a question that does not start a sandbox: browsing must not boot a microVM.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ live: z.string().optional() }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const listing = await listFiles(loaded.project, loaded.userId);
      return c.json(
        {
          success: true as const,
          ref: listing.ref,
          files: listing.entries,
          // Honest ceilings: a 100k-file folder reports "first N of M"
          // instead of shipping a response the client dies rendering.
          truncated: listing.truncated,
          total: listing.total,
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
      const user = c.get("user");
      const handle = await ensureWorktree(loaded.project, userId);
      const flush = await writeFile(handle, relPath, contents);
      // §10 Block A: manual saves auto-commit — no staged state in the UI.
      const commit = await autoCommitFileEdit(
        handle,
        relPath,
        "edit",
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      return c.json({ success: true as const, flush, commit }, 200);
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
    description:
      "Reads the sandbox's working copy when it is running — including uncommitted and shell-made changes — and the last commit on the branch when it is not (reported as `offline`). Never starts a sandbox.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ live: z.string().optional() }),
    },
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
    summary: "Commit history of a branch (defaults to the default branch)",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        ref: z.string().max(200).optional(),
        scope: z.enum(["app", "repo"]).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { limit, ref, scope } = c.req.valid("query");
      const commits = await projectHistory(
        loaded.project,
        limit ?? 20,
        ref,
        scope ?? "app",
      );
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
            schema: z.object({
              message: z.string().min(1),
              /** Commit only the index (VS Code with a non-empty Staged group). */
              stagedOnly: z.boolean().optional(),
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
      const { message, stagedOnly } = c.req.valid("json");
      const user = c.get("user");
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await commitWorktree(
        handle,
        message,
        user?.email ? { name: user.email, email: user.email } : undefined,
        { stagedOnly },
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Per-file git actions (VS Code's Source Control view)
// ---------------------------------------------------------------------------

const RepoPaths = z.object({
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine(
          p => !p.startsWith("/") && !p.split("/").includes(".."),
          "path must stay inside the repository",
        ),
    )
    .min(1)
    .max(500),
});

for (const action of ["stage", "unstage", "discard"] as const) {
  appsV2Routes.openapi(
    createRoute({
      method: "post",
      path: `/{id}/git/${action}`,
      tags: ["Apps v2"],
      summary:
        action === "stage"
          ? "Stage files for commit (git add)"
          : action === "unstage"
            ? "Unstage files (git reset HEAD --)"
            : "Discard working-tree changes to files (checkout / clean)",
      description:
        "Repo-relative paths. The box's fresh status is pushed to every open window right after, so the Source Control view updates at once.",
      security: AUTH_SECURITY,
      request: {
        params: ProjectParam,
        body: { content: { "application/json": { schema: RepoPaths } } },
      },
      responses: OPEN_RESPONSES,
    }),
    async c => {
      try {
        const loaded = await loadProject(c, { write: true });
        if ("errorResponse" in loaded) return loaded.errorResponse;
        const { paths } = c.req.valid("json");
        const handle = await ensureWorktree(
          loaded.project,
          loaded.userId ?? "api-key",
        );
        await gitPathsAction(handle, action, paths);
        return c.json({ success: true as const }, 200);
      } catch (error) {
        return handleError(c, error);
      }
    },
  );
}

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/file-versions",
    tags: ["Apps v2"],
    summary: "HEAD, index and working-tree contents of a repo path (for diffs)",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            p => !p.startsWith("/") && !p.split("/").includes(".."),
            "path must stay inside the repository",
          ),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { path: relPath } = c.req.valid("query");
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const versions = await fileVersions(handle, relPath);
      return c.json({ success: true as const, versions }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings",
    tags: ["Apps v2"],
    summary: "List the app's data bindings (front matter + build state)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const bindings = await readBindings(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const projectId = loaded.project._id.toString();
      const out = [];
      for (const b of bindings) {
        const state = await getBindingState(projectId, b.name);
        out.push({
          name: b.name,
          connectionId: b.connectionId,
          schedule: b.schedule ?? null,
          lastMaterializedAt: state?.lastMaterializedAt ?? null,
          rowCount: state?.lastRowCount ?? null,
          history: state?.history ?? [],
        });
      }
      return c.json({ success: true as const, bindings: out }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings/{name}/artifact",
    tags: ["Apps v2"],
    summary: "Stream a binding's materialized parquet artifact",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { name } = c.req.valid("param");
      if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)) {
        return c.json({ success: false, error: "Invalid binding name" }, 400);
      }
      const store = getDashboardArtifactStore();
      const key = await bindingArtifactKeyByName(
        loaded.project,
        name,
        loaded.userId ?? "",
      );
      const stream = key ? await store.openReadStream(key) : null;
      if (!key || !stream) {
        return c.json(
          { success: false, error: `Binding "${name}" is not materialized` },
          404,
        );
      }
      const size = await store.getSize(key);
      return new Response(
        Readable.toWeb(stream as Readable) as ReadableStream,
        {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apache.parquet",
            ...(size !== null ? { "Content-Length": String(size) } : {}),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{name}/materialize",
    tags: ["Apps v2"],
    summary: "Materialize a data binding (bindings-as-files) to parquet",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { name } = c.req.valid("param");
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const result = await materializeAppV2Binding(
        loaded.project,
        name,
        loaded.userId ?? "api-key",
      );
      return c.json({ success: true as const, ...result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/checkout",
    tags: ["Apps v2"],
    summary: "Switch the caller's worktree to another branch (or create one)",
    description:
      "The same thing `git checkout` (or `git checkout -b` with create) in the terminal does, offered as a button — and it goes through the sandbox, so both agree afterwards. Refuses with uncommitted work rather than choosing between carrying it across and discarding it.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              branch: z.string().min(1).max(200),
              create: z.boolean().optional(),
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
      const { branch, create } = c.req.valid("json");
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const result = await checkoutBranch(handle, branch, { create });
      return c.json({ success: true as const, ...result }, 200);
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
    summary: "List branches",
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
      "Runs `npm install` (when needed) and `npm run build` in the actor's sandbox session, then returns a short-lived token-gated URL serving the built dist/. The URL is cookie-free and meant for a sandboxed iframe.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({}),
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
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );

      // Same build as a publish would run: the whole point of previewing a
      // build is that it is the same artifact, produced the same way.
      const build = await buildApp(handle, execInWorktree);
      if (!build.ok) {
        return c.json(
          { success: false, error: "Build failed", output: build.output },
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

      // The build output is in the sandbox; the static preview server reads
      // from disk. Stage just `dist/` out to a deterministic directory, which
      // the next build overwrites — the API keeps no working copy, only this
      // narrow, disposable artifact.
      const staging = previewStagingDir(loaded.project._id.toString());
      await fs.rm(staging, { recursive: true, force: true });
      await readBoxDir(boxCtx(handle), `${handle.appRoot}/dist`, staging);

      const grant = mintPreviewGrant({
        workspaceId: loaded.project.workspaceId.toString(),
        projectId: loaded.project._id.toString(),
        rootDir: staging,
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `/api/apps-v2-preview/${grant.token}/`,
          expiresAt: grant.expiresAt,
          buildOutput: build.output.slice(-2000),
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
      "Live dev preview (apps-v2.md §12.4). Runs `npm install` if needed, starts a persistent `vite dev` inside the app's sandbox, and returns the sandbox's own public origin for the browser to iframe — HMR rides that origin, so edits show up with no rebuild step and nothing of the tenant's runs on the API host.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              restart: z
                .boolean()
                .optional()
                .describe(
                  "Stop the running server first and boot a fresh one " +
                    "(new launcher, clean state). Without it a running " +
                    "server is reused.",
                ),
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
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const body = (await c.req.json().catch(() => ({}))) as {
        restart?: boolean;
      };
      const restart = body?.restart === true;

      // Reattach (page reload, second tab): the server is already serving
      // this app, so leave the boot log alone — it holds the real boot's
      // output, and this call will not write a new one.
      if (!(await isServingApp(handle))) {
        // Everything the boot does goes to ONE log the client tails live —
        // starting with a truncate, so this boot's output is this boot's.
        // The install pipes through tee rather than redirecting so its
        // output still comes back in the exec result for the failure
        // payload.
        const logPath = devLogPath(handle);
        const install = await execInWorktree(
          handle,
          `: > ${logPath}; printf '=== mako dev boot: cd ${handle.appRoot} && vite (Mako launcher: bindings + eyes + HMR host) ===\\n\\n' >> ${logPath}; set -o pipefail; ( [ -d node_modules ] || npm install --no-audit --no-fund ) 2>&1 | tee -a ${logPath}`,
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
      }

      // §12.4: vite runs inside the sandbox and E2B publishes the port, so
      // the browser loads it directly — there is no Mako-side proxy or token
      // to mint for this tier.
      try {
        const { url, stagedBindings, evicted } = await ensureDevServer(handle, {
          restart,
        });
        return c.json(
          { success: true as const, url, stagedBindings, evicted },
          200,
        );
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to start dev server",
          },
          500,
        );
      }
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-servers",
    tags: ["Apps v2"],
    summary: "Slugs of apps with a live dev-server session",
    description:
      "Discovery for the sidebar's running indicators: one cheap exec listing the dev-session sockets. Never creates a sandbox; empty when none is running.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const ctx = boxCtx(handle);
      // Snapshot first: the box's agent pushed this; no exec.
      const snapshot = await getBoxState(ctx.sessionKey);
      const running = snapshot?.devServers
        ? snapshot.devServers.map(d => d.slug)
        : (await discoverDevServers(ctx)).map(d => d.slug);
      return c.json({ success: true as const, running }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/sandbox",
    tags: ["Apps v2"],
    summary: "The workspace sandbox: identity, uptime, sessions, resources",
    description:
      "One (workspace, user) has one sandbox; any app id reaches it. Stats come from one exec inside the box (with a 1s CPU sample). Never creates a sandbox: running=false when there is none.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const provider = getSandboxProvider();
      const ctx = boxCtx(handle);
      const info = (await provider.describe?.(ctx)) ?? null;
      if (!info) {
        return c.json({ success: true as const, running: false }, 200);
      }
      const stats = await provider.exec(
        ctx,
        `echo "UPTIME=$(cut -d' ' -f1 /proc/uptime)"; ` +
          `echo "CORES=$(nproc)"; ` +
          `echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg)"; ` +
          `free -b | awk '/^Mem:/{print "MEM_TOTAL="$2; print "MEM_USED="$3}'; ` +
          `df -B1 / | awk 'NR==2{print "DISK_TOTAL="$2; print "DISK_USED="$3}'; ` +
          `echo "SESSIONS=$(ls /tmp/mako-term-*.sock 2>/dev/null | wc -l)"; ` +
          `A=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8" "$5}' /proc/stat); sleep 1; ` +
          `B=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8" "$5}' /proc/stat); ` +
          `echo "$A $B" | awk '{t=$3-$1; i=$4-$2; if (t>0) printf "CPU_PCT=%.1f\n", 100*(t-i)/t; else print "CPU_PCT=0"}'`,
        { timeoutMs: 30_000 },
      );
      const fields: Record<string, string> = {};
      for (const line of stats.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
      }
      return c.json(
        {
          success: true as const,
          running: true,
          sandboxId: info.sandboxId,
          startedAt: info.startedAt,
          uptimeSec: Number(fields.UPTIME) || 0,
          cores: Number(fields.CORES) || 0,
          load: fields.LOAD ?? "",
          cpuPct: Number(fields.CPU_PCT) || 0,
          memTotal: Number(fields.MEM_TOTAL) || 0,
          memUsed: Number(fields.MEM_USED) || 0,
          diskTotal: Number(fields.DISK_TOTAL) || 0,
          diskUsed: Number(fields.DISK_USED) || 0,
          sessions: Number(fields.SESSIONS) || 0,
          connectCommand: `e2b sandbox connect ${info.sandboxId}`,
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
    path: "/{id}/sandbox/recycle",
    tags: ["Apps v2"],
    summary: "Kill the workspace sandbox; the next touch builds a fresh one",
    description:
      "Committed work is safe by design (it lives in the repo); uncommitted working-copy changes and running processes die with the machine — the same contract as losing a laptop.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const ctx = boxCtx(handle);
      await getSandboxProvider().destroySession?.(ctx.sessionKey);
      // The machine is gone; so is everything the API believed about it.
      forgetBoxCaches(ctx.sessionKey);
      forgetTerminalCaches(ctx.sessionKey);
      // Tell every open tab NOW, so a second browser drops its dead sandbox
      // URL instead of waiting for a poll to fail or the cache TTL to lapse.
      await markBoxOffline(
        loaded.project.workspaceId.toString(),
        loaded.userId ?? "api-key",
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/terminal-sessions",
    tags: ["Apps v2"],
    summary: "Kill ALL terminal sessions for this user's box",
    description:
      "What leaving dev mode means: every bash shell and this app's dev session die (ptys, dtach sessions, recordings), so re-entering dev starts from one fresh terminal instead of reattaching old ones. Other apps' dev sessions are untouched. Idempotent.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      await killAllTerminalSessions(
        loaded.project,
        loaded.userId ?? "api-key",
        loaded.project.slug ?? null,
      );
      // Free the dev-server port registration too — the kill stops the
      // process, but a dead registry entry would retire its port forever
      // (§13.20).
      await releaseDevServerSlot(
        loaded.project.workspaceId.toString(),
        loaded.userId ?? "api-key",
        loaded.project.slug ?? null,
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/terminal-sessions/{termId}",
    tags: ["Apps v2"],
    summary: "Kill a terminal session — pty, dtach/tmux session, recording",
    description:
      "What closing a terminal tab means: the remote counterpart dies too. Idempotent; a session that is already gone is a success.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        termId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { termId } = c.req.valid("param");
      await killTerminalSession(
        loaded.project,
        loaded.userId ?? "api-key",
        termId,
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-preview/status",
    tags: ["Apps v2"],
    summary: "Is the app's dev server session serving right now?",
    description:
      "Cheap truth for the workbench: the session socket AND the port, not client-side state. Never starts a sandbox. Lets the UI notice a server stopped from inside its own terminal (Ctrl-C) and flip to the launch state.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const status = await devServerStatus(handle);
      return c.json({ success: true as const, ...status }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-preview/log",
    tags: ["Apps v2"],
    summary: "Tail the dev-session boot log (npm install + vite output)",
    description:
      "Returns the sandbox's real boot output from `offset` onward, plus the log's current size for the next poll. This is what the boot screen shows — the actual output, not a stand-in. Never starts a sandbox; with none running it returns an empty chunk.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ offset: z.coerce.number().int().min(0).default(0) }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { offset } = c.req.valid("query");
      const handle = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const ctx = boxCtx(handle);
      if (!(await getSandboxProvider().hasSession(ctx))) {
        return c.json({ success: true as const, size: 0, chunk: "" }, 200);
      }
      const result = await getSandboxProvider().exec(
        ctx,
        // Size first, then the requested slice, capped so one poll can never
        // exceed the provider's output budget.
        `wc -c < ${devLogPath(handle)} 2>/dev/null || echo 0; tail -c +${offset + 1} ${devLogPath(handle)} 2>/dev/null | head -c 65536`,
        { timeoutMs: 15_000 },
      );
      const newline = result.stdout.indexOf("\n");
      const size = Number(result.stdout.slice(0, newline).trim()) || 0;
      const chunk = result.stdout.slice(newline + 1);
      return c.json({ success: true as const, size, chunk }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/build/log",
    tags: ["Apps v2"],
    summary: "Tail the publish/preview build log (npm install + build output)",
    description:
      "Returns the sandbox's live build output from `offset` onward, plus the log's current size for the next poll — what the Publish button streams so you can watch the build run. Never starts a sandbox.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ offset: z.coerce.number().int().min(0).default(0) }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { offset } = c.req.valid("query");
      // The build runs in the shared PUBLISH_ACTOR box (not the user's dev
      // box), so its log lives there — tail that one, or the client watches an
      // empty file in the wrong sandbox.
      const handle = await ensureWorktree(loaded.project, PUBLISH_ACTOR);
      const ctx = boxCtx(handle);
      if (!(await getSandboxProvider().hasSession(ctx))) {
        return c.json({ success: true as const, size: 0, chunk: "" }, 200);
      }
      const result = await getSandboxProvider().exec(
        ctx,
        `wc -c < ${buildLogPath(handle)} 2>/dev/null || echo 0; tail -c +${offset + 1} ${buildLogPath(handle)} 2>/dev/null | head -c 65536`,
        { timeoutMs: 15_000 },
      );
      const newline = result.stdout.indexOf("\n");
      const size = Number(result.stdout.slice(0, newline).trim()) || 0;
      const chunk = result.stdout.slice(newline + 1);
      return c.json({ success: true as const, size, chunk }, 200);
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

// ---------------------------------------------------------------------------
// Publishing (§13.3): merge → build from main → immutable artifact → repoint
// ---------------------------------------------------------------------------

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/publish",
    tags: ["Apps v2"],
    summary: "Publish the app: merge to main, build, and deploy",
    description:
      "Merges `branch` (defaulting to the caller's own branch) into main, builds from main in the sandbox, uploads the output as an immutable deployment keyed by commit sha, and points the app at it. A failed build leaves the previous deployment serving. Re-publishing an unchanged sha reuses the existing deployment instead of rebuilding.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              branch: z.string().optional(),
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
      // Publishing is one of the three acts that give a folder-only app a
      // database row (§13.6) — without this, `setPublishedSha` below is an
      // updateOne against an _id that does not exist: the response says
      // published, nothing persists, and a reload shows "not published".
      loaded.project = await ensureProjectRow(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const body = c.req.valid("json") ?? {};
      const user = c.get("user");
      // Publishing means "ship MY work" — the branch the caller is actually
      // on (their worktree doc remembers it; checkout keeps it current),
      // not a computed name. On main, publish simply builds main's head.
      const callerWorktree = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const branch = body.branch ?? callerWorktree.doc.branch;

      const handle = await ensureWorktree(loaded.project, PUBLISH_ACTOR, {
        branch: loaded.project.defaultBranch || "main",
      });

      // Compare-and-swap against the main this publish started from, so two
      // publishes racing each other fail cleanly instead of interleaving.
      const expectedMain = await defaultBranchSha(loaded.project);
      const trial = await trialMerge(
        handle,
        branch ?? (loaded.project.defaultBranch || "main"),
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      if (!trial.ok) {
        return c.json({ success: false, error: trial.reason }, 409);
      }
      const sha = trial.sha;

      // Move main to the merge NOW and mirror it, BEFORE building. The build
      // target is then a real, durable, fetchable ref — not a dangling commit
      // that a fresh serverless instance (its repo is a cache of the mirror)
      // has never seen, which is what broke publishing under load with
      // "upload-pack: not our ref". Advancing main to not-yet-built code is
      // safe: production is `publishedSha`, which only ever moves to a
      // SUCCESSFUL build — so a failed build leaves the live app untouched and
      // just shows main ahead of what is deployed. (apps-v2.md §13.3.1)
      try {
        await promoteToMain(handle, { sha, expectedMain });
      } catch {
        return c.json(
          {
            success: false,
            error:
              "main moved while this publish was running — nothing shipped. Try again.",
          },
          409,
        );
      }
      try {
        await mirrorPushNow(loaded.project.workspaceId.toString());
      } catch (pushError) {
        // main advanced locally but the durable push (to the git mirror)
        // failed — bad credentials, GitHub down, a rejected ref. Roll main
        // back to where it was so the local repo and the durable store agree:
        // otherwise a serverless instance recycle would restore from the
        // (unchanged) mirror and silently "lose" this commit, and the sandbox
        // could no longer fetch it ("not our ref"). Nothing published; retry.
        await updateRefCas(
          handle.repoDir,
          `refs/heads/${loaded.project.defaultBranch || "main"}`,
          expectedMain,
          sha,
        ).catch(() => undefined);
        return c.json(
          {
            success: false,
            error:
              "Could not save the change durably — the push to the git mirror failed, so nothing was published. Try again.",
            output:
              pushError instanceof Error
                ? pushError.message
                : String(pushError),
          },
          502,
        );
      }

      if (await deploymentExists(loaded.project._id.toString(), sha)) {
        await setPublishedSha(loaded.project, sha);
        return c.json(
          { success: true as const, sha, fileCount: 0, reused: true },
          200,
        );
      }

      // Build main (now a durable ref) and deploy on success.
      await checkoutInBox(handle, sha);
      const build = await buildApp(handle, execInWorktree);
      if (!build.ok) {
        return c.json(
          {
            success: false,
            error:
              "Build failed — main was updated but nothing was deployed; the live app still serves the last successful build.",
            output: build.output,
          },
          422,
        );
      }

      const result = await deployBuild(loaded.project, sha, handle);

      return c.json(
        {
          success: true as const,
          sha: result.sha,
          fileCount: result.fileCount,
          reused: result.reused,
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
    path: "/{id}/rollback",
    tags: ["Apps v2"],
    summary: "Point the app at a previously published deployment",
    description:
      "Deployments are immutable and addressed by commit sha, so rolling back is a repoint — no rebuild and no sandbox. The target sha must still have a stored deployment.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ sha: z.string().min(7) }),
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
      const { sha } = c.req.valid("json");
      const projectId = loaded.project._id.toString();
      if (!(await deploymentExists(projectId, sha))) {
        return c.json(
          {
            success: false,
            error: `No stored deployment for ${sha.slice(0, 7)}`,
          },
          404,
        );
      }
      await setPublishedSha(loaded.project, sha);
      return c.json({ success: true as const, sha }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Viewing a published app (§13.2)
// ---------------------------------------------------------------------------

/**
 * Serve the published deployment to a workspace user.
 *
 * Deliberately does NOT call ensureWorktree: viewing must never start a
 * sandbox, or a hundred readers become a hundred microVMs. Everything here
 * comes from the artifact store.
 *
 * `__data/<name>.parquet` resolves to the app's materialized binding for the
 * same project, authorized by the caller's normal workspace access — the
 * published counterpart to the preview's token-gated data path.
 */
async function serveLive(c: AuthenticatedContext): Promise<Response> {
  const loaded = await loadProject(c, { write: false });
  if ("errorResponse" in loaded) return loaded.errorResponse;
  const project = loaded.project;
  const sha = project.publishedSha;
  if (!sha) {
    return c.json(
      { success: false, error: "This app has not been published yet" },
      404,
    );
  }
  const projectId = project._id.toString();
  // Split on the id EXACTLY AS THE CALLER WROTE IT. Splitting on the project's
  // Mongo id broke the moment apps became addressable by folder name: the
  // marker never matched, so every asset request fell through to the SPA
  // fallback and the page silently served index.html as its own JavaScript.
  const ref = c.req.param("id") ?? projectId;
  const marker = `/apps-v2/${ref}/live`;
  const at = c.req.path.indexOf(marker);
  const rest = at === -1 ? "" : c.req.path.slice(at + marker.length);

  const response = await serveDeploymentFile({
    projectId,
    sha,
    assetPath: rest.replace(/^\/+/, ""),
  });
  return response ?? c.json({ success: false, error: "Not found" }, 404);
}

appsV2Routes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/view-token",
    tags: ["Apps v2"],
    summary: "Mint a cookie-free token for the published app",
    description:
      "Viewing a published app happens in a sandboxed, opaque-origin iframe, and ES modules are always fetched in CORS mode WITHOUT credentials — so a cookie-authorized URL 401s there however well it works in a normal tab, and the app renders nothing. This returns the same kind of short-lived token the build preview uses, authorized here by the caller's workspace access. It starts no sandbox: the bytes come from the deployment store.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const sha = loaded.project.publishedSha;
      if (!sha) {
        return c.json(
          { success: false, error: "This app has not been published yet" },
          404,
        );
      }
      const grant = mintPublishedGrant({
        workspaceId: loaded.project.workspaceId.toString(),
        projectId: loaded.project._id.toString(),
        sha,
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `/api/apps-v2-preview/${grant.token}/`,
          sha,
          expiresAt: grant.expiresAt,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsV2Routes.get("/:id/live", serveLive);
appsV2Routes.get("/:id/live/*", serveLive);

// Public-link sharing, reusing the exact primitive dashboards and v1 apps use
// (bcrypt password + AES copy for reveal, token rotation, owner/admin gate).
// The anonymous consumption side lives in routes/public-share.ts.
registerPublicShareRoutes(appsV2Routes, {
  resourceName: "App",
  load: async c => {
    const id = c.req.param("id");
    const workspaceId = c.req.param("workspaceId");
    if (!id || !workspaceId) return null;
    const ref = id.replace(/^apps\//, "");
    const existing = Types.ObjectId.isValid(ref)
      ? await AppProjectV2.findOne({
          _id: new Types.ObjectId(ref),
          workspaceId: new Types.ObjectId(workspaceId),
        })
      : await AppProjectV2.findOne({
          slug: ref,
          workspaceId: new Types.ObjectId(workspaceId),
        });
    if (existing) return existing;

    // Sharing is one of the three things that gives an app a database row
    // (§13.6) — a share token and its password hash cannot live in a repo the
    // customer can clone. So if the app exists only as a folder, materialize
    // the row now, with the id derived from (workspace, folder) so every
    // artifact key stays stable.
    const folder = await synthesizeProjectFromFolder(workspaceId, ref);
    if (!folder) return null;
    return ensureProjectRow(folder, actingUserId(c) ?? "");
  },
  getTitle: doc => (doc as unknown as IAppProjectV2).title,
});
