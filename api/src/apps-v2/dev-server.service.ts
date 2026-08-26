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

/**
 * Every running app gets its own dev server on its own port — two apps can
 * be live side by side, and opening app B no longer kills app A's server
 * (the old single-port model needed an identity marker and a takeover;
 * per-app ports delete that whole problem). Ports are handed out from this
 * base by a registry file inside the sandbox, so the mapping lives with the
 * servers it describes and survives API restarts.
 */
const DEV_PORT_BASE = 5173;
const PORTS_REGISTRY = "/tmp/mako-dev-ports.json";

/** How long to hold the sandbox open past the last preview request. */
const DEV_SESSION_KEEPALIVE_MS = 30 * 60 * 1000;

/** One filesystem identity per app for launcher, log and staged data. */
function appSlug(handle: WorktreeHandle): string {
  const base = handle.appRoot.split("/").filter(Boolean).pop() ?? "app";
  return base.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
}

/**
 * Where everything this APP's boot writes its output — npm install (the
 * route appends it here before starting the server) and vite itself. One
 * file per app so each workbench's Dev server tab tails its own boot.
 */
export function devLogPath(handle: WorktreeHandle): string {
  return `/tmp/mako-dev-${appSlug(handle)}.log`;
}

function launcherPath(handle: WorktreeHandle): string {
  return `/tmp/mako-dev-${appSlug(handle)}.mjs`;
}

/**
 * Where materialized binding parquet is staged inside the sandbox — per app,
 * so two apps with a same-named binding cannot serve each other's data.
 *
 * Deliberately outside the app's directory: this data is derived, sometimes
 * large, and must never end up in the user's git tree or their `public/`.
 */
function dataDir(handle: WorktreeHandle): string {
  return `/tmp/mako-data-${appSlug(handle)}`;
}

/**
 * The app's port, from the in-sandbox registry. `allocate` grants a new port
 * to an app that has none; reads that must not disturb state (is the server
 * up?) pass false and get null for an unregistered app. Allocation runs as
 * one node one-liner in the sandbox, so concurrent allocations for the SAME
 * sandbox serialize on the file rather than racing in two API processes.
 */
async function devPort(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  options: { allocate: boolean },
): Promise<number | null> {
  const script =
    `const fs=require("fs");const f=${JSON.stringify(PORTS_REGISTRY)};` +
    `let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}` +
    `const app=process.argv[1];` +
    (options.allocate
      ? `if(!m[app]){const used=new Set(Object.values(m));let p=${DEV_PORT_BASE};while(used.has(p))p++;m[app]=p;fs.writeFileSync(f,JSON.stringify(m));}`
      : ``) +
    `console.log(m[app]??"");`;
  const result = await provider.exec(
    ctx,
    `node -e '${script.replace(/'/g, String.raw`'\''`)}' ${JSON.stringify(handle.appRoot)}`,
    { timeoutMs: 30_000 },
  );
  const port = Number(result.stdout.trim());
  return Number.isInteger(port) && port >= DEV_PORT_BASE ? port : null;
}

/**
 * Node launcher, run inside the sandbox. Uses Vite's JS API because inline
 * `server` options there beat the app's config file; the CLI has no flag for
 * `allowedHosts`, and editing the app's `vite.config.ts` to add one would be
 * committing our infrastructure into the user's repository.
 *
 * `.e2b.app` is matched as a suffix, so it covers the sandbox's own origin
 * without our having to know the sandbox id at write time.
 */
function launcherSource(
  appDir: string,
  port: number,
  stagedDataDir: string,
): string {
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
        const file = path.join(${JSON.stringify(stagedDataDir)}, "index.json");
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
      const file = path.join(${JSON.stringify(stagedDataDir)}, match[1] + ".parquet");
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
    port: ${port},
    strictPort: true,
    // The browser reaches us on the sandbox's public origin; without this
    // Vite answers 403 "Blocked request. This host is not allowed."
    allowedHosts: [".e2b.app"],
    // inotify does not fire in the E2B microVM (verified: fs.watch gets no
    // event even for a same-process append), so without polling the module
    // graph never invalidates: edits commit and land on disk but the served
    // transform — and HMR — stay frozen on the boot-time contents.
    watch: { usePolling: true, interval: 300 },
  },
});
await server.listen();
// The same banner \`vite dev\` prints from a terminal — version, ready
// time, URLs — so the boot log reads like the real thing, because it is.
server.printUrls();
console.log("mako dev server listening on ${port}");
// Watcher lifecycle in the boot log: "ready" proves the polling scan
// finished (inotify is dead in this VM, so a silent watcher means frozen
// transforms), and errors here are otherwise invisible.
server.watcher.on("ready", () => console.log("file watcher ready (polling)"));
server.watcher.on("error", (e) => console.log("file watcher error:", e.message));
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

  const stageDir = dataDir(handle);
  await provider.exec(ctx, `mkdir -p ${stageDir}`, { timeoutMs: 30_000 });

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
      `${stageDir}/${binding.name}.parquet`,
      new Uint8Array(Buffer.concat(chunks)),
    );
    staged.push(binding.name);
  }

  // The staged names as a file beside the data, so the app-side SDK's
  // useDuckDB can register every binding without a Mako API in reach —
  // the same relative fetch that gets it the parquet gets it the list.
  await provider.writeFile(
    ctx,
    `${stageDir}/index.json`,
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

/**
 * Is THIS app's dev server up? Per-app ports make identity trivial: the port
 * came from the registry keyed by app, so "the port answers" IS the check —
 * the marker file and takeover of the single-port era are gone.
 */
async function listening(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  port: number,
): Promise<boolean> {
  const probe = await provider.exec(
    ctx,
    `curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${port}/ && echo up || echo down`,
    { timeoutMs: 15_000 },
  );
  return probe.stdout.includes("up");
}

/**
 * Is this app's dev server already up in an existing sandbox? Never creates
 * a sandbox and never allocates a port. The reattach path uses this to keep
 * its hands off the boot log: truncating it and then skipping the launch
 * (because the server was already running) left the Dev server tab
 * permanently blank after a page reload.
 */
export async function isServingApp(handle: WorktreeHandle): Promise<boolean> {
  const provider = getSandboxProvider();
  const ctx = boxCtx(handle);
  if (!(await provider.hasSession(ctx))) return false;
  const port = await devPort(handle, provider, ctx, { allocate: false });
  if (!port) return false;
  return listening(provider, ctx, port);
}

/**
 * Ensure a dev server is running for this app and return its public URL.
 *
 * Idempotent: a server that is already listening is reused, so repeated
 * previews do not restart vite and lose its module graph. Other apps' dev
 * servers are left alone — each has its own port.
 */
export async function ensureDevServer(
  handle: WorktreeHandle,
): Promise<DevPreview> {
  const provider = getSandboxProvider();
  const ctx = await ensureBox(handle);
  const appDir = `/home/user/app/${handle.appRoot}`;

  await provider.keepAlive(ctx, DEV_SESSION_KEEPALIVE_MS);

  const port = await devPort(handle, provider, ctx, { allocate: true });
  if (!port) throw new Error("Could not allocate a dev-server port");
  const logPath = devLogPath(handle);
  const launcher = launcherPath(handle);

  const wasListening = await listening(provider, ctx, port);
  if (!wasListening) {
    const write = await provider.exec(
      ctx,
      `cat > ${launcher} <<'MAKO_LAUNCHER_EOF'\n${launcherSource(appDir, port, dataDir(handle))}\nMAKO_LAUNCHER_EOF\necho written`,
      { timeoutMs: 30_000 },
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `Could not write the dev-server launcher: ${write.stderr}`,
      );
    }

    // The dev server is a SESSION, not a daemon: inside tmux it is
    // `tmux attach -t mako-dev-<slug>` away from any shell, survives API
    // restarts like every other session, and shows up in `tmux ls` next to
    // the user's own shells — the launcher still tees to the log so the
    // boot tab can tail it. Sandboxes without tmux fall back to nohup,
    // which is the same server minus the attachability.
    const devSession = `mako-dev-${appSlug(handle)}`;
    await provider.execDetached(
      ctx,
      `if command -v tmux >/dev/null; then tmux new-session -d -s ${devSession} 'node ${launcher} 2>&1 | tee -a ${logPath}' 2>/dev/null || true; else nohup node ${launcher} >> ${logPath} 2>&1 & fi; echo started`,
      { cwd: handle.appRoot, timeoutMs: 60_000 },
    );

    // Vite is usually listening within seconds, but a cold boot on E2B can
    // take over a minute (cold ESM import of vite off microVM disk, plus the
    // polling watcher's initial scan) — and a window that gives up early
    // 500s the request while the server comes up fine moments later. Poll
    // with a real pause, generously, and surface the log if it truly dies.
    let up = false;
    for (let attempt = 0; attempt < 45 && !up; attempt++) {
      up = await listening(provider, ctx, port);
      if (!up) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!up) {
      const log = await provider.exec(ctx, `tail -20 ${logPath}`, {
        timeoutMs: 15_000,
      });
      throw new Error(
        `Dev server did not start. Vite output:\n${log.stdout.slice(-1500)}`,
      );
    }
  }

  // Refresh staged data on every call, so re-materializing a binding and
  // hitting preview again picks up the new rows without a restart. On a
  // REATTACH, though, the previous staging is still on disk and almost
  // always current — restage in the background instead of adding seconds
  // of exec round-trips to a page reload that should feel instant.
  let stagedBindings: string[] = [];
  if (wasListening) {
    void stageBindingData(handle, provider, ctx).catch(error => {
      logger.warn("Apps v2 background binding restage failed", {
        projectId: handle.project._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    stagedBindings = await stageBindingData(handle, provider, ctx);
  }

  const url = await provider.publicUrlForPort(ctx, port);
  logger.info("Apps v2 dev preview ready", {
    projectId: handle.project._id.toString(),
    appRoot: handle.appRoot,
    stagedBindings,
  });
  return { url, stagedBindings };
}
