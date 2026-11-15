/**
 * Branch work: one commit's changes, restore, checkout, branches, merge.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  checkoutBranch,
  ensureWorktree,
  listBranches,
  mergeBranchToMain,
  commitChanges,
  restoreWorktreeTo,
  scopeOf,
} from "../../apps/worktree.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { ProjectParam, handleError, loadProject } from "./shared";

export const appsGitBranchRoutes = createRouter();

appsGitBranchRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/commit",
    tags: ["Apps"],
    summary: "What one commit changed (in this app, or repo-wide)",
    description:
      "The commit's parent and the files it added, modified, deleted or renamed — app-relative by default, repo-relative with scope=repo (the Source Control graph). Read from the repository — starts no sandbox.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        sha: z.string().regex(/^[0-9a-f]{7,40}$/),
        scope: z.enum(["app", "repo"]).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { sha, scope } = c.req.valid("query");
      const commit = await commitChanges(
        scopeOf(loaded.project),
        sha,
        scope ?? "app",
      );
      return c.json({ success: true as const, commit }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsGitBranchRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Apps"],
    summary: "Restore the app to a previous version (as a new commit)",
    description:
      "Sets the app's files back to their content at `sha` and commits that on the caller's branch, then pushes. Nothing is rewritten: the versions in between stay in the history. Runs in the caller's sandbox (starting it if needed), like any edit.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
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
      const { sha } = c.req.valid("json");
      const user = c.get("user");
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await restoreWorktreeTo(
        handle,
        sha,
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsGitBranchRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/checkout",
    tags: ["Apps"],
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

appsGitBranchRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/branches",
    tags: ["Apps"],
    summary: "List branches",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const branches = await listBranches(scopeOf(loaded.project));
      return c.json({ success: true as const, branches }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsGitBranchRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/merge",
    tags: ["Apps"],
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
        scopeOf(loaded.project),
        branch,
        user?.email ? { name: user.email, email: user.email } : undefined,
        user?.id,
      );
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
