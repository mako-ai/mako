/**
 * ensureDevServer: launch (or reattach to) an app's dev server, single-flight
 * per (session, app), and release its port slot.
 */
import { getSandboxProvider } from "../sandbox/provider";
import {
  boxCtx,
  ensureBox,
  isMissingCwd,
  rehydrateBox,
  type WorktreeHandle,
  sessionKeyFor,
  handleProject,
} from "../worktree.service";
import { loggers } from "../../logging";
import { boxEnvPath, sh } from "../box";
import { probeReachable } from "../box-state.service";
import { resolveAppEnv } from "../env.service";

import {
  DEV_SESSION_KEEPALIVE_MS,
  appSlug,
  devLogPath,
  devSockPath,
  launcherPath,
  dataDir,
  devPort,
} from "./paths";
import { launcherSource } from "./launcher";
import { stageBindingData } from "./staging";
import {
  listening,
  servingState,
  reapDevServerBySlug,
  enforceRunningCap,
} from "./status";

const logger = loggers.api("apps-dev-server");

export interface DevPreview {
  /** Public origin the browser should iframe. */
  url: string;
  /** Binding names whose data was staged into the session. */
  stagedBindings: string[];
  /** Other apps' dev servers stopped to stay within the running cap, if any. */
  evicted?: string[];
}

/**
 * Ensure a dev server is running for this app and return its public URL.
 *
 * Idempotent: a server that is already listening is reused, so repeated
 * previews do not restart vite and lose its module graph. Other apps' dev
 * servers are left alone — each has its own port.
 */
const launching = new Map<string, Promise<DevPreview>>();

/**
 * Release an app's dev-server registry slot after its session was killed
 * out-of-band (leaving dev mode kills the pty tree, but the port registry is
 * a file the kill never touches). Without this the dead entry retires its
 * port FOREVER: allocation treats every registry value as taken
 * (`used.has(p) → p++`), and the box agent never ticks idle time for a
 * server it cannot probe alive — so nothing else cleans it either (§13.20).
 *
 * Addresses the box directly by session key, never ensureBox: cleaning a
 * registry must not boot a machine, and a box that is gone took its
 * registry with it (best effort, logged).
 */
export async function releaseDevServerSlot(
  workspaceId: string,
  userId: string,
  slug: string | null,
): Promise<void> {
  if (!slug) return;
  const provider = getSandboxProvider();
  const ctx = { sessionKey: sessionKeyFor(workspaceId, userId) };
  await reapDevServerBySlug(provider, ctx, slug).catch(error => {
    logger.debug("Apps dev-server release skipped (box unreachable?)", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function ensureDevServer(
  handle: WorktreeHandle,
  options: { restart?: boolean } = {},
): Promise<DevPreview> {
  // Single-flight per (session, app): the workbench can ask for the dev
  // server from more than one place at once (mount effect + status poll +
  // StrictMode double-invoke), and two concurrent launches race — the loser
  // binds a busy port and dies, taking shared state down with it. All
  // concurrent callers share one launch instead.
  const key = `${boxCtx(handle).sessionKey}:${handle.appRoot}`;
  const inflight = launching.get(key);
  if (inflight) return inflight;
  const run = ensureDevServerLaunch(handle, options).finally(() => {
    launching.delete(key);
  });
  launching.set(key, run);
  return run;
}

async function ensureDevServerLaunch(
  handle: WorktreeHandle,
  options: { restart?: boolean } = {},
): Promise<DevPreview> {
  const provider = getSandboxProvider();
  const ctx = await ensureBox(handle);
  // The provider knows where the working copy lives — hardcoding the E2B
  // path here made every local-provider dev preview die on a launcher that
  // imported vite from a directory that only exists in a microVM.
  const appDir = `${provider.root(ctx)}/${handle.appRoot}`;

  await provider.keepAlive(ctx, DEV_SESSION_KEEPALIVE_MS);

  // A requested RESTART must not be short-circuited by the idempotent
  // reuse below — that made the UI's Restart button a silent no-op. And it
  // must happen BEFORE the port allocation: the reap deletes this app's
  // registry entry, so reaping after allocating orphaned the fresh server
  // from the registry — every discovery (browse, dots, status) then swore
  // no server existed while vite served happily.
  if (options.restart) {
    logger.info("Apps dev server restart requested; stopping the old one", {
      appRoot: handle.appRoot,
    });
    await reapDevServerBySlug(provider, ctx, appSlug(handle));
  }

  const port = await devPort(handle, provider, ctx, { allocate: true });
  if (!port) throw new Error("Could not allocate a dev-server port");
  const logPath = devLogPath(handle);
  const launcher = launcherPath(handle);

  const state = await servingState(provider, ctx, handle, port);
  if (state === "orphan") {
    // An older-generation server holds the port without a session. Kill it
    // by its launcher paths (this app's, plus the pre-per-app global name)
    // — never by port pattern, other apps' servers are innocent.
    await provider.exec(
      ctx,
      `pkill -f "[m]ako-dev-${appSlug(handle)}.mjs" 2>/dev/null; pkill -f "[m]ako-dev-server.mjs" 2>/dev/null; sleep 1; echo reaped`,
      { timeoutMs: 30_000 },
    );
    logger.warn("Apps dev server orphan reaped", {
      projectId: handleProject(handle)._id.toString(),
      appRoot: handle.appRoot,
    });
  }
  // Still answering after the reap means the server is not ours to kill —
  // someone started it from a shell (npm run dev). Adopt it: show it, do
  // not launch a second vite into the same port.
  let adopted = state === "orphan" && (await listening(provider, ctx, port));
  if (adopted) {
    // Only adopt a server the browser can actually reach. A vite started
    // from a shell without `server.allowedHosts` 403s the preview host;
    // "restart" of such a server means exactly this: replace it with one
    // that Mako runs. Kill by port — the launcher-path reap cannot see it.
    const url = await provider.publicUrlForPort(ctx, port);
    if (await probeReachable(url)) {
      logger.info("Apps adopting a dev server started outside Mako", {
        appRoot: handle.appRoot,
        port,
      });
    } else {
      logger.warn("Apps replacing a dev server that rejects the preview host", {
        appRoot: handle.appRoot,
        port,
      });
      await provider.exec(
        ctx,
        `pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill "$pid" 2>/dev/null; sleep 1; echo replaced`,
        { timeoutMs: 30_000 },
      );
      adopted = false;
    }
  }
  const wasListening = state === "serving" || adopted;
  let evicted: string[] = [];
  if (!wasListening) {
    // Make room BEFORE launching: never let this box exceed the running cap.
    evicted = await enforceRunningCap(provider, ctx, appSlug(handle));
    // The app's own env vars (env.service), applied at LAUNCH: dtach → script
    // → node → vite inherit them, so `VITE_*` reaches import.meta.env and the
    // rest reaches the dev-server process. dev target = secrets included;
    // this launch env is the only place a secret ever exists in the box.
    // Edits made while a server runs apply on its next (re)start.
    let appEnv: Record<string, string> = {};
    try {
      appEnv = await resolveAppEnv(handleProject(handle), "dev");
    } catch (error) {
      // A missing vault must not take dev mode down with it.
      logger.warn("Apps env resolution failed; launching without app env", {
        appRoot: handle.appRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const write = await provider.exec(
      ctx,
      `cat > ${launcher} <<'MAKO_LAUNCHER_EOF'\n${launcherSource(appDir, port, dataDir(handle), appSlug(handle), boxEnvPath(ctx), appEnv)}\nMAKO_LAUNCHER_EOF\nprintf %s ${sh(appDir)} > /tmp/mako-dev-${appSlug(handle)}.dir\necho written`,
      { timeoutMs: 30_000 },
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `Could not write the dev-server launcher: ${write.stderr}`,
      );
    }

    // The dev server is a SESSION the workbench attaches to like any shell:
    // dtach -n creates it headless on the standard socket, script(1) gives
    // vite a REAL PTY (so it prints colors) and records everything to the
    // same file the install step teed into — one recording holds the whole
    // boot, and the dev terminal's prefill replays it. Ctrl-C typed in the
    // attached window reaches vite and ends the session; the stale-socket
    // rm covers a SIGKILLed predecessor. Fallbacks: tmux (headless, no
    // attach UI), then plain nohup.
    const devSock = devSockPath(handle);
    const devSession = `mako-dev-${appSlug(handle)}`;
    const launchCmd =
      // The stale-socket rm is guarded: rm ONLY when no dtach master holds
      // the socket. Two racing launches used to both pass the serving check,
      // and the loser's unconditional rm unlinked the WINNER's socket before
      // crashing on the busy port — leaving a healthy server that discovery
      // reported as down forever. With the guard, the loser's dtach -n just
      // fails against the existing socket and the winner is untouched.
      `if command -v dtach >/dev/null && command -v script >/dev/null; then if ! pgrep -f "dtach -n ${devSock}" >/dev/null 2>&1; then rm -f ${devSock}; fi; dtach -n ${devSock} script -qfa -c 'node ${launcher} 2>&1' ${logPath} || true; ` +
      // A stale same-name session (its process reaped, tmux shell lingering)
      // makes new-session fail SILENTLY under the `|| true` — the launch
      // no-ops and the poll below times out. Clear it first; the port's
      // owner was already reaped by the caller.
      `elif command -v tmux >/dev/null; then tmux kill-session -t ${devSession} 2>/dev/null; tmux new-session -d -s ${devSession} 'node ${launcher} 2>&1 | tee -a ${logPath}' 2>/dev/null || true; ` +
      `else nohup node ${launcher} >> ${logPath} 2>&1 & fi; echo started`;
    try {
      await provider.execDetached(ctx, launchCmd, {
        cwd: handle.appRoot,
        timeoutMs: 60_000,
        env: appEnv,
      });
    } catch (error) {
      if (!isMissingCwd(error)) throw error;
      // A recycle swapped machines under this request; hydrate and retry.
      await rehydrateBox(handle, ctx);
      await provider.execDetached(ctx, launchCmd, {
        cwd: handle.appRoot,
        timeoutMs: 60_000,
        env: appEnv,
      });
    }

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
      logger.warn("Apps background binding restage failed", {
        projectId: handleProject(handle)._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    stagedBindings = await stageBindingData(handle, provider, ctx);
  }

  const url = await provider.publicUrlForPort(ctx, port);
  logger.info("Apps dev preview ready", {
    projectId: handleProject(handle)._id.toString(),
    appRoot: handle.appRoot,
    stagedBindings,
    ...(evicted.length ? { evicted } : {}),
  });
  return { url, stagedBindings, ...(evicted.length ? { evicted } : {}) };
}
