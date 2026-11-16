/**
 * What the sandbox routes (routes/apps/sandbox.ts) do inside the caller's
 * box: build a preview, boot the live dev preview, read the box's stats,
 * tail a log, and recycle the machine.
 */
import fs from "node:fs/promises";
import type { IAppProject } from "../database/workspace-schema";
import { readBoxDir } from "./box";
import { markBoxOffline } from "./box-state.service";
import { previewStagingDir } from "./config";
import { buildApp } from "./deployment.service";
import {
  devLogPath,
  ensureDevServer,
  isServingApp,
} from "./dev-server.service";
import { installCommand } from "./package-manager";
import { mintPreviewGrant, type ViewerIdentity } from "./preview.service";
import {
  boxIsRunning,
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import { forgetTerminalCaches } from "./terminal-ws";
import {
  boxCtx,
  commitWorktree,
  execInWorktree,
  forgetBoxCaches,
  type WorktreeHandle,
} from "./worktree.service";

type Author = { name: string; email: string } | undefined;

/**
 * Build the app in the caller's box exactly as a publish would and stage
 * `dist/` for the token-gated preview server.
 */
export async function buildPreview(
  project: IAppProject,
  handle: WorktreeHandle,
  opts: { author: Author; viewer?: ViewerIdentity },
): Promise<
  | { ok: false; output: string }
  | { ok: true; token: string; expiresAt: number; buildOutput: string }
> {
  // Same build as a publish would run: the whole point of previewing a
  // build is that it is the same artifact, produced the same way.
  const build = await buildApp(handle, execInWorktree);
  if (!build.ok) return { ok: false, output: build.output };

  // The install can leave a new/updated lockfile in the worktree (e.g.
  // the scaffold ships without one). Commit it immediately rather than
  // leaving it as WIP — every mutating action here should end in a real
  // commit, same as chat turns, not just an in-progress build.
  await commitWorktree(handle, "chore: install dependencies", opts.author);

  // The build output is in the sandbox; the static preview server reads
  // from disk. Stage just `dist/` out to a deterministic directory, which
  // the next build overwrites — the API keeps no working copy, only this
  // narrow, disposable artifact.
  const staging = previewStagingDir(project._id.toString());
  await fs.rm(staging, { recursive: true, force: true });
  await readBoxDir(boxCtx(handle), `${handle.appRoot}/dist`, staging);

  const grant = mintPreviewGrant({
    workspaceId: project.workspaceId.toString(),
    projectId: project._id.toString(),
    rootDir: staging,
    // The builder previewing their own build: `useViewer()` is them.
    viewer: opts.viewer,
  });
  return {
    ok: true,
    token: grant.token,
    expiresAt: grant.expiresAt,
    buildOutput: build.output.slice(-2000),
  };
}

export type DevPreviewOutcome =
  | ({ ok: true } & Awaited<ReturnType<typeof ensureDevServer>>)
  | {
      ok: false;
      status: 422;
      error: string;
      stdout: string;
      stderr: string;
    }
  | { ok: false; status: 500; error: string };

/**
 * Start (or reattach to) the app's `vite dev` in the box: install
 * dependencies into the boot log when nothing is serving yet, then launch.
 */
export async function startDevPreview(
  handle: WorktreeHandle,
  opts: { restart: boolean },
): Promise<DevPreviewOutcome> {
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
      return {
        ok: false,
        status: 422,
        error: "Dependency install failed",
        stdout: install.stdout.slice(-4000),
        stderr: install.stderr.slice(-4000),
      };
    }
  }

  // §12.4: vite runs inside the sandbox and E2B publishes the port, so
  // the browser loads it directly — there is no Mako-side proxy or token
  // to mint for this tier.
  try {
    return { ok: true, ...(await ensureDevServer(handle, opts)) };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error:
        error instanceof Error ? error.message : "Failed to start dev server",
    };
  }
}

export interface SandboxStats {
  uptimeSec: number;
  cores: number;
  load: string;
  cpuPct: number;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
  sessions: number;
}

/** One exec inside the box (with a 1 s CPU sample). */
export async function sandboxStats(
  ctx: SandboxExecContext,
): Promise<SandboxStats> {
  const stats = await getSandboxProvider().exec(
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
  return {
    uptimeSec: Number(fields.UPTIME) || 0,
    cores: Number(fields.CORES) || 0,
    load: fields.LOAD ?? "",
    cpuPct: Number(fields.CPU_PCT) || 0,
    memTotal: Number(fields.MEM_TOTAL) || 0,
    memUsed: Number(fields.MEM_USED) || 0,
    diskTotal: Number(fields.DISK_TOTAL) || 0,
    diskUsed: Number(fields.DISK_USED) || 0,
    sessions: Number(fields.SESSIONS) || 0,
  };
}

/**
 * A log file in the box from byte `offset` on, with its current size for
 * the next poll. Never starts a sandbox: none running is an empty chunk.
 */
export async function tailBoxLog(
  ctx: SandboxExecContext,
  logPath: string,
  offset: number,
): Promise<{ size: number; chunk: string }> {
  // Running, not present: this is a 1.5 s poll, and an exec into a paused
  // box resumes it.
  if (!(await boxIsRunning(ctx))) {
    return { size: 0, chunk: "" };
  }
  const result = await getSandboxProvider().exec(
    ctx,
    // Size first, then the requested slice, capped so one poll can never
    // exceed the provider's output budget.
    `wc -c < ${logPath} 2>/dev/null || echo 0; tail -c +${offset + 1} ${logPath} 2>/dev/null | head -c 65536`,
    { timeoutMs: 15_000 },
  );
  const newline = result.stdout.indexOf("\n");
  const size = Number(result.stdout.slice(0, newline).trim()) || 0;
  const chunk = result.stdout.slice(newline + 1);
  return { size, chunk };
}

/** Kill the (workspace, user) sandbox; the next touch builds a fresh one. */
export async function recycleSandbox(
  handle: WorktreeHandle,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const ctx = boxCtx(handle);
  await getSandboxProvider().destroySession?.(ctx.sessionKey);
  // The machine is gone; so is everything the API believed about it.
  forgetBoxCaches(ctx.sessionKey);
  forgetTerminalCaches(ctx.sessionKey);
  // Tell every open tab NOW, so a second browser drops its dead sandbox
  // URL instead of waiting for a poll to fail or the cache TTL to lapse.
  await markBoxOffline(workspaceId, actorId);
}
