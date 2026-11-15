/**
 * The caller's sandbox: build preview, live dev preview, dev servers,
 * sandbox stats and recycle, terminal sessions, boot / build logs, discard.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  PUBLISH_ACTOR,
  boxCtx,
  commitWorktree,
  discardWorktree,
  ensureWorktree,
  execInWorktree,
  forgetBoxCaches,
} from "../../apps/worktree.service";
import { previewStagingDir } from "../../apps/config";
import { buildApp, buildLogPath } from "../../apps/deployment.service";
import fs from "node:fs/promises";
import { readBoxDir } from "../../apps/box";
import { mintPreviewGrant } from "../../apps/preview.service";
import {
  forgetTerminalCaches,
  killAllTerminalSessions,
  killTerminalSession,
} from "../../apps/terminal-ws";
import {
  devLogPath,
  devServerStatus,
  ensureDevServer,
  isServingApp,
  discoverDevServers,
  releaseDevServerSlot,
} from "../../apps/dev-server.service";
import { getBoxState, markBoxOffline } from "../../apps/box-state.service";
import { getSandboxProvider } from "../../apps/sandbox/provider";
import { installCommand } from "../../apps/package-manager";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { ProjectParam, handleError, loadProject, viewerOf } from "./shared";

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

      // The install can leave a new/updated lockfile in the worktree (e.g.
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
        // The builder previewing their own build: `useViewer()` is them.
        viewer: viewerOf(c) ?? undefined,
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `/api/apps-preview/${grant.token}/`,
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
          `: > ${logPath}; printf '=== mako dev boot: cd ${handle.appRoot} && vite (Mako launcher: bindings + eyes + HMR host) ===\\n\\n' >> ${logPath}; set -o pipefail; ( [ -d node_modules ] || ${installCommand()} ) 2>&1 | tee -a ${logPath}`,
          { timeoutMs: 300_000 },
        );
        if (install.exitCode !== 0) {
          return c.json(
            {
              success: false,
              error: "Dependency install failed",
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
        loaded.userId ?? "api-key",
        loaded.project._id.toString(),
      );
      // Free the dev-server port registration too — the kill stops the
      // process, but a dead registry entry would retire its port forever
      // (§13.20).
      await releaseDevServerSlot(
        loaded.project.workspaceId.toString(),
        loaded.userId ?? "api-key",
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
      const userId = loaded.userId ?? "api-key";
      const handle = await ensureWorktree(loaded.project, userId);
      const result = await discardWorktree(handle);
      return c.json({ success: true as const, result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
