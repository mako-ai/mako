/**
 * Local subprocess sandbox provider — DEVELOPMENT ONLY.
 *
 * Runs commands with bash inside the session directory. Containment relies on
 * an allowlisted environment (no API secrets are inherited), cwd validation,
 * hard timeouts, and output caps — NOT on kernel isolation. That is
 * acceptable for single-tenant dev VMs and local development, and is exactly
 * why this provider refuses to run when NODE_ENV=production (enforced here,
 * in addition to the config-level provider selection).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  APPS_V2_EXEC_DEFAULT_TIMEOUT_MS,
  APPS_V2_EXEC_MAX_OUTPUT_BYTES,
  APPS_V2_EXEC_MAX_TIMEOUT_MS,
} from "../config";
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";

/** Environment visible to sandboxed commands. Built from scratch — the API
 * process env (DATABASE_URL, ENCRYPTION_KEY, AI keys, ...) is never
 * inherited. */
function sandboxEnv(
  rootDir: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: rootDir,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    // Keep package managers from prompting or phoning home interactively.
    npm_config_yes: "true",
    NO_UPDATE_NOTIFIER: "1",
    ...(extra ?? {}),
  };
}

function resolveCwd(rootDir: string, cwd?: string): string {
  if (!cwd) return rootDir;
  const abs = path.resolve(rootDir, cwd);
  const rel = path.relative(rootDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`cwd escapes the session root: ${JSON.stringify(cwd)}`);
  }
  return abs;
}

class CappedCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.bytes >= APPS_V2_EXEC_MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const remaining = APPS_V2_EXEC_MAX_OUTPUT_BYTES - this.bytes;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.bytes += remaining;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function execLocal(
  rootDir: string,
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "The local sandbox provider is development-only and cannot run in production",
    );
  }
  const cwd = resolveCwd(rootDir, options.cwd);
  const timeoutMs = Math.min(
    Math.max(1_000, options.timeoutMs ?? APPS_V2_EXEC_DEFAULT_TIMEOUT_MS),
    APPS_V2_EXEC_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  return new Promise<SandboxExecResult>((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: sandboxEnv(rootDir, options.env),
      stdio: ["ignore", "pipe", "pipe"],
      // New process group so a timeout can kill the whole tree.
      detached: true,
    });

    const stdout = new CappedCollector();
    const stderr = new CappedCollector();
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

export const localSandboxProvider: SandboxProvider = {
  id: "local",
  exec: execLocal,
};
