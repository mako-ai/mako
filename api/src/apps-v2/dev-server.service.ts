/**
 * Apps v2 live dev preview — prototype of apps-v2.md §4.7's "dev preview"
 * tier (LOCAL SANDBOX PROVIDER ONLY).
 *
 * §4.7's end state runs `vite dev` inside an E2B microVM and has E2B expose
 * it at a public per-sandbox URL; that public-URL exposure is unbuilt. This
 * is a narrower prototype: it spawns `vite` directly as a subprocess of the
 * API host (same substrate the "local" sandbox provider already uses for
 * exec) and the API proxies to it, so local dev gets a continuously-live
 * preview with native HMR instead of a one-shot static build. Refuses to run
 * under the "e2b" provider — mirrors local-provider.ts's own NODE_ENV guard;
 * this is not a path to production.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { appsV2SandboxProviderId } from "./config";
import type { WorktreeHandle } from "./worktree.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-dev-server");

interface DevServer {
  process: ChildProcess;
  port: number;
  /**
   * The preview token this process's `--base` was started with — vite bakes
   * `base` into every absolute-root asset path it emits (HTML script tags,
   * the injected HMR client, `/@react-refresh`), so the token must stay
   * fixed for this process's lifetime; a fresh token per request would
   * desync those paths from whatever the proxy is actually serving under.
   */
  token: string;
  lastAccessedAt: number;
  ready: Promise<void>;
}

// Keyed by worktree id. In-process only (single-instance dev API) — same
// scoping caveat as preview.service.ts's token grants.
const servers = new Map<string, DevServer>();

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to allocate a port")));
      }
    });
  });
}

async function waitForReady(
  port: number,
  base: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${base}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status < 500) return;
    } catch {
      // Not up yet — vite is still booting (or installing deps on cold start).
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("vite dev server did not become ready in time");
}

function isAlive(server: DevServer): boolean {
  return server.process.exitCode === null && !server.process.killed;
}

/**
 * Start (or reuse) a persistent `vite dev` process bound to the worktree's
 * session directory. Assumes dependencies are already installed — callers
 * run the same install-if-needed step `/preview` does before calling this.
 */
export async function ensureDevServer(
  handle: WorktreeHandle,
): Promise<{ port: number; token: string }> {
  if (appsV2SandboxProviderId() !== "local") {
    throw new Error(
      "Live dev preview is a local-provider-only prototype — apps-v2.md §4.7's E2B public-URL exposure is not built yet",
    );
  }

  const worktreeId = handle.doc._id.toString();
  const existing = servers.get(worktreeId);
  if (existing && isAlive(existing)) {
    existing.lastAccessedAt = Date.now();
    await existing.ready;
    return { port: existing.port, token: existing.token };
  }
  if (existing) servers.delete(worktreeId);

  const port = await findFreePort();
  const token = randomBytes(24).toString("base64url");
  const base = `/api/apps-v2-preview/${token}/`;
  // Same cache-root convention as local-provider.ts's sandboxEnv: HOME must
  // NOT be the worktree dir, or vite/node's own cache writes would pollute
  // the git-tracked tree (this is exactly the bug fixed there).
  const cacheRoot = path.join(os.tmpdir(), "mako-apps-v2-cache");
  const viteBin = path.join(handle.sessionDir, "node_modules", ".bin", "vite");

  const child = spawn(
    viteBin,
    [
      "--port",
      String(port),
      "--strictPort",
      "--host",
      "127.0.0.1",
      "--base",
      base,
    ],
    {
      cwd: handle.sessionDir,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: path.join(cacheRoot, "home"),
        npm_config_cache: path.join(cacheRoot, "npm"),
        XDG_CACHE_HOME: path.join(cacheRoot, "xdg"),
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.on("exit", code => {
    logger.info("Apps v2 dev server exited", { worktreeId, code });
    servers.delete(worktreeId);
  });
  child.on("error", err => {
    logger.warn("Apps v2 dev server failed to start", {
      worktreeId,
      error: err.message,
    });
    servers.delete(worktreeId);
  });
  child.stderr?.on("data", chunk => {
    logger.debug("vite dev stderr", {
      worktreeId,
      chunk: chunk.toString().slice(0, 500),
    });
  });

  // Vite serves under `base` now, so readiness must probe that path — "/"
  // 404s once --base is anything other than "/".
  const ready = waitForReady(port, base).catch(err => {
    child.kill();
    servers.delete(worktreeId);
    throw err;
  });

  servers.set(worktreeId, {
    process: child,
    port,
    token,
    lastAccessedAt: Date.now(),
    ready,
  });
  logger.info("Apps v2 dev server started", { worktreeId, port });
  await ready;
  return { port, token };
}

/** Live dev-server state for a worktree, if one is running. */
export function getDevServer(
  worktreeId: string,
): { port: number; token: string } | null {
  const server = servers.get(worktreeId);
  if (!server || !isAlive(server)) return null;
  server.lastAccessedAt = Date.now();
  return { port: server.port, token: server.token };
}

const IDLE_TTL_MS = 30 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [worktreeId, server] of servers) {
      if (now - server.lastAccessedAt > IDLE_TTL_MS) {
        logger.info("Killing idle apps-v2 dev server", { worktreeId });
        server.process.kill();
        servers.delete(worktreeId);
      }
    }
  },
  5 * 60 * 1000,
).unref();
