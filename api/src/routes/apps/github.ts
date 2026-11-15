/**
 * Repo linking for Apps: availability probe, GitHub App installations, and
 * linking / unlinking the workspace repo the apps live in.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { GitHubInstallation } from "../../database/workspace-schema";
import { workspaceService } from "../../services/workspace.service";
import {
  getGitHubAppClientId,
  getGitHubAppSlug,
  getGitHubDevToken,
  isGitHubAppConfigured,
} from "../../integrations/github/config";
import { signInstallState } from "../../integrations/github/install-state";
import {
  getInstallationToken,
  resolveRepoToken,
} from "../../integrations/github/app-auth";
import {
  getRepoInfo,
  listInstallationRepos,
} from "../../integrations/github/github-api";
import {
  connectWorkspaceRepo,
  disconnectWorkspaceRepo,
  getWorkspaceRepo,
} from "../../services/workspace-repos.service";
import { syncRepoBackedResources } from "../../apps/worktree.service";
import {
  adoptConnectedRepo,
  type ConnectedRepoAdoption,
} from "../../apps/cloud-repo.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { WorkspaceParam, handleError } from "./shared";

export const appsGithubRoutes = createRouter();

// ---------------------------------------------------------------------------
// Status probe — Apps is always available (no feature flag). The frontend
// still calls this to learn readiness (later: whether the workspace has a
// GitHub repo linked). Registered before /:id so the param route can't shadow
// it.
// ---------------------------------------------------------------------------

appsGithubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/status-probe",
    tags: ["Apps"],
    summary: "Apps availability for this workspace",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    // Apps is not feature-flagged (the v1→v2 rollout flag is gone): the
    // probe reports repo linkage, which is the only real precondition.
    const repo = await getWorkspaceRepo(workspaceId);
    const repos = repo ? [repo] : [];
    return c.json(
      {
        success: true as const,
        linked: repos.length > 0,
        canCreate: repos.length > 0,
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

appsGithubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github-status",
    tags: ["Apps"],
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
    const repo = await getWorkspaceRepo(workspaceId);
    const repos = repo ? [repo] : [];
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

appsGithubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github-sync-url",
    tags: ["Apps"],
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

appsGithubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github-repos",
    tags: ["Apps"],
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

appsGithubRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/github-installations/{installationId}",
    tags: ["Apps"],
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

appsGithubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/link",
    tags: ["Apps"],
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
          { purge: false },
        ).catch(() => undefined);
        throw error;
      }
      if (adoption !== "deferred") {
        syncRepoBackedResources(workspaceId);
      }
      return c.json({ success: true as const, repo: binding, adoption }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsGithubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/unlink",
    tags: ["Apps"],
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
