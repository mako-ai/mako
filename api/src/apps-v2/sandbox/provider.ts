/**
 * Apps v2 sandbox provider seam (apps-v2.md §4.5, §12).
 *
 * THE SANDBOX IS THE WORKING COPY. It holds a real git checkout; the bare repo
 * holds the history; there is nothing in between. The API host used to keep a
 * second working tree and tar it in and out around every command, and most of
 * this subsystem's bugs came from those two copies disagreeing — a file edited
 * in the terminal destroyed by the next sync, a `git checkout` silently
 * reverted because the sync replaced `.git` as well.
 *
 * Commits move between the two as git bundles (see box-repo.ts): git's own
 * offline transfer format, needing no network path and — the point — no
 * credential inside the sandbox, where tenant code runs.
 *
 * "e2b" (Firecracker microVMs) is what ships. "local" is a directory on this
 * machine, for tests and for developing without E2B credentials; it runs
 * tenant commands in the API process, which N1 forbids, so it refuses to load
 * in production. The seam also keeps §7's vendor fallback (Fly, Modal)
 * reachable without touching callers.
 */
import type { AppsV2SandboxProviderId } from "../config";
import { e2bSandboxProvider } from "./e2b-provider";
import { localSandboxProvider } from "./local-provider";

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
   * VESTIGIAL. Nothing reads it: there is no host-side working tree any more,
   * so there is nothing to sync and nowhere to sync it from. Callers pass the
   * repository path to satisfy the type. Kept for one release so every call
   * site does not have to change in the same commit that removed the syncs.
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
  /** End the session. */
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: AppsV2SandboxProviderId;
  /**
   * Absolute path of the working copy inside this sandbox.
   *
   * Asked rather than assumed, because the answer differs per provider: a
   * microVM has a fixed path, a local sandbox is a directory on this machine.
   * Hardcoding one provider's layout is what made the working copy and the
   * code that manipulates it disagree in the first place.
   */
  root(ctx: SandboxExecContext): string;
  /** Absolute path for scratch files that must NOT enter the working copy. */
  scratch(ctx: SandboxExecContext): string;
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
   * Read raw bytes back out of the sandbox.
   *
   * The counterpart to writeFile, and the reason commits can leave the box
   * without it holding a credential: the box writes a git bundle to a file and
   * the API reads it, rather than the box pushing anywhere. Tenant code runs
   * in that sandbox, so it must never hold a token for the workspace repo.
   */
  readFile(ctx: SandboxExecContext, remotePath: string): Promise<Uint8Array>;
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

/**
 * Which sandbox backs Apps v2.
 *
 * E2B by default. `APPS_V2_SANDBOX_PROVIDER=local` swaps in a plain directory
 * on this machine, which is how the test suite and a developer without E2B
 * credentials can work at all now that the sandbox IS the working copy — and
 * which refuses to load in production, because it runs tenant commands in the
 * API process (see local-provider.ts).
 */
export function getSandboxProvider(): SandboxProvider {
  if (process.env.APPS_V2_SANDBOX_PROVIDER === "local") {
    return localSandboxProvider;
  }
  return e2bSandboxProvider;
}
