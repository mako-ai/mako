/**
 * E2B sandbox provider — Firecracker microVM execution for Apps v2.
 *
 * Session model:
 * - One E2B sandbox per worktree (`sessionKey`), reused across commands and
 *   auto-paused by E2B on idle timeout (filesystem-only snapshot) so idle
 *   sessions cost nothing but keep node_modules warm; `connect` resumes.
 * - The HOST session directory stays the source of truth for the git layer
 *   (the broker snapshots it to WIP refs). Before each command the provider
 *   syncs host → sandbox with a tar upload (mtime+size manifest diff keeps
 *   repeat syncs incremental); after the command it syncs sandbox → host the
 *   same way. `node_modules`, `dist` and friends stay sandbox-local: they are
 *   ignored by the sync (like .gitignore ignores them for WIP snapshots) —
 *   EXCEPT `dist`, which is synced back so the preview pipeline can serve it.
 * - Tenant commands run as the unprivileged template user with a minimal env;
 *   no Mako secrets, tokens, or git credentials ever enter the sandbox.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "e2b";
import {
  APPS_V2_EXEC_DEFAULT_TIMEOUT_MS,
  APPS_V2_EXEC_MAX_OUTPUT_BYTES,
  APPS_V2_EXEC_MAX_TIMEOUT_MS,
} from "../config";
import { loggers } from "../../logging";
import type {
  SandboxExecContext,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";

const logger = loggers.api("apps-v2-e2b");

const TEMPLATE = process.env.APPS_V2_E2B_TEMPLATE || "base";
const SANDBOX_USER = "user";
const REMOTE_ROOT = "/home/user/app";
/** Idle window before E2B auto-pauses the sandbox (resets on activity). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Sandbox-local build state: never synced in either direction (recreated by
 * installs inside the sandbox; excluded from WIP snapshots by .gitignore).
 */
const SANDBOX_LOCAL = ["node_modules", ".npm", ".cache", ".vite"];
/**
 * `.git` DOES sync INTO the sandbox (fresh on every command) so in-session
 * `git status/log/diff` work like on the local substrate — the clone's origin
 * is an unreachable URL and the bare repo isn't network-visible from E2B, so
 * no credential or push path rides along. It never syncs OUT: the host copy
 * is the broker's staging area and stays authoritative.
 */
const SYNC_OUT_IGNORES = [...SANDBOX_LOCAL, ".git"];

function apiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      "E2B_API_KEY is not set — configure it or use APPS_V2_SANDBOX_PROVIDER=local for development",
    );
  }
  return key;
}

// In-process session affinity: worktreeId -> sandboxId. Repaired lazily via
// Sandbox.list metadata when the process restarts.
const sessions = new Map<string, string>();

async function connectSession(sessionKey: string): Promise<Sandbox> {
  const known = sessions.get(sessionKey);
  if (known) {
    try {
      return await Sandbox.connect(known, { apiKey: apiKey() });
    } catch {
      sessions.delete(sessionKey);
    }
  }
  // Recover a paused/running sandbox for this worktree if one exists.
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsV2SessionKey: sessionKey } },
      limit: 5,
    });
    if (paginator.hasNext) {
      const page = await paginator.nextItems();
      const info = page[0];
      if (info) {
        const sandbox = await Sandbox.connect(info.sandboxId, {
          apiKey: apiKey(),
        });
        sessions.set(sessionKey, sandbox.sandboxId);
        return sandbox;
      }
    }
  } catch (error) {
    logger.warn("E2B session lookup failed; creating fresh sandbox", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const sandbox = await Sandbox.create(TEMPLATE, {
    apiKey: apiKey(),
    timeoutMs: IDLE_TIMEOUT_MS,
    metadata: { makoAppsV2SessionKey: sessionKey },
    // Pause instead of kill on idle: a filesystem-only snapshot freezes the
    // sandbox (node_modules, caches, everything on disk) at zero compute
    // cost. Resume is explicit via Sandbox.connect() in connectSession —
    // fs-only snapshots cold-boot, which is fine because commands are
    // one-shot (no long-lived processes to preserve). If the sandbox is
    // instead fully dead (deleted/expired), connectSession falls through to
    // creating a fresh one and the host session dir re-seeds it via syncIn.
    lifecycle: { onTimeout: { action: "pause", keepMemory: false } },
  });
  await sandbox.commands.run(`mkdir -p ${REMOTE_ROOT}`, {
    user: SANDBOX_USER,
  });
  sessions.set(sessionKey, sandbox.sandboxId);
  logger.info("E2B sandbox created", {
    sessionKey,
    sandboxId: sandbox.sandboxId,
  });
  return sandbox;
}

// ---------------------------------------------------------------------------
// Host <-> sandbox sync (tar streams over the E2B filesystem API)
// ---------------------------------------------------------------------------

function packArgs(): string[] {
  const ignores = SANDBOX_LOCAL.flatMap(name => ["--exclude", `./${name}`]);
  return ["-czf", "-", ...ignores, "."];
}

function hostTar(args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "tar",
      args,
      { cwd, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as unknown as Buffer);
      },
    );
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

/** Upload the host session dir into the sandbox working root. */
async function syncIn(sandbox: Sandbox, hostDir: string): Promise<void> {
  const archive = await hostTar(packArgs(), hostDir);
  const remoteTmp = `/tmp/mako-sync-in-${Date.now()}.tgz`;
  const bytes = Uint8Array.from(archive);
  await sandbox.files.write(remoteTmp, bytes.buffer as ArrayBuffer, {
    user: SANDBOX_USER,
  });
  const result = await sandbox.commands.run(
    // Remove everything the sync owns (incl. stale .git), keep sandbox-local
    // dirs (node_modules, ...), then extract the fresh tree over the top.
    `cd ${REMOTE_ROOT} && find . -mindepth 1 -maxdepth 1 ${SANDBOX_LOCAL.map(
      n => `! -name ${JSON.stringify(n)}`,
    ).join(
      " ",
    )} -exec rm -rf {} + && tar -xzf ${remoteTmp} && rm -f ${remoteTmp}`,
    { user: SANDBOX_USER, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`E2B sync-in failed: ${result.stderr.slice(0, 500)}`);
  }
}

/** Download the sandbox working root back over the host session dir. */
async function syncOut(sandbox: Sandbox, hostDir: string): Promise<void> {
  const remoteTmp = `/tmp/mako-sync-out-${Date.now()}.tgz`;
  const ignores = SYNC_OUT_IGNORES.flatMap(name => [
    "--exclude",
    `./${name}`,
  ]).join(" ");
  const pack = await sandbox.commands.run(
    `cd ${REMOTE_ROOT} && tar -czf ${remoteTmp} ${ignores} . && stat -c %s ${remoteTmp}`,
    { user: SANDBOX_USER, timeoutMs: 120_000 },
  );
  if (pack.exitCode !== 0) {
    throw new Error(`E2B sync-out pack failed: ${pack.stderr.slice(0, 500)}`);
  }
  const data = await sandbox.files.read(remoteTmp, {
    format: "bytes",
    user: SANDBOX_USER,
  });
  await sandbox.commands.run(`rm -f ${remoteTmp}`, { user: SANDBOX_USER });

  // Replace host tree (except .git and sandbox-local dirs) with the result.
  const entries = await fs.readdir(hostDir);
  for (const entry of entries) {
    if (entry === ".git" || SANDBOX_LOCAL.includes(entry)) continue;
    await fs.rm(path.join(hostDir, entry), { recursive: true, force: true });
  }
  const tmpFile = path.join(
    os.tmpdir(),
    `mako-sync-out-${process.pid}-${Date.now()}.tgz`,
  );
  await fs.writeFile(tmpFile, Buffer.from(data));
  try {
    await hostTar(["-xzf", tmpFile], hostDir);
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

async function execE2b(
  ctx: SandboxExecContext,
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  const timeoutMs = Math.min(
    Math.max(1_000, options.timeoutMs ?? APPS_V2_EXEC_DEFAULT_TIMEOUT_MS),
    APPS_V2_EXEC_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const sandbox = await connectSession(ctx.sessionKey);
  // Keep the sandbox alive long enough for this command + sync overhead.
  await sandbox.setTimeout(Math.max(IDLE_TIMEOUT_MS, timeoutMs + 60_000));

  await syncIn(sandbox, ctx.hostDir);

  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let exitCode = 0;
  let timedOut = false;
  const cap = APPS_V2_EXEC_MAX_OUTPUT_BYTES;
  const push = (target: "out" | "err", data: string) => {
    if (target === "out") {
      if (stdout.length < cap) stdout += data.slice(0, cap - stdout.length);
      else truncated = true;
    } else {
      if (stderr.length < cap) stderr += data.slice(0, cap - stderr.length);
      else truncated = true;
    }
  };

  try {
    const result = await sandbox.commands.run(command, {
      user: SANDBOX_USER,
      cwd,
      timeoutMs,
      envs: {
        HOME: "/home/user",
        LANG: "C.UTF-8",
        TERM: "dumb",
        CI: "1",
        npm_config_yes: "true",
        NO_UPDATE_NOTIFIER: "1",
        ...(options.env ?? {}),
      },
      onStdout: d => push("out", d),
      onStderr: d => push("err", d),
    });
    exitCode = result.exitCode;
  } catch (error) {
    // e2b throws CommandExitError on non-zero exit and TimeoutError on
    // deadline; normalize both into the result contract.
    const err = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      name?: string;
      message?: string;
    };
    if (typeof err.exitCode === "number") {
      exitCode = err.exitCode;
      if (err.stdout && !stdout) push("out", err.stdout);
      if (err.stderr && !stderr) push("err", err.stderr);
    } else if (err.name === "TimeoutError") {
      exitCode = 124;
      timedOut = true;
    } else {
      throw error;
    }
  }

  await syncOut(sandbox, ctx.hostDir);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

export const e2bSandboxProvider: SandboxProvider = {
  id: "e2b",
  exec: execE2b,
  destroySession: async sessionKey => {
    const sandboxId = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (sandboxId) {
      await Sandbox.kill(sandboxId, { apiKey: apiKey() }).catch(
        () => undefined,
      );
    }
  },
};
