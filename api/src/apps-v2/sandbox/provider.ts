/**
 * Apps v2 sandbox provider seam (apps-v2.md §4.5).
 *
 * The agent's shell/file tools dispatch to a SandboxProvider. Two
 * implementations are planned:
 *
 * - "local" (this PR): commands run as subprocesses of the API host inside a
 *   session directory with an allowlisted environment. Development-only —
 *   it refuses to activate in production (tenant code must never run on the
 *   API host; RFC N1).
 * - "e2b" (next phase): Firecracker microVMs, same interface. Nothing above
 *   this seam — worktree durability, tools, routes — may depend on where the
 *   shell actually runs.
 */
import {
  appsV2SandboxProviderId,
  type AppsV2SandboxProviderId,
} from "../config";
import { localSandboxProvider } from "./local-provider";

export interface SandboxExecOptions {
  /** Working directory relative to the session root ("" = root). */
  cwd?: string;
  timeoutMs?: number;
  /** Extra env vars visible to the command (non-secret only). */
  env?: Record<string, string>;
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
   * Run a shell command inside the session working tree rooted at `rootDir`.
   * The provider guarantees: cwd containment under rootDir, an allowlisted
   * environment (no API-process secrets), a hard timeout, and output caps.
   */
  exec(
    rootDir: string,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
}

export function getSandboxProvider(): SandboxProvider {
  const id = appsV2SandboxProviderId();
  if (id === "local") return localSandboxProvider;
  throw new Error(
    `Apps v2 sandbox provider "${id}" is not implemented yet — use "local" for development`,
  );
}
