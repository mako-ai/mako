/**
 * Apps v2 sandbox provider seam (apps-v2.md §4.5).
 *
 * Two implementations:
 *
 * - "local": commands run as subprocesses of the API host inside the session
 *   directory with an allowlisted environment. Development-only — refuses to
 *   activate in production (tenant code must never run on the API host).
 * - "e2b": Firecracker microVMs (the production target). The host session
 *   directory remains the git staging area; the provider syncs it into the
 *   sandbox before the command and back out after (rsync-style, tar over the
 *   E2B filesystem API), so everything above the seam — worktree durability,
 *   WIP-ref flushes, tools, routes — is identical for both substrates.
 *
 * Nothing above this seam may depend on where the shell actually runs.
 */
import {
  appsV2SandboxProviderId,
  type AppsV2SandboxProviderId,
} from "../config";
import { localSandboxProvider } from "./local-provider";
import { e2bSandboxProvider } from "./e2b-provider";

export interface SandboxExecOptions {
  /** Working directory relative to the session root ("" = root). */
  cwd?: string;
  timeoutMs?: number;
  /** Extra env vars visible to the command (non-secret only). */
  env?: Record<string, string>;
}

/** Identity of the working tree a command runs against. */
export interface SandboxExecContext {
  /**
   * Host-side session directory (always present — it is the git staging
   * area). The local provider executes directly in it; remote providers
   * sync it in/out around the command.
   */
  hostDir: string;
  /** Stable affinity key for remote session reuse (the worktree id). */
  sessionKey: string;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** True when stdout/stderr were truncated to the output cap. */
  truncated: boolean;
}

export interface SandboxProvider {
  readonly id: AppsV2SandboxProviderId;
  /**
   * Run a shell command against the context's working tree. The provider
   * guarantees: cwd containment, an allowlisted environment (no API-process
   * secrets), a hard timeout, and output caps. After resolution the host
   * directory reflects all file changes the command made.
   */
  exec(
    ctx: SandboxExecContext,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  /** Tear down any remote session for the given affinity key (best effort). */
  destroySession?(sessionKey: string): Promise<void>;
}

export function getSandboxProvider(): SandboxProvider {
  const id = appsV2SandboxProviderId();
  if (id === "local") return localSandboxProvider;
  return e2bSandboxProvider;
}
