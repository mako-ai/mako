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

/** A live pseudo-terminal in a sandbox. */
export interface SandboxTerminal {
  /** Process id, so a dropped client can reattach to the same shell. */
  readonly pid: number;
  /** Forward a keystroke (or paste) to the shell. */
  write(data: Uint8Array): Promise<void>;
  /**
   * Interrupt: throw away input not yet handed to the shell, then send ctrl-C.
   *
   * This is what a real tty does — an interrupt flushes the input queue — and
   * without it ctrl-C is useless exactly when it is needed most. Input is
   * written in order, so a ctrl-C typed during a large paste would otherwise
   * queue behind the rest of it and take as long as the paste to arrive.
   */
  interrupt(): Promise<void>;
  /** Tell the shell the window changed, so it can redraw at the right size. */
  resize(cols: number, rows: number): Promise<void>;
  /**
   * Copy what the shell has done back to the host working tree.
   *
   * A PTY, unlike `exec`, has no natural end to sync at — so until this
   * existed, nothing typed into a terminal was ever persisted, and the next
   * `syncIn` (which replaces the tree, `.git` included) deleted all of it. A
   * shell that silently discards your work is worse than no shell.
   *
   * TEMPORARY. When the sandbox becomes the one working copy there is nothing
   * to copy anywhere, and this goes away with the rest of the sync layer.
   */
  sync(): Promise<void>;
  /** End the session. */
  close(): Promise<void>;
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
  /**
   * Open an interactive pseudo-terminal in the session.
   *
   * Distinct from {@link exec}: that is one command in, one result out, with
   * the working tree synced around it. A PTY is a live shell — a prompt, job
   * control, programs that redraw — so it streams bytes until it is closed and
   * does not sync anything. Anything committed from inside it reaches the host
   * through the ordinary per-command syncs.
   */
  openTerminal(
    ctx: SandboxExecContext,
    opts: {
      cwd: string;
      cols: number;
      rows: number;
      onData: (data: Uint8Array) => void;
      /**
       * The shell is gone and this terminal will never work again — the pty
       * exited, or the sandbox behind it expired.
       *
       * Without this the caller keeps a handle to a dead shell: writes fail
       * forever, and reconnecting attaches to the same corpse, so the terminal
       * stays broken until the process restarts. Told about it, the caller can
       * throw the session away and build a fresh one.
       */
      onExit?: (reason: string) => void;
    },
  ): Promise<SandboxTerminal>;
  /** Tear down any remote session for the given affinity key (best effort). */
  destroySession?(sessionKey: string): Promise<void>;
}

export function getSandboxProvider(): SandboxProvider {
  return e2bSandboxProvider;
}
