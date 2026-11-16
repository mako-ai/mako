/**
 * The caller's sandbox: build preview, live dev preview, dev servers,
 * sandbox stats and recycle, terminal sessions, boot / build logs, discard.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  buildPreview,
  recycleSandbox,
  sandboxStats,
  startDevPreview,
  tailBoxLog,
} from "../../apps/sandbox-ops.service";
import {
  PUBLISH_ACTOR,
  boxCtx,
  discardWorktree,
  ensureWorktree,
  sessionKeyFor,
} from "../../apps/worktree.service";
import { recordBoxActivity } from "../../apps/box-activity";
import { buildLogPath } from "../../apps/deployment.service";
import {
  killAllTerminalSessions,
  killTerminalSession,
} from "../../apps/terminal-ws";
import {
  devLogPath,
  devServerStatus,
  discoverDevServers,
  releaseDevServerSlot,
} from "../../apps/dev-server.service";
import { getBoxState } from "../../apps/box-state.service";
import { getSandboxProvider } from "../../apps/sandbox/provider";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  ProjectParam,
  handleError,
  loadProject,
  viewerOf,
  commitAuthorOf,
  actorOf,
} from "./shared";
import { fail } from "../lib/respond";

export const appsSandboxRoutes = createRouter();

appsSandboxRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/preview",
    tags: ["Apps"],
    summary: "Build the app in its session and mint a preview link",
    description:
      "Installs dependencies (npm or pnpm, per the app's lockfile; when needed) and `npm run build` in the actor's sandbox session, then returns a short-lived token-gated URL serving the built dist/. The URL is cookie-free and meant for a sandboxed iframe.",
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      const preview = await buildPreview(loaded.project, handle, {
        author: commitAuthorOf(c),
        viewer: viewerOf(c) ?? undefined,
      });
      if (!preview.ok) {
        return fail(c, 422, "Build failed", { output: preview.output });
      }
      return c.json(
        {
          success: true as const,
          token: preview.token,
          url: `/api/apps-preview/${preview.token}/`,
          expiresAt: preview.expiresAt,
          buildOutput: preview.buildOutput,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/dev-preview",
    tags: ["Apps"],
    summary: "Start (or reuse) a live `vite dev` preview for this app",
    description:
      "Live dev preview (apps.md §12.4). Installs dependencies (npm or pnpm, per the app's lockfile) if needed, starts a persistent `vite dev` inside the app's sandbox, and returns the sandbox's own public origin for the browser to iframe — HMR rides that origin, so edits show up with no rebuild step and nothing of the tenant's runs on the API host.",
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      const body = (await c.req.json().catch(() => ({}))) as {
        restart?: boolean;
      };
      const outcome = await startDevPreview(handle, {
        restart: body?.restart === true,
      });
      if (!outcome.ok) {
        return outcome.status === 422
          ? fail(c, 422, outcome.error, {
              stdout: outcome.stdout,
              stderr: outcome.stderr,
            })
          : fail(c, 500, outcome.error);
      }
      const { url, stagedBindings, evicted } = outcome;
      return c.json(
        { success: true as const, url, stagedBindings, evicted },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-servers",
    tags: ["Apps"],
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
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

appsSandboxRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/sandbox",
    tags: ["Apps"],
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      const ctx = boxCtx(handle);
      const info = (await getSandboxProvider().describe?.(ctx)) ?? null;
      if (!info) {
        return c.json({ success: true as const, running: false }, 200);
      }
      const stats = await sandboxStats(ctx);
      return c.json(
        {
          success: true as const,
          running: true,
          sandboxId: info.sandboxId,
          startedAt: info.startedAt,
          ...stats,
          connectCommand: `e2b sandbox connect ${info.sandboxId}`,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/sandbox/recycle",
    tags: ["Apps"],
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      await recycleSandbox(
        handle,
        loaded.project.workspaceId.toString(),
        actorOf(loaded),
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/terminal-sessions",
    tags: ["Apps"],
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
      // Dev sessions, launchers and registry slots are keyed by the app's
      // ID in the box (dev-server.service appSlug), never by the folder
      // basename — a basename kills nothing once apps nest.
      await killAllTerminalSessions(
        loaded.project,
        actorOf(loaded),
        loaded.project._id.toString(),
      );
      // Free the dev-server port registration too — the kill stops the
      // process, but a dead registry entry would retire its port forever
      // (§13.20).
      await releaseDevServerSlot(
        loaded.project.workspaceId.toString(),
        actorOf(loaded),
        loaded.project._id.toString(),
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/terminal-sessions/{termId}",
    tags: ["Apps"],
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
      await killTerminalSession(loaded.project, actorOf(loaded), termId);
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/activity",
    tags: ["Apps"],
    summary: "Record real use of the caller's sandbox (a preview interaction)",
    description:
      "The workbench calls this when the person interacts with the live preview (focuses or points into it). It keeps the sandbox from the idle pause; an open tab that only polls never does. Never starts, resumes or touches a sandbox.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      await recordBoxActivity(
        sessionKeyFor(loaded.project.workspaceId, actorOf(loaded)),
        "preview",
      );
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-preview/status",
    tags: ["Apps"],
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      const status = await devServerStatus(handle);
      return c.json({ success: true as const, ...status }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/dev-preview/log",
    tags: ["Apps"],
    summary: "Tail the dev-session boot log (dependency install + vite output)",
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
      const handle = await ensureWorktree(loaded.project, actorOf(loaded));
      const tail = await tailBoxLog(boxCtx(handle), devLogPath(handle), offset);
      return c.json({ success: true as const, ...tail }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/build/log",
    tags: ["Apps"],
    summary:
      "Tail the publish/preview build log (dependency install + build output)",
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
      const tail = await tailBoxLog(
        boxCtx(handle),
        buildLogPath(handle),
        offset,
      );
      return c.json({ success: true as const, ...tail }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSandboxRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/discard",
    tags: ["Apps"],
    summary: "Discard all uncommitted work and re-base on branch head",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const userId = actorOf(loaded);
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await discardWorktree(handle);
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
