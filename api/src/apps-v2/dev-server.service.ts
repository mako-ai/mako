/**
 * Apps v2 live dev preview — `vite dev` INSIDE the sandbox (apps-v2.md §12.4).
 *
 * The previous implementation spawned vite as a child process of the API host
 * and proxied to it. That could only ever work under the deleted local sandbox
 * provider, because it is exactly what N1 forbids: tenant code executing in the
 * API process. So the throwaway dev substrate had live preview and every real
 * environment had none.
 *
 * Now the dev server runs where the app's files already are. E2B exposes a
 * per-sandbox public origin for any port (`https://<port>-<sandboxId>.e2b.app`),
 * which the browser loads directly — no Mako proxy, no WebSocket relay of our
 * own (HMR rides that same origin), and nothing of the tenant's on our host.
 *
 * Two details the sandbox forces, both handled here rather than in the app's
 * own files:
 *
 * - Vite must bind `0.0.0.0`, and since 5.4 it rejects requests whose Host it
 *   does not recognise — the E2B origin is exactly such a Host. Both are server
 *   options, and we set them through Vite's JS API so they take precedence over
 *   whatever the app's `vite.config.ts` says WITHOUT editing a file the user
 *   owns and commits.
 * - The sandbox's idle timeout would pause the microVM out from under a dev
 *   server that is running but momentarily idle, so it is pushed out explicitly.
 */
import { getSandboxProvider } from "./sandbox/provider";
import type { WorktreeHandle } from "./worktree.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-dev-server");

/** Fixed inside the sandbox: one dev server per session, its own microVM. */
const DEV_PORT = 5173;

/** How long to hold the sandbox open past the last preview request. */
const DEV_SESSION_KEEPALIVE_MS = 30 * 60 * 1000;

/** Absolute path of the launcher we write into the sandbox (never the repo). */
const LAUNCHER_PATH = "/tmp/mako-dev-server.mjs";

/**
 * Node launcher, run inside the sandbox. Uses Vite's JS API because inline
 * `server` options there beat the app's config file; the CLI has no flag for
 * `allowedHosts`, and editing the app's `vite.config.ts` to add one would be
 * committing our infrastructure into the user's repository.
 *
 * `.e2b.app` is matched as a suffix, so it covers the sandbox's own origin
 * without our having to know the sandbox id at write time.
 */
function launcherSource(appDir: string): string {
  return `
import { createServer } from "${appDir}/node_modules/vite/dist/node/index.js";

const server = await createServer({
  root: ${JSON.stringify(appDir)},
  server: {
    host: "0.0.0.0",
    port: ${DEV_PORT},
    strictPort: true,
    // The browser reaches us on the sandbox's public origin; without this
    // Vite answers 403 "Blocked request. This host is not allowed."
    allowedHosts: [".e2b.app"],
  },
});
await server.listen();
console.log("mako dev server listening on ${DEV_PORT}");
`.trimStart();
}

export interface DevPreview {
  /** Public origin the browser should iframe. */
  url: string;
}

async function isListening(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
): Promise<boolean> {
  const probe = await provider.exec(
    { hostDir: handle.sessionDir, sessionKey: handle.doc._id.toString() },
    `curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${DEV_PORT}/ && echo up || echo down`,
    { timeoutMs: 15_000 },
  );
  return probe.stdout.includes("up");
}

/**
 * Ensure a dev server is running for this app and return its public URL.
 *
 * Idempotent: a server that is already listening is reused, so repeated
 * previews do not restart vite and lose its module graph.
 */
export async function ensureDevServer(
  handle: WorktreeHandle,
): Promise<DevPreview> {
  const provider = getSandboxProvider();
  const ctx = {
    hostDir: handle.sessionDir,
    sessionKey: handle.doc._id.toString(),
  };
  const appDir = `/home/user/app/${handle.appRoot}`;

  await provider.keepAlive(ctx, DEV_SESSION_KEEPALIVE_MS);

  if (!(await isListening(handle, provider))) {
    const write = await provider.exec(
      ctx,
      `cat > ${LAUNCHER_PATH} <<'MAKO_LAUNCHER_EOF'\n${launcherSource(appDir)}\nMAKO_LAUNCHER_EOF\necho written`,
      { timeoutMs: 30_000 },
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `Could not write the dev-server launcher: ${write.stderr}`,
      );
    }

    await provider.execDetached(
      ctx,
      `nohup node ${LAUNCHER_PATH} > /tmp/mako-dev-server.log 2>&1 & echo started`,
      { cwd: handle.appRoot, timeoutMs: 60_000 },
    );

    // Vite is usually listening in a few hundred ms; poll briefly rather than
    // sleeping a fixed amount, and surface its own log if it never comes up.
    let up = false;
    for (let attempt = 0; attempt < 15 && !up; attempt++) {
      up = await isListening(handle, provider);
    }
    if (!up) {
      const log = await provider.exec(
        ctx,
        `tail -20 /tmp/mako-dev-server.log`,
        { timeoutMs: 15_000 },
      );
      throw new Error(
        `Dev server did not start. Vite output:\n${log.stdout.slice(-1500)}`,
      );
    }
  }

  const url = await provider.publicUrlForPort(ctx, DEV_PORT);
  logger.info("Apps v2 dev preview ready", {
    projectId: handle.project._id.toString(),
    appRoot: handle.appRoot,
  });
  return { url };
}
