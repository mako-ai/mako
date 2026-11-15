/**
 * Where an app's dev session lives in the box: its port, dtach socket,
 * launcher, boot log, console log and staged-data directory.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import {
  boxCtx,
  type WorktreeHandle,
  handleProject,
} from "../worktree.service";
import { sh } from "../box";

/**
 * Every running app gets its own dev server on its own port — two apps can
 * be live side by side, and opening app B no longer kills app A's server
 * (the old single-port model needed an identity marker and a takeover;
 * per-app ports delete that whole problem). Ports are handed out from this
 * base by a registry file inside the sandbox, so the mapping lives with the
 * servers it describes and survives API restarts.
 */
const DEV_PORT_BASE = 5173;
export const PORTS_REGISTRY = "/tmp/mako-dev-ports.json";

/** How long to hold the sandbox open past the last preview request. */
export const DEV_SESSION_KEEPALIVE_MS = 30 * 60 * 1000;

/**
 * At most this many dev servers run at once per box (apps.md §13.9).
 *
 * A dozen vite servers fills a 2 GiB microVM; this is the hard ceiling that
 * keeps a heavy workspace from ever getting there. Starting a server beyond
 * the cap evicts the oldest to make room — the system may STOP to bound
 * resources, but it never auto-starts. Reaping idle servers below the cap is
 * the box agent's job.
 */
export const MAX_RUNNING_DEV_SERVERS = 3;

/**
 * One in-box identity per app for launcher, log, staged data, the port
 * registry and the box agent's reports: the app's ID. Folder basenames are
 * not unique once apps nest (`apps/sales/report`, `users/<handle>/apps/report`),
 * and a path is not a filename — so every site that used to key by the
 * basename keys by this instead, and they cannot disagree with each other.
 */
export function appSlug(handle: WorktreeHandle): string {
  return handleProject(handle)._id.toString();
}

/**
 * Where everything this APP's boot writes its output — npm install (the
 * route appends it here before starting the server) and vite itself. One
 * file per app so each workbench's Dev server tab tails its own boot.
 */
export function devLogPath(handle: WorktreeHandle): string {
  // The dev server IS a terminal session (dtach socket mako-term-dev-<slug>,
  // recording mako-hist-dev-<slug>.raw — the same naming every interactive
  // session uses), so the workbench's dev tab attaches to it like any other
  // shell: colors, scrollback, prefill and Ctrl-C all come from the same
  // machinery. This file doubles as the boot log the route tees npm install
  // into, so the recording holds the WHOLE story of a boot.
  return `/tmp/mako-hist-dev-${appSlug(handle)}.raw`;
}

/**
 * Where the injected runtime-console bridge (the makoEyes vite plugin in the
 * launcher below) appends browser-side errors/warnings as JSONL. Read by
 * app_dev_log so an agent sees what the BROWSER said, not just vite.
 */
export function devConsolePath(handle: WorktreeHandle): string {
  return `/tmp/mako-console-${appSlug(handle)}.jsonl`;
}

/**
 * Port of this app's RUNNING dev server, or null. Never allocates and never
 * boots anything — a question, not an act (§13.9).
 */
export async function currentDevPort(
  handle: WorktreeHandle,
): Promise<number | null> {
  const provider = getSandboxProvider();
  const ctx = boxCtx(handle);
  if (!(await provider.hasSession(ctx))) return null;
  return devPort(handle, provider, ctx, { allocate: false });
}

/** The dev session's dtach socket — its existence is "the server has a session". */
export function devSockPath(handle: WorktreeHandle): string {
  return `/tmp/mako-term-dev-${appSlug(handle)}.sock`;
}

export function launcherPath(handle: WorktreeHandle): string {
  return `/tmp/mako-dev-${appSlug(handle)}.mjs`;
}

/**
 * Where materialized binding parquet is staged inside the sandbox — per app,
 * so two apps with a same-named binding cannot serve each other's data.
 *
 * Deliberately outside the app's directory: this data is derived, sometimes
 * large, and must never end up in the user's git tree or their `public/`.
 */
export function dataDir(handle: WorktreeHandle): string {
  return `/tmp/mako-data-${appSlug(handle)}`;
}

/**
 * The app's port, from the in-sandbox registry. `allocate` grants a new port
 * to an app that has none; reads that must not disturb state (is the server
 * up?) pass false and get null for an unregistered app.
 *
 * Allocation takes a LOCK (mkdir is atomic) around the read-modify-write:
 * two apps launched concurrently both read `{}`, both picked 5173, and the
 * loser's vite died on EADDRINUSE — while its "is it listening" poll saw the
 * winner answering and iframed the WRONG app. A lock held longer than 5s is
 * presumed dead (a killed allocator) and stolen.
 */
export async function devPort(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  options: { allocate: boolean },
): Promise<number | null> {
  const script =
    `const fs=require("fs");const f=${JSON.stringify(PORTS_REGISTRY)};` +
    `const app=process.argv[1];` +
    (options.allocate
      ? `const lock=f+".lock";const t0=Date.now();` +
        `for(;;){try{fs.mkdirSync(lock);break}catch{` +
        `if(Date.now()-t0>5000){try{fs.rmdirSync(lock)}catch{}continue}` +
        `const w=Date.now()+15;while(Date.now()<w);}}` +
        `try{let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}` +
        // A box that predates id-keyed registries holds this app under its
        // old key (apps/<basename>): adopt that slot rather than start a
        // second vite beside the first for the rest of the box's life.
        `const legacy=process.argv[2];if(!m[app]&&legacy&&Number.isInteger(m[legacy])){m[app]=m[legacy];delete m[legacy];fs.writeFileSync(f,JSON.stringify(m));}` +
        `if(!m[app]){const used=new Set(Object.values(m));let p=${DEV_PORT_BASE};while(used.has(p))p++;m[app]=p;fs.writeFileSync(f,JSON.stringify(m));}` +
        `console.log(m[app]??"")}finally{try{fs.rmdirSync(lock)}catch{}}`
      : `let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}` +
        `console.log(m[app]??"");`);
  const result = await provider.exec(
    ctx,
    `node -e ${sh(script)} ${JSON.stringify(appSlug(handle))} ${JSON.stringify(handle.appRoot)}`,
    { timeoutMs: 30_000 },
  );
  const port = Number(result.stdout.trim());
  return Number.isInteger(port) && port >= DEV_PORT_BASE ? port : null;
}
