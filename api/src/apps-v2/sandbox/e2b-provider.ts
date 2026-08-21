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
  SandboxTerminal,
  SandboxExecContext,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";

const logger = loggers.api("apps-v2-e2b");

/** Read at call time (not module load) so dotenv ordering can't freeze it. */
function templateId(): string {
  return process.env.APPS_V2_E2B_TEMPLATE?.trim() || "base";
}
const SANDBOX_USER = "user";
const REMOTE_ROOT = "/home/user/app";
/** Idle window before E2B auto-pauses the sandbox (resets on activity). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Sandbox-local build state: never synced in either direction (recreated by
 * installs inside the sandbox; excluded from WIP snapshots by .gitignore).
 */
export const SANDBOX_LOCAL = ["node_modules", ".npm", ".cache", ".vite"];
/**
 * `.git` DOES sync INTO the sandbox (fresh on every command) so in-session
 * `git status/log/diff` work like on the local substrate — the clone's origin
 * is an unreachable URL and the bare repo isn't network-visible from E2B, so
 * no credential or push path rides along. It never syncs OUT: the host copy
 * is the broker's staging area and stays authoritative.
 */
export const SYNC_OUT_IGNORES = [...SANDBOX_LOCAL, ".git"];

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

  const sandbox = await Sandbox.create(templateId(), {
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

/**
 * tar excludes for the sandbox-local dirs, matching at ANY depth.
 *
 * These MUST stay unanchored. §10 Block B moved apps from "the app is the repo
 * root" to `apps/<slug>/`, and `app2_bash` runs with cwd = the app root, so
 * every install now writes a NESTED `apps/<slug>/node_modules`. GNU tar treats
 * `--exclude ./node_modules` as rooted at the archive top, so the nested copy
 * was silently round-tripped: out to the host (where `stripLinks` deleted every
 * symlink in it, emptying `.bin/` and breaking `tsc`/`vite`), then back in on
 * the next command — tens of MB per exec, which is where the multi-second
 * per-command latency came from too.
 */
export function excludeArgs(): string[] {
  return SANDBOX_LOCAL.flatMap(name => ["--exclude", name]);
}

function packArgs(): string[] {
  return ["-czf", "-", ...excludeArgs(), "."];
}

/**
 * `find` predicates matching anything inside a sandbox-local dir at any depth,
 * so the sync-in wipe can preserve nested `node_modules` instead of deleting
 * it along with the `apps/` tree that contains it.
 */
export function sandboxLocalFindFilter(): string {
  return SANDBOX_LOCAL.flatMap(name => [
    `! -path ${JSON.stringify(`*/${name}`)}`,
    `! -path ${JSON.stringify(`*/${name}/*`)}`,
  ]).join(" ");
}

function hostTar(args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "tar",
      args,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 512 * 1024 * 1024,
        // macOS bsdtar otherwise writes an AppleDouble `._<name>` companion
        // entry for every file, which lands in the sandbox as visible junk
        // (`._package.json`, `._.git`, ...) and confuses tooling there.
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
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
  const keep = sandboxLocalFindFilter();
  const result = await sandbox.commands.run(
    // Remove everything the sync owns (incl. stale .git), keep sandbox-local
    // dirs (node_modules, ...) AT ANY DEPTH, then extract the fresh tree over
    // the top. Two passes because a blanket `rm -rf` on a parent would take a
    // preserved `apps/<slug>/node_modules` down with it: delete non-directories
    // first, then remove the directories that are left empty (depth-first, and
    // `rmdir` refuses non-empty ones, so any directory still holding a
    // preserved node_modules survives).
    [
      `cd ${REMOTE_ROOT}`,
      `find . -mindepth 1 ! -type d ${keep} -print0 | xargs -0 -r rm -f --`,
      `find . -mindepth 1 -depth -type d ${keep} -print0 | xargs -0 -r rmdir --ignore-fail-on-non-empty --`,
      `tar -xzf ${remoteTmp}`,
      `rm -f ${remoteTmp}`,
    ].join(" && "),
    { user: SANDBOX_USER, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`E2B sync-in failed: ${result.stderr.slice(0, 500)}`);
  }
}

/** Download the sandbox working root back over the host session dir. */
async function syncOut(sandbox: Sandbox, hostDir: string): Promise<void> {
  const remoteTmp = `/tmp/mako-sync-out-${Date.now()}.tgz`;
  // Unanchored, for the same reason as excludeArgs(): nested
  // `apps/<slug>/node_modules` must never leave the sandbox.
  const ignores = SYNC_OUT_IGNORES.flatMap(name => ["--exclude", name]).join(
    " ",
  );
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

  const tmpFile = path.join(
    os.tmpdir(),
    `mako-sync-out-${process.pid}-${Date.now()}.tgz`,
  );
  const staging = await fs.mkdtemp(
    path.join(os.tmpdir(), `mako-sync-stage-${process.pid}-`),
  );
  await fs.writeFile(tmpFile, Buffer.from(data));
  try {
    // Unpack and sanitise into a STAGING directory first, and only touch the
    // real session tree once that has fully succeeded.
    //
    // This used to delete the host tree and then extract into it. Any failure
    // between the two — a tar that rejects a flag, a corrupt download, a full
    // disk — left the working tree destroyed, and because the next sync-in
    // uploads the host tree, the loss propagated straight back into the
    // sandbox and wiped the app there too. Recovering meant `git checkout`,
    // and only because every change is committed.
    //
    // Hardening (adopted from the parallel branch's session-file policy):
    // tenant code controls this archive, so refuse anything that is not a
    // plain file/directory. GNU tar already refuses absolute paths and `..`
    // members by default; on top of that we skip symlinks and hardlinks so a
    // malicious link can't be smuggled onto the host and later followed by
    // the git snapshot or the preview static server.
    await hostTar(
      [
        "--no-same-owner",
        "--no-same-permissions",
        // GNU tar's --exclude-backups spelled out: it is GNU-only, and bsdtar
        // (the default `tar` on macOS) hard-fails on the unknown flag, which
        // made the E2B provider unusable on a Mac dev machine. These patterns
        // are exactly what it covers and both implementations accept them.
        "--exclude=*~",
        "--exclude=.#*",
        "--exclude=#*#",
        "--exclude=,*",
        "-xzf",
        tmpFile,
        "--exclude=./.git",
      ],
      staging,
    );
    await stripLinks(staging);

    // Staging is good: now swap it over the session tree. `.git` and the
    // sandbox-local dirs are ours, not the archive's, and stay put.
    const stale = await fs.readdir(hostDir);
    for (const entry of stale) {
      if (entry === ".git" || SANDBOX_LOCAL.includes(entry)) continue;
      await fs.rm(path.join(hostDir, entry), { recursive: true, force: true });
    }
    for (const entry of await fs.readdir(staging)) {
      if (entry === ".git" || SANDBOX_LOCAL.includes(entry)) continue;
      await fs.rename(path.join(staging, entry), path.join(hostDir, entry));
    }
  } finally {
    await fs.rm(tmpFile, { force: true });
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Remove symlinks/other non-regular files a tenant archive may contain. */
async function stripLinks(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        await fs.rm(abs, { force: true });
      } else if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        // Belt and braces: with the excludes above these should never reach
        // the host, but if one ever does, do NOT walk it — stripping symlinks
        // inside node_modules is what emptied `.bin/` and broke every build.
        if (SANDBOX_LOCAL.includes(entry.name)) continue;
        await walk(abs);
      } else if (!entry.isFile()) {
        await fs.rm(abs, { force: true });
      }
    }
  };
  await walk(root);
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

/**
 * Start a detached process and return as soon as it is running.
 *
 * Syncs the tree IN (the process needs current sources) but deliberately not
 * back OUT: the command has not finished, and a sync-out mid-run would race a
 * live dev server writing caches. Long-running work reaches the host through
 * the ordinary per-command syncs that follow.
 */
async function execDetachedE2b(
  ctx: SandboxExecContext,
  command: string,
  options: SandboxExecOptions = {},
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(IDLE_TIMEOUT_MS);
  await syncIn(sandbox, ctx.hostDir);
  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }
  const result = await sandbox.commands.run(command, {
    user: SANDBOX_USER,
    cwd,
    timeoutMs: 60_000,
    envs: {
      HOME: "/home/user",
      LANG: "C.UTF-8",
      TERM: "dumb",
      CI: "1",
      ...(options.env ?? {}),
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start detached process: ${result.stderr.slice(0, 500)}`,
    );
  }
}

async function writeFileE2b(
  ctx: SandboxExecContext,
  remotePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.files.write(remotePath, bytes.buffer as ArrayBuffer, {
    user: SANDBOX_USER,
  });
}

async function publicUrlForPortE2b(
  ctx: SandboxExecContext,
  port: number,
): Promise<string> {
  const sandbox = await connectSession(ctx.sessionKey);
  return `https://${sandbox.getHost(port)}`;
}

async function keepAliveE2b(
  ctx: SandboxExecContext,
  ms: number,
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(Math.max(IDLE_TIMEOUT_MS, ms));
}

/**
 * Open a shell in the sandbox and stream it.
 *
 * The tree is synced IN first so the shell starts on current sources, but not
 * back OUT: the session stays open and the user keeps typing, so there is no
 * moment that means "finished". Work leaves the sandbox the usual way, through
 * the syncs around ordinary commands.
 */
async function openTerminalE2b(
  ctx: SandboxExecContext,
  opts: {
    cwd: string;
    cols: number;
    rows: number;
    onData: (data: Uint8Array) => void;
  },
): Promise<SandboxTerminal> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(IDLE_TIMEOUT_MS);
  await syncIn(sandbox, ctx.hostDir);

  const cwd = path.posix.join(REMOTE_ROOT, opts.cwd);
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(opts.cwd)}`,
    );
  }

  const handle = await sandbox.pty.create({
    cols: opts.cols,
    rows: opts.rows,
    cwd,
    user: SANDBOX_USER,
    onData: opts.onData,
    // Long enough that a shell left open over lunch is still there.
    timeoutMs: IDLE_TIMEOUT_MS,
    envs: {
      HOME: "/home/user",
      LANG: "C.UTF-8",
      // A real terminal, so colour and redrawing work — this is the whole
      // reason for a PTY over one-shot commands.
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  // E2B's PTY always starts bash and ignores both SHELL and the account's
  // login shell, so hand off explicitly. `exec` REPLACES bash rather than
  // nesting, so ctrl-D and `exit` end the session once, as expected. Guarded,
  // so a template without zsh simply stays in bash instead of breaking.
  await sandbox.pty.sendInput(
    handle.pid,
    new TextEncoder().encode(
      "command -v zsh >/dev/null && { clear; exec zsh -l; }\n",
    ),
  );

  return {
    write: data => sandbox.pty.sendInput(handle.pid, data),
    resize: (cols, rows) => sandbox.pty.resize(handle.pid, { cols, rows }),
    close: async () => {
      await handle.kill().catch(() => undefined);
    },
  };
}

export const e2bSandboxProvider: SandboxProvider = {
  id: "e2b",
  exec: execE2b,
  execDetached: execDetachedE2b,
  writeFile: writeFileE2b,
  openTerminal: openTerminalE2b,
  publicUrlForPort: publicUrlForPortE2b,
  keepAlive: keepAliveE2b,
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
