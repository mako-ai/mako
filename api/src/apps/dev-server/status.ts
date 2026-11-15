/**
 * Is a dev server serving: the session socket and the port, discovery of
 * every running one, and the cap on how many run at once.
 */
import {
  getSandboxProvider,
  isSandboxGone,
  type SandboxExecContext,
  type SandboxExecResult,
} from "../sandbox/provider";
import { boxCtx, type WorktreeHandle } from "../worktree.service";
import { loggers } from "../../logging";
import { sh } from "../box";
import { ensureBoxAgent } from "../box-agent";
import { getBoxState } from "../box-state.service";

import {
  PORTS_REGISTRY,
  MAX_RUNNING_DEV_SERVERS,
  appSlug,
  devSockPath,
  devPort,
} from "./paths";

const logger = loggers.api("apps-dev-server");

/**
 * Is THIS app's dev server up? Per-app ports make identity trivial: the port
 * came from the registry keyed by app, so "the port answers" IS the check —
 * the marker file and takeover of the single-port era are gone.
 */
export async function listening(
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
 * Is the dev server SERVING — with its session intact?
 *
 * "The port answers" stopped being the whole truth once the server became a
 * session: an orphaned older-generation process can hold the port while the
 * dtach session is gone. Reusing that orphan looks fine in the iframe but
 * is exactly wrong everywhere else — the new session dies on EADDRINUSE,
 * the dev window waits forever, and Ctrl-C kills a session that was not
 * the thing serving. Three answers:
 *   serving — port up and (where dtach exists) the session socket with it
 *   orphan  — port up but the session is gone: kill and relaunch
 *   down    — nothing listening
 */
export async function servingState(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  handle: WorktreeHandle,
  port: number,
): Promise<"serving" | "orphan" | "down"> {
  const probe = await provider.exec(
    ctx,
    `if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${port}/; then ` +
      `if command -v dtach >/dev/null; then test -S ${devSockPath(handle)} && echo serving || echo orphan; ` +
      `else echo serving; fi; else echo down; fi`,
    { timeoutMs: 15_000 },
  );
  if (probe.stdout.includes("serving")) return "serving";
  if (probe.stdout.includes("orphan")) return "orphan";
  return "down";
}

/**
 * Is this app's dev server already up in an existing sandbox? Never creates
 * a sandbox and never allocates a port. The reattach path uses this to keep
 * its hands off the boot log: truncating it and then skipping the launch
 * (because the server was already running) left the Dev server tab
 * permanently blank after a page reload.
 */
export async function isServingApp(handle: WorktreeHandle): Promise<boolean> {
  return (await devServerStatus(handle)).serving;
}

/**
 * Every dev server serving in the box right now, by discovery. One exec.
 * Used to seed a cold box-state snapshot, so that the first launcher delta
 * to arrive does not pose as the full list and mark every OTHER running
 * server down.
 *
 * Truth is the PORT, exactly as the box agent defines it: each registered
 * port is probed with a raw TCP connect inside the box. The old heuristic —
 * "a dtach socket file exists" — survived the death of the server it named
 * (sockets are not cleaned up by a crash or a resume), so a box could show
 * green dots for servers that had been dead for hours.
 */
export async function discoverDevServers(
  ctx: SandboxExecContext,
): Promise<Array<{ slug: string; port: number }>> {
  const provider = getSandboxProvider();
  if (!(await provider.hasSession(ctx))) return [];
  // Any touch of a box is a chance to refresh its agent: a resumed box can
  // sit for hours with a stale (or silently dead) agent otherwise, because
  // nothing but the ensureBox flows ever reinstalled it. Throttled inside.
  void ensureBoxAgent(ctx);
  const script =
    `const fs=require("fs"),net=require("net");` +
    `let m={};try{m=JSON.parse(fs.readFileSync(${JSON.stringify(PORTS_REGISTRY)},"utf8"))}catch{}` +
    `const entries=Object.entries(m).filter(e=>Number.isInteger(e[1]));` +
    `let left=entries.length;const out=[];` +
    `if(!left){console.log("[]");process.exit(0)}` +
    `entries.forEach(([k,p])=>{let d=false;const s=net.connect(p,"127.0.0.1");` +
    `const done=ok=>{if(d)return;d=true;try{s.destroy()}catch{}` +
    `if(ok)out.push({slug:k.replace(/^apps\\//,""),port:p});` +
    `if(--left===0)console.log(JSON.stringify(out))};` +
    `s.setTimeout(800);s.once("connect",()=>done(true));` +
    `s.once("error",()=>done(false));s.once("timeout",()=>done(false));});`;
  // "Empty when none is running" is this function's contract, and a box that
  // has gone is a box with nothing running in it. hasSession above can still
  // answer from a stale memory of an idle-killed sandbox (it forgets one the
  // moment an exec proves it dead), so the exec is where the truth arrives —
  // as an error that must not become a 500 on a discovery endpoint.
  let result: SandboxExecResult;
  try {
    result = await provider.exec(ctx, `node -e ${sh(script)}`, {
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (isSandboxGone(error)) return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]") as Array<{
      slug: string;
      port: number;
    }>;
    return parsed.filter(
      d => d && typeof d.slug === "string" && Number.isInteger(d.port),
    );
  } catch {
    return [];
  }
}

/**
 * Discovery, not memory: is this app's dev server serving, and where?
 * The url lets a fresh browser (no client-side state at all) walk up to an
 * app whose server is already running and just show it.
 */
export async function devServerStatus(
  handle: WorktreeHandle,
): Promise<{ serving: boolean; url?: string; reachable?: boolean }> {
  const provider = getSandboxProvider();
  const ctx = boxCtx(handle);
  // Snapshot first (pushed by the box; expires unless refreshed): no exec.
  const snapshot = await getBoxState(ctx.sessionKey);
  if (snapshot?.devServers) {
    const entry = snapshot.devServers.find(d => d.slug === appSlug(handle));
    if (!entry) return { serving: false };
    // Peek, never create: status must not boot a machine (§13.9).
    const url =
      entry.url ?? (await provider.peekPublicUrlForPort(ctx, entry.port));
    if (!url) return { serving: false };
    return { serving: true, url, reachable: entry.reachable };
  }
  if (!(await provider.hasSession(ctx))) return { serving: false };
  const port = await devPort(handle, provider, ctx, { allocate: false });
  if (!port) return { serving: false };
  if ((await servingState(provider, ctx, handle, port)) !== "serving") {
    return { serving: false };
  }
  const url = await provider.peekPublicUrlForPort(ctx, port);
  if (!url) return { serving: false };
  return { serving: true, url };
}

/**
 * Stop one app's dev server and free its registry slot — a STOP, never a
 * start. Kills the launcher process (which is vite), removes the session
 * socket, and deletes the app's port from the registry so a fresh launch
 * reallocates cleanly. Used by the running-cap here and, in-box, by the
 * agent's idle reaper.
 */
export async function reapDevServerBySlug(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  slug: string,
): Promise<void> {
  // Slugs are sanitized app-folder names; refuse anything else rather than
  // interpolate it into a shell.
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return;
  await provider
    .exec(
      ctx,
      `pkill -f "[m]ako-dev-${slug}.mjs" 2>/dev/null; rm -f /tmp/mako-term-dev-${slug}.sock; ` +
        `node -e 'const fs=require("fs");const f=${JSON.stringify(PORTS_REGISTRY)};let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}delete m[process.argv[1]];delete m["apps/"+process.argv[1]];try{fs.writeFileSync(f,JSON.stringify(m))}catch{}' ${JSON.stringify(slug)}; echo reaped`,
      { timeoutMs: 30_000 },
    )
    .catch(() => undefined);
}

/**
 * Enforce the per-box running cap before launching a NEW server: evict the
 * oldest others (lowest port ≈ earliest allocated) until this one fits under
 * MAX_RUNNING_DEV_SERVERS. Returns the slugs it stopped, so the caller can
 * tell the user what was closed to make room.
 */
export async function enforceRunningCap(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  selfSlug: string,
): Promise<string[]> {
  const running = await discoverDevServers(ctx);
  if (running.some(d => d.slug === selfSlug)) return [];
  const others = running
    .filter(d => d.slug !== selfSlug)
    .sort((a, b) => a.port - b.port);
  const overflow = others.length - (MAX_RUNNING_DEV_SERVERS - 1);
  if (overflow <= 0) return [];
  const victims = others.slice(0, overflow);
  for (const v of victims) {
    await reapDevServerBySlug(provider, ctx, v.slug);
    logger.info("Apps dev server evicted to honor the running cap", {
      evicted: v.slug,
      cap: MAX_RUNNING_DEV_SERVERS,
    });
  }
  return victims.map(v => v.slug);
}
