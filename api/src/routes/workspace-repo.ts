/**
 * Workspace repository routes — the repo as a WORKSPACE-level thing.
 *
 * The workspace repo (§10: one bare repo per workspace; apps/, consoles/,
 * skills/, later dbt/ are folders in it) used to be reachable only through an
 * app handle: the Source Control panel grabbed `apps[0].id` and called
 * app-scoped routes with `scope=repo`. That hack meant a workspace whose repo
 * holds only consoles — or, after Block D3, only dbt — had no Source Control
 * at all. These routes address the repo by what it is keyed by: the
 * workspace. The app-scoped routes remain for app-scoped views (an app's own
 * history popover).
 *
 * The GitHub connection endpoints live here too (install-url, branches):
 * connecting a repo is workspace infrastructure, not an apps or dbt feature —
 * this is where the appsStore's borrowed `/dbt/github/*` calls move to, so
 * the dbt git surface can be deleted with Block D3 without breaking apps.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { GitHubInstallation } from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { signInstallState } from "../integrations/github/install-state";
import { getGitHubAppSlug } from "../integrations/github/config";
import { listBranches as listGithubBranches } from "../integrations/github/github-api";
import { isValidRepoSegment } from "../services/workspace-repos.service";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import {
  WorktreeConflictError,
  checkoutBranch,
  commitChanges,
  commitFileVersions,
  commitWorktree,
  ensureWorkspaceWorktree,
  fileVersions,
  gitPathsAction,
  listBranches,
  mergeBranchToMain,
  projectHistory,
  worktreeStatus,
  workspaceScope,
} from "../apps/worktree.service";

const logger = loggers.api("workspace-repo");

export const workspaceRepoRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});

workspaceRepoRoutes.use("*", unifiedAuthMiddleware);

workspaceRepoRoutes.use("*", async (c: AuthenticatedContext, next) => {
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

function actingUserId(c: AuthenticatedContext): string {
  return c.get("user")?.id ?? "api-key";
}

function handleError(c: AuthenticatedContext, error: unknown) {
  if (error instanceof WorktreeConflictError) {
    return c.json({ success: false, error: error.message }, 409);
  }
  logger.error("Workspace repo route error", { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    },
    500,
  );
}

const SafeRepoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    p => !p.startsWith("/") && !p.split("/").includes(".."),
    "path must stay inside the repository",
  );

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/status",
    tags: ["Workspace repo"],
    summary: "Workspace repo status for the caller's session",
    description:
      "Repo-wide worktree status: the sandbox's working copy when it is running, the last commit on the caller's branch when it is not. `hasRepo: false` when the workspace has no repo yet. Never starts a sandbox.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const repoDir = repoDirFor(workspaceId);
      if (!(await repoExists(repoDir))) {
        return c.json(
          { success: true as const, hasRepo: false as const, status: null },
          200,
        );
      }
      const userId = actingUserId(c);
      const status = await worktreeStatus(workspaceScope(workspaceId), userId);
      if (status) {
        return c.json({ success: true as const, hasRepo: true, status }, 200);
      }
      // No session yet: report the default branch at rest, like a code host
      // would — the panel is read-only until the first mutation creates a
      // session anyway.
      const branchHead = await resolveCommit(
        repoDir,
        `refs/heads/${DEFAULT_BRANCH}`,
      );
      return c.json(
        {
          success: true as const,
          hasRepo: true,
          status: {
            branch: DEFAULT_BRANCH,
            baseSha: branchHead ?? "",
            branchHead,
            ahead: 0,
            changes: [],
            repoChanges: [],
            offline: true,
          },
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// History / commit inspection
// ---------------------------------------------------------------------------

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/history",
    tags: ["Workspace repo"],
    summary: "Commit history of a branch (defaults to the default branch)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        ref: z.string().max(200).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { limit, ref } = c.req.valid("query");
      const commits = await projectHistory(
        workspaceScope(workspaceId),
        limit ?? 20,
        ref,
        "repo",
      );
      return c.json({ success: true as const, commits }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/git/commit",
    tags: ["Workspace repo"],
    summary: "Files changed by one commit (repo-relative paths)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { sha } = c.req.valid("query");
      const commit = await commitChanges(
        workspaceScope(workspaceId),
        sha,
        "repo",
      );
      return c.json({ success: true as const, commit }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/git/file-versions",
    tags: ["Workspace repo"],
    summary: "HEAD, index and working-tree contents of a repo path (for diffs)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        path: SafeRepoPath,
        /**
         * With a commit: the file before and after THAT commit, read from the
         * repo — no sandbox. Without: HEAD / index / working tree of the
         * caller's box.
         */
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/)
          .optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path: relPath, sha } = c.req.valid("query");
      if (sha) {
        const versions = await commitFileVersions(
          workspaceScope(workspaceId),
          sha,
          relPath,
        );
        return c.json({ success: true as const, versions }, 200);
      }
      const handle = await ensureWorkspaceWorktree(
        workspaceId,
        actingUserId(c),
      );
      const versions = await fileVersions(handle, relPath);
      return c.json({ success: true as const, versions }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/branches",
    tags: ["Workspace repo"],
    summary: "List branches",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const branches = await listBranches(workspaceScope(workspaceId));
      return c.json({ success: true as const, branches }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

workspaceRepoRoutes.openapi(
  createRoute({
    method: "post",
    path: "/checkout",
    tags: ["Workspace repo"],
    summary: "Switch the caller's session to a branch (git checkout)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
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
      const { workspaceId } = c.req.valid("param");
      const { branch, create } = c.req.valid("json");
      const handle = await ensureWorkspaceWorktree(
        workspaceId,
        actingUserId(c),
      );
      const result = await checkoutBranch(handle, branch, { create });
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

workspaceRepoRoutes.openapi(
  createRoute({
    method: "post",
    path: "/merge",
    tags: ["Workspace repo"],
    summary: "Merge a branch into the default branch",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ branch: z.string().min(1).max(200) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { branch } = c.req.valid("json");
      const user = c.get("user");
      const result = await mergeBranchToMain(
        workspaceScope(workspaceId),
        branch,
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Commit + per-file git actions (the Source Control panel's verbs)
// ---------------------------------------------------------------------------

workspaceRepoRoutes.openapi(
  createRoute({
    method: "post",
    path: "/commit",
    tags: ["Workspace repo"],
    summary: "Commit the caller's working copy onto their branch",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().min(1),
              /** Commit only the index (a non-empty Staged group). */
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
      const { workspaceId } = c.req.valid("param");
      const { message, stagedOnly } = c.req.valid("json");
      const user = c.get("user");
      const handle = await ensureWorkspaceWorktree(
        workspaceId,
        actingUserId(c),
      );
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

const RepoPaths = z.object({
  paths: z.array(SafeRepoPath).min(1).max(500),
});

for (const action of ["stage", "unstage", "discard"] as const) {
  workspaceRepoRoutes.openapi(
    createRoute({
      method: "post",
      path: `/git/${action}`,
      tags: ["Workspace repo"],
      summary:
        action === "stage"
          ? "Stage files for commit (git add)"
          : action === "unstage"
            ? "Unstage files (git reset HEAD --)"
            : "Discard working-tree changes to files (checkout / clean)",
      security: AUTH_SECURITY,
      request: {
        params: WorkspaceParam,
        body: { content: { "application/json": { schema: RepoPaths } } },
      },
      responses: OPEN_RESPONSES,
    }),
    async c => {
      try {
        const { workspaceId } = c.req.valid("param");
        const { paths } = c.req.valid("json");
        const handle = await ensureWorkspaceWorktree(
          workspaceId,
          actingUserId(c),
        );
        await gitPathsAction(handle, action, paths);
        return c.json({ success: true as const }, 200);
      } catch (error) {
        return handleError(c, error);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// GitHub connection (workspace infrastructure, not an apps/dbt feature)
// ---------------------------------------------------------------------------

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github/install-url",
    tags: ["Workspace repo"],
    summary: "Signed GitHub App install URL (admin+)",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const slug = getGitHubAppSlug();
      if (!slug) {
        return c.json(
          {
            success: false,
            error:
              "GitHub App is not configured (set GITHUB_APP_SLUG/GITHUB_APP_ID)",
          },
          400,
        );
      }
      // Connecting a repo is a deployment-config mutation → admin+ (the
      // /setup callback consumes this signed state).
      const user = c.get("user");
      if (!user || !(await workspaceService.isAdmin(workspaceId, user.id))) {
        return c.json(
          {
            success: false,
            error:
              "Connecting GitHub requires the admin or owner workspace role",
          },
          403,
        );
      }
      const returnClientUrl = process.env.CLIENT_URL || "http://localhost:5173";
      // Signed, short-lived state pins the workspace + initiating user so the
      // /setup callback cannot be forged to bind an arbitrary installation.
      const state = signInstallState({
        workspaceId,
        userId: user.id,
        clientUrl: returnClientUrl,
      });
      return c.json(
        {
          success: true as const,
          url: `https://github.com/apps/${slug}/installations/new?state=${state}`,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

workspaceRepoRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github/branches",
    tags: ["Workspace repo"],
    summary: "Branch names of a GitHub repo (connect/link UI)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        installationId: z.coerce.number().int().positive().optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { owner, repo, installationId } = c.req.valid("query");
      if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
        return c.json(
          { success: false, error: "Invalid owner or repo name" },
          400,
        );
      }
      if (installationId) {
        const installation = await GitHubInstallation.findOne({
          workspaceId: new Types.ObjectId(workspaceId),
          installationId,
        });
        if (!installation) {
          return c.json(
            { success: false, error: "Installation not found" },
            404,
          );
        }
      }
      const token = await resolveRepoToken(installationId);
      const branches = await listGithubBranches(owner, repo, token);
      return c.json({ success: true as const, branches }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
