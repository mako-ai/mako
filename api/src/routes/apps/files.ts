/**
 * Files, shell exec, worktree status / history / commit and the per-file git
 * actions of the Source Control view.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  autoCommitFileEdit,
  commitWorktree,
  ensureWorktree,
  execInWorktree,
  fileVersions,
  gitPathsAction,
  listFiles,
  projectHistory,
  commitFileVersions,
  readFile,
  worktreeStatus,
  writeFile,
  scopeOf,
} from "../../apps/worktree.service";
import { APPS_EXEC_MAX_TIMEOUT_MS } from "../../apps/config";
import { publishState } from "../../apps/publish-state";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { ProjectParam, handleError, loadProject } from "./shared";

export const appsFileRoutes = createRouter();

// ---------------------------------------------------------------------------
// Files (durable reads; writes go through the actor's worktree)
// ---------------------------------------------------------------------------

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/files",
    tags: ["Apps"],
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

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/file",
    tags: ["Apps"],
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

appsFileRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/file",
    tags: ["Apps"],
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

appsFileRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/exec",
    tags: ["Apps"],
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
                .max(APPS_EXEC_MAX_TIMEOUT_MS)
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

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/status",
    tags: ["Apps"],
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
      const status = await worktreeStatus(scopeOf(loaded.project), userId);
      return c.json({ success: true as const, status }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Apps"],
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
        scopeOf(loaded.project),
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

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/publish-state",
    tags: ["Apps"],
    summary:
      "What is live: the published commit, its age, and what main has that is not live",
    description:
      "The published sha with its commit (author, time, subject), when it was published, whether the default branch has app changes that are not live (and how many commits), and the last deploy error. Read from the repository — starts no sandbox.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const state = await publishState(loaded.project);
      return c.json({ success: true as const, state }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsFileRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/commit",
    tags: ["Apps"],
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
  appsFileRoutes.openapi(
    createRoute({
      method: "post",
      path: `/{id}/git/${action}`,
      tags: ["Apps"],
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

appsFileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/file-versions",
    tags: ["Apps"],
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
        /**
         * With a commit: the file before and after THAT commit (app-relative
         * path), read from the repo — no sandbox. Without: HEAD / index /
         * working tree of the caller's box.
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
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { path: relPath, sha } = c.req.valid("query");
      if (sha) {
        const versions = await commitFileVersions(
          scopeOf(loaded.project),
          sha,
          relPath,
        );
        return c.json({ success: true as const, versions }, 200);
      }
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
