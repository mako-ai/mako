/**
 * Apps v2 sandbox provider seam (apps-v2.md §4.5, §12).
 *
 * One implementation today: "e2b" — Firecracker microVMs. The host session
 * directory remains the git staging area; the provider syncs it into the
 * sandbox before a command and back out after (rsync-style, tar over the E2B
 * filesystem API), so everything above the seam — worktree durability, WIP
 * flushes, tools, routes — never learns where the shell actually ran.
 *
 * The seam is kept with a single implementation on purpose: §7 wants Fly
 * Machines / Modal reachable as a vendor fallback without touching callers.
 * It is NOT kept for a local-execution mode — §12 deleted that. Mako developers
 * run on E2B too, so we exercise the substrate we ship, and tenant code never
 * runs on the API host (N1).
 */
import type { AppsV2SandboxProviderId } from "../config";
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
  /**
   * Start a long-running process in the session and return once it is
   * detached. Unlike {@link exec} this does NOT sync the working tree back
   * out — the process is still running and the tree is still moving.
   */
  execDetached(
    ctx: SandboxExecContext,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<void>;
  /**
   * Publicly reachable origin for a port inside the sandbox, e.g.
   * `https://5173-<sandboxId>.e2b.app`. This is how a dev server reaches a
   * browser without any Mako-side proxy (§12.4).
   */
  publicUrlForPort(ctx: SandboxExecContext, port: number): Promise<string>;
  /**
   * Write raw bytes to an absolute path inside the sandbox, outside the synced
   * working tree. Used to stage data the app must be able to fetch but that
   * must never enter its git tree (§13: materialized binding parquet).
   */
  writeFile(
    ctx: SandboxExecContext,
    remotePath: string,
    bytes: Uint8Array,
  ): Promise<void>;
  /**
   * Keep the session alive for at least this long. Dev servers outlive the
   * command that started them, so the idle timeout has to be pushed out
   * explicitly or E2B pauses the sandbox out from under the preview.
   */
  keepAlive(ctx: SandboxExecContext, ms: number): Promise<void>;
  /** Tear down any remote session for the given affinity key (best effort). */
  destroySession?(sessionKey: string): Promise<void>;
}

export function getSandboxProvider(): SandboxProvider {
  return e2bSandboxProvider;
}
