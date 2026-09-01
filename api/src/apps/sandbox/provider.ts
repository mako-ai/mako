/**
 * Apps sandbox provider seam (apps.md §4.5, §12).
 *
 * THE SANDBOX IS THE WORKING COPY. It holds a real git checkout; the bare repo
 * holds the history; there is nothing in between. The API host used to keep a
 * second working tree and tar it in and out around every command, and most of
 * this subsystem's bugs came from those two copies disagreeing — a file edited
 * in the terminal destroyed by the next sync, a `git checkout` silently
 * reverted because the sync replaced `.git` as well.
 *
 * The sandbox is an ordinary clone with an ordinary remote (see box.ts): it
 * fetches and pushes to Mako's own git-over-HTTP endpoint, which serves the
 * same bare repo. So there is one repository and two ordinary git clients,
 * and nothing in between to keep in step.
 *
 * "e2b" (Firecracker microVMs) is what ships. "local" is a directory on this
 * machine, for tests and for developing without E2B credentials; it runs
 * tenant commands in the API process, which N1 forbids, so it refuses to load
 * in production. The seam also keeps §7's vendor fallback (Fly, Modal)
 * reachable without touching callers.
 */
import { appsSandboxProviderEnv, type AppsSandboxProviderId } from "../config";
import { e2bSandboxProvider } from "./e2b-provider";
import { localSandboxProvider } from "./local-provider";

/**
 * "The machine this call needed is gone" — the one provider failure callers
 * outside this folder have to tell apart from an ordinary error, because a
 * question about a sandbox ("what is running in it?") has an honest empty
 * answer when there is no sandbox, while a failed command does not.
 *
 * Re-exported here so nothing outside imports a specific provider. Only E2B
 * can produce it; a local sandbox is a directory, and a directory does not
 * expire — so `false` there is the right answer, not a missing case.
 */
export { isSandboxGone } from "./e2b-provider";

export interface SandboxExecOptions {
  /** Working directory relative to the session root ("" = root). */
  cwd?: string;
  timeoutMs?: number;
  /**
   * Extra env vars visible to the command. Never a Mako API secret — the
   * only credentials that may enter a box are the tenant's own (the git
   * token file, and per-app env vars from env.service).
   */
  env?: Record<string, string>;
}

/** Identity of the sandbox a command runs against. */
export interface SandboxExecContext {
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
  readonly id: AppsSandboxProviderId;
  /**
   * Absolute path of the working copy inside this sandbox.
   *
   * Asked rather than assumed, because the answer differs per provider: a
   * microVM has a fixed path, a local sandbox is a directory on this machine.
   * Hardcoding one provider's layout is what made the working copy and the
   * code that manipulates it disagree in the first place.
   */
  root(ctx: SandboxExecContext): string;
  /**
   * Is there a sandbox for this session already — WITHOUT creating one?
   *
   * Every other call here connects-or-creates, which is right for work and
   * wrong for a question. Browsing a repository must not boot a microVM, and
   * "read the working copy if the machine is on, otherwise read the last
   * commit" needs a way to ask that is not itself an act of turning it on.
   */
  hasSession(ctx: SandboxExecContext): Promise<boolean>;
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
   * Same as publicUrlForPort, but NEVER creates a sandbox: null when none
   * exists. publicUrlForPort's cold path is create — correct when launching
   * work, catastrophic when merely describing it (a straggler box event
   * after a recycle booted a fresh billed microVM just to compute a
   * hostname). Status, snapshot, and telemetry paths must use this.
   */
  peekPublicUrlForPort(
    ctx: SandboxExecContext,
    port: number,
  ): Promise<string | null>;
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
   * The counterpart to writeFile: raw bytes out of the sandbox, used for
   * reading a file the working copy holds.
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
  /**
   * Identify the live sandbox behind a session, without creating one.
   * Null when no sandbox exists (or the provider has no such notion).
   */
  describe?(ctx: SandboxExecContext): Promise<{
    sandboxId: string;
    startedAt: string | null;
  } | null>;
}

/**
 * Which sandbox backs Apps.
 *
 * E2B by default. `APPS_SANDBOX_PROVIDER=local` swaps in a plain directory
 * on this machine, which is how the test suite and a developer without E2B
 * credentials can work at all now that the sandbox IS the working copy — and
 * which refuses to load in production, because it runs tenant commands in the
 * API process (see local-provider.ts).
 */
export function getSandboxProvider(): SandboxProvider {
  if (appsSandboxProviderEnv() === "local") {
    return localSandboxProvider;
  }
  return e2bSandboxProvider;
}
