/**
 * Minimal, safe git plumbing for Apps v2.
 *
 * Every invocation uses execFile (argv, no shell) with an explicit,
 * allowlisted environment, so neither user-controlled strings nor the API
 * process env can leak into git. All higher-level semantics (WIP refs, CAS,
 * snapshots) live in repository.service.ts on top of these primitives.
 */
import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  cwd?: string;
  /** Extra env vars (merged over the minimal base env). */
  env?: Record<string, string>;
  /** Fail after this many ms (default 30s — plumbing should be fast). */
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  LANG: "C.UTF-8",
  // Never let git prompt or consult user/system config.
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

export const ZERO_OID = "0".repeat(40);

export function runGit(
  args: string[],
  options: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...BASE_ENV, ...(options.env ?? {}) },
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as NodeJS.ErrnoException & { code?: unknown })
              .code === "number"
              ? ((error as unknown as { code: number }).code as number)
              : null;
          reject(
            new GitError(
              `git ${args[0]} failed: ${String(stderr || error.message).slice(0, 2000)}`,
              args,
              code,
              String(stderr ?? ""),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Like runGit but returns raw bytes (for blob contents). */
export function runGitBuffer(
  args: string[],
  options: RunGitOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...BASE_ENV, ...(options.env ?? {}) },
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitError(
              `git ${args[0]} failed: ${String(stderr || error.message).slice(0, 2000)}`,
              args,
              null,
              String(stderr ?? ""),
            ),
          );
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/**
 * Validate a repo-relative POSIX path from an untrusted caller.
 * Rejects absolute paths, traversal, NULs, and anything under `.git`.
 */
export function assertSafeRelPath(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.endsWith("/")
  ) {
    throw new Error(`Invalid path: ${JSON.stringify(p)}`);
  }
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error(`Invalid path segment in: ${JSON.stringify(p)}`);
    }
    if (seg === ".git") {
      throw new Error("Paths under .git are not allowed");
    }
  }
  return normalized;
}
