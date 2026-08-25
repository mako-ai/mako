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
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import { boxCtx, ensureBox, type WorktreeHandle } from "./worktree.service";
import { loggers } from "../logging";
import { readBindings, bindingArtifactKey } from "./bindings.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const logger = loggers.api("apps-v2-dev-server");

/** Fixed inside the sandbox: one dev server per session, its own microVM. */
const DEV_PORT = 5173;

/** How long to hold the sandbox open past the last preview request. */
const DEV_SESSION_KEEPALIVE_MS = 30 * 60 * 1000;

/** Absolute path of the launcher we write into the sandbox (never the repo). */
/**
 * Where everything the boot does writes its output — npm install (the route
 * appends it here before starting the server) and vite itself. One file so
 * the client can tail one thing and show the person the ACTUAL boot, not a
 * stand-in.
 */
export const DEV_SERVER_LOG = "/tmp/mako-dev-server.log";

const LAUNCHER_PATH = "/tmp/mako-dev-server.mjs";

/**
 * Where materialized binding parquet is staged inside the sandbox.
 *
 * Deliberately outside the app's directory: this data is derived, sometimes
 * large, and must never end up in the user's git tree or their `public/`.
 */
const DATA_DIR = "/tmp/mako-data";

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
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

// Serve materialized data bindings at __data/<name>.parquet.
//
// The app fetches this path relatively, and it used to be answered by Mako's
// preview route, which sat in front of the dev server as a proxy. Now the
// browser talks to the sandbox directly (apps-v2.md §12.4), so nothing was
// answering it: Vite fell through to its SPA fallback and returned index.html,
// and the parquet reader failed with "footer != PAR1" on the HTML.
const makoData = {
  name: "mako-data",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/__data/index.json") {
        // The staged-binding list, for the SDK's useDuckDB. Missing file
        // (no bindings staged yet) is an empty list, not an error.
        const file = path.join(${JSON.stringify(DATA_DIR)}, "index.json");
        res.setHeader("content-type", "application/json");
        if (existsSync(file)) {
          createReadStream(file).pipe(res);
        } else {
          res.end("[]");
        }
        return;
      }
      const match = /^\\/__data\\/([A-Za-z0-9_][A-Za-z0-9_-]*)\\.parquet$/.exec(url);
      if (!match) return next();
      const file = path.join(${JSON.stringify(DATA_DIR)}, match[1] + ".parquet");
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: "Binding not materialized",
          binding: match[1],
        }));
        return;
      }
      // Parquet readers need the length to locate the footer.
      res.statusCode = 200;
      res.setHeader("content-type", "application/vnd.apache.parquet");
      res.setHeader("content-length", String(statSync(file).size));
      res.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(res);
    });
  },
};

const server = await createServer({
  root: ${JSON.stringify(appDir)},
  plugins: [makoData],
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
  /** Binding names whose data was staged into the session. */
  stagedBindings: string[];
}

/**
 * Copy each materialized binding's parquet into the sandbox so the dev server
 * can answer `__data/<name>.parquet` locally.
 *
 * Pushing the bytes in (rather than having the sandbox call back to Mako)
 * keeps this working identically in local development and in deployed
 * environments: a sandbox can always reach the public internet, but it can
 * never reach a developer's localhost API.
 *
 * Bindings that have never been materialized are skipped, and the dev server
 * answers 404 with a readable reason rather than serving HTML as parquet.
 */
async function stageBindingData(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
): Promise<string[]> {
  const projectId = handle.project._id.toString();
  let bindings: Awaited<ReturnType<typeof readBindings>>;
  try {
    bindings = await readBindings(handle.project, handle.doc.userId);
  } catch {
    return [];
  }
  if (bindings.length === 0) return [];

  await provider.exec(ctx, `mkdir -p ${DATA_DIR}`, { timeoutMs: 30_000 });

  const store = getDashboardArtifactStore();
  const staged: string[] = [];
  for (const binding of bindings) {
    const key = bindingArtifactKey(projectId, binding.name);
    const stream = await store.openReadStream(key);
    if (!stream) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    await provider.writeFile(
      ctx,
      `${DATA_DIR}/${binding.name}.parquet`,
      new Uint8Array(Buffer.concat(chunks)),
    );
    staged.push(binding.name);
  }

  // The staged names as a file beside the data, so the app-side SDK's
  // useDuckDB can register every binding without a Mako API in reach —
  // the same relative fetch that gets it the parquet gets it the list.
  await provider.writeFile(
    ctx,
    `${DATA_DIR}/index.json`,
    new TextEncoder().encode(JSON.stringify(staged)),
  );
  if (staged.length > 0) {
    logger.info("Apps v2 staged binding data into the sandbox", {
      projectId,
      bindings: staged,
    });
  }
  return staged;
}

async function isListening(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
): Promise<boolean> {
  const probe = await provider.exec(
    boxCtx(handle),
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
  const ctx = await ensureBox(handle);
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
      `nohup node ${LAUNCHER_PATH} >> ${DEV_SERVER_LOG} 2>&1 & echo started`,
      { cwd: handle.appRoot, timeoutMs: 60_000 },
    );

    // Vite is usually listening in a few hundred ms; poll briefly rather than
    // sleeping a fixed amount, and surface its own log if it never comes up.
    let up = false;
    for (let attempt = 0; attempt < 15 && !up; attempt++) {
      up = await isListening(handle, provider);
    }
    if (!up) {
      const log = await provider.exec(ctx, `tail -20 ${DEV_SERVER_LOG}`, {
        timeoutMs: 15_000,
      });
      throw new Error(
        `Dev server did not start. Vite output:\n${log.stdout.slice(-1500)}`,
      );
    }
  }

  // Refresh staged data on every call, so re-materializing a binding and
  // hitting preview again picks up the new rows without a restart.
  const stagedBindings = await stageBindingData(handle, provider, ctx);

  const url = await provider.publicUrlForPort(ctx, DEV_PORT);
  logger.info("Apps v2 dev preview ready", {
    projectId: handle.project._id.toString(),
    appRoot: handle.appRoot,
    stagedBindings,
  });
  return { url, stagedBindings };
}
