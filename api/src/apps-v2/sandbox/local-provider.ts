/**
 * A sandbox that is just a directory on this machine. DEVELOPMENT AND TESTS
 * ONLY — it refuses to load in production, and the reason is not a formality.
 *
 * N1 says tenant code never runs in the API process. This provider breaks that
 * rule by construction: `exec` spawns a shell on the host, with the host's
 * filesystem and the host's network. Under E2B the same call lands in a
 * Firecracker microVM with none of that. So the guard below is the whole
 * safety story, and it is deliberately a hard failure at import time rather
 * than a config warning someone can miss.
 *
 * It exists because the sandbox is now the ONLY working copy. Before that, a
 * developer without E2B credentials could still edit files, because edits went
 * to a directory on the API host; now every write goes through a provider, so
 * with only the E2B provider available there is no way to run Mako — or its
 * tests — without a live E2B account and a network round trip per file write.
 * A local directory playing the part of the sandbox restores both.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appsV2SessionsRoot } from "../config";
import { loggers } from "../../logging";
import type {
  SandboxExecContext,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
  SandboxTerminal,
} from "./provider";

const logger = loggers.api("apps-v2-local-sandbox");

/** Matches the E2B provider's cap so behaviour does not diverge by surface. */
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * $HOME for commands, shared across sandboxes and outside every working tree.
 *
 * Mirrors the microVM, where HOME is the parent of the working copy rather
 * than the copy itself. Tool caches belong somewhere durable and shared; they
 * do not belong in git.
 */
const SANDBOX_HOME = path.join(os.tmpdir(), "mako-apps-v2-cache", "home");

/**
 * Refuse to exist in production.
 *
 * Mirrors `assertDevLoginSafeAtBoot`: a development-only escape hatch is only
 * safe if shipping it is impossible rather than merely discouraged.
 */
function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "The local Apps v2 sandbox runs tenant commands in the API process and " +
        "must never be used in production. Unset APPS_V2_SANDBOX_PROVIDER or " +
        "set it to 'e2b'.",
    );
  }
}

function rootFor(ctx: SandboxExecContext): string {
  return path.join(appsV2SessionsRoot(), "local", ctx.sessionKey);
}

function scratchFor(ctx: SandboxExecContext): string {
  return path.join(os.tmpdir(), "mako-local-sandbox", ctx.sessionKey);
}

/**
 * Translate an absolute sandbox path onto this machine.
 *
 * Callers address the sandbox in its own terms (`<root>/apps/x`,
 * `<scratch>/y.bundle`) and the provider is what knows where those actually
 * are. Anything outside both is refused rather than quietly resolved, so a
 * path built from user input cannot reach the rest of the host.
 */
function toLocal(ctx: SandboxExecContext, remotePath: string): string {
  const root = rootFor(ctx);
  const scratch = scratchFor(ctx);
  const resolved = path.resolve(remotePath);
  for (const base of [root, scratch]) {
    if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) {
      return resolved;
    }
  }
  throw new Error(
    `Path escapes the local sandbox: ${JSON.stringify(remotePath)}`,
  );
}

async function ensureDirs(ctx: SandboxExecContext): Promise<void> {
  await fs.mkdir(SANDBOX_HOME, { recursive: true });
  await fs.mkdir(rootFor(ctx), { recursive: true });
  await fs.mkdir(scratchFor(ctx), { recursive: true });
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  return {
    text: Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString(),
    truncated: true,
  };
}

async function execLocal(
  ctx: SandboxExecContext,
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  assertNotProduction();
  await ensureDirs(ctx);
  const startedAt = Date.now();
  const cwd = path.resolve(rootFor(ctx), options.cwd ?? ".");
  if (cwd !== rootFor(ctx) && !cwd.startsWith(`${rootFor(ctx)}${path.sep}`)) {
    throw new Error(`cwd escapes the local sandbox: ${options.cwd}`);
  }
  await fs.mkdir(cwd, { recursive: true });

  return new Promise(resolve => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        encoding: "utf8",
        env: {
          // Deliberately minimal, like the microVM's: a local sandbox must not
          // become the one place where an app can read the API's secrets.
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          // OUTSIDE the working tree, and not the developer's real home
          // either. npm and friends write caches into $HOME; pointed at the
          // tree, every one of them would land in the next commit.
          HOME: SANDBOX_HOME,
          LANG: "C.UTF-8",
          TERM: "xterm-256color",
          // There is no human at this end. Without it git blocks on a
          // credential prompt until the timeout and reports nothing.
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        const out = truncate(String(stdout ?? ""));
        const err = truncate(String(stderr ?? ""));
        const failure = error as (Error & { code?: number | string }) | null;
        const timedOut = Boolean(
          failure && (failure as { killed?: boolean }).killed,
        );
        resolve({
          exitCode: timedOut
            ? 124
            : typeof failure?.code === "number"
              ? failure.code
              : failure
                ? 1
                : 0,
          stdout: out.text,
          stderr: err.text,
          timedOut,
          durationMs: Date.now() - startedAt,
          truncated: out.truncated || err.truncated,
        });
      },
    );
  });
}

export const localSandboxProvider: SandboxProvider = {
  id: "local",
  root: rootFor,
  scratch: scratchFor,

  async hasSession(ctx) {
    // A directory does not need booting, so "is it there" is the whole
    // question. It also keeps the local provider honest about the one thing
    // this seam exists to hide: whether reads see a working copy or a commit.
    try {
      await fs.access(path.join(rootFor(ctx), ".git"));
      return true;
    } catch {
      return false;
    }
  },
  exec: execLocal,

  async execDetached(ctx, command, options = {}) {
    assertNotProduction();
    await ensureDirs(ctx);
    const cwd = path.resolve(rootFor(ctx), options.cwd ?? ".");
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  },

  async publicUrlForPort(_ctx, port) {
    // Honest rather than plausible: there is no per-sandbox origin here, and
    // returning a URL that resolves to the developer's own machine would make
    // a broken preview look like a working one.
    return `http://127.0.0.1:${port}`;
  },

  async peekPublicUrlForPort(ctx, port) {
    // A directory cannot be accidentally created by describing it, so peek
    // only differs from publicUrlForPort in answering null for no session.
    return (await localSandboxProvider.hasSession(ctx))
      ? `http://127.0.0.1:${port}`
      : null;
  },

  async writeFile(ctx, remotePath, bytes) {
    assertNotProduction();
    await ensureDirs(ctx);
    const target = toLocal(ctx, remotePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  },

  async readFile(ctx, remotePath) {
    assertNotProduction();
    return new Uint8Array(await fs.readFile(toLocal(ctx, remotePath)));
  },

  async keepAlive() {
    // Nothing to keep alive: a directory does not time out.
  },

  async openTerminal(): Promise<SandboxTerminal> {
    // A PTY needs a real pseudo-terminal, which this provider does not model.
    // Refusing beats returning a terminal that silently swallows input.
    throw new Error(
      "The local sandbox has no interactive terminal — use the E2B provider " +
        "(APPS_V2_SANDBOX_PROVIDER=e2b) to open one.",
    );
  },

  async destroySession(sessionKey) {
    const ctx = { sessionKey };
    await fs.rm(rootFor(ctx), { recursive: true, force: true });
    await fs.rm(scratchFor(ctx), { recursive: true, force: true });
    logger.info("Local Apps v2 sandbox destroyed", { sessionKey });
  },
};
