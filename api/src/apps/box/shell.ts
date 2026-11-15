/**
 * Running things in the box: POSIX quoting, the box's repo root, a git or
 * shell command with disk-full recovery, and the paths no commit may hold.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import { loggers } from "../../logging";

const logger = loggers.api("apps-box-clone");

/**
 * Paths that must never reach a commit regardless of what the app's own
 * .gitignore says — installed dependencies and build output, which belong to
 * the machine rather than to the project.
 */
export const NEVER_COMMIT = [
  "node_modules",
  ".npm",
  ".cache",
  ".vite",
  ".pnpm-store",
  "dist",
];

/**
 * The workspace repo's root .gitignore, derived from NEVER_COMMIT.
 *
 * This is the layer that travels. The scaffold writes a per-app .gitignore,
 * but not every app comes from the scaffold: an agent can hand-build one with
 * write_file and bash, and a person can push a folder from a laptop clone —
 * and the sandbox's .git/info/exclude backstop protects neither, because
 * info/exclude is per-clone and unversioned. A root .gitignore is committed
 * state: it applies recursively to every app folder that will ever exist, in
 * every clone, however the app was created. (`.env` rides along because a
 * secret in git is a leak with history.)
 */
export function workspaceRootGitignore(): string {
  return `${NEVER_COMMIT.map(n => `${n}/`).join("\n")}\n.env\n`;
}

/** Single-quote for a POSIX shell, closing and reopening around any quote. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function boxRoot(ctx: SandboxExecContext): string {
  return getSandboxProvider().root(ctx);
}

export function boxGit(ctx: SandboxExecContext, ...args: string[]): string {
  return ["git", "-C", sh(boxRoot(ctx)), ...args.map(sh)].join(" ");
}

const DISK_FULL = /No space left on device/i;

/**
 * Free what a sandbox can regenerate: package-manager caches, tool caches and
 * scratch. Never node_modules or the working tree — those are the user's
 * state, not cache. Best effort: each removal is independent, and the command
 * always exits 0 so a missing path is not an error.
 *
 * Why this exists: the box disk is small and fills with the npm/pnpm caches,
 * so the first git config write (`config.lock`) fails with ENOSPC, which
 * left the box unconfigured with no way for the user to recover it.
 */
const RECLAIM_DISK = [
  'rm -rf "$HOME/.npm/_cacache" "$HOME/.npm/_logs" "$HOME/.cache" "$HOME/.local/share/pnpm/store" "$HOME/.pnpm-store" 2>/dev/null',
  "rm -rf /tmp/* /var/tmp/* 2>/dev/null",
  "true",
].join("; ");

export async function run(
  ctx: SandboxExecContext,
  command: string,
  what: string,
  timeoutMs = 180_000,
): Promise<string> {
  const provider = getSandboxProvider();
  let result = await provider.exec(ctx, command, { timeoutMs });
  if (
    result.exitCode !== 0 &&
    DISK_FULL.test(`${result.stderr}${result.stdout}`)
  ) {
    // Reclaim and retry once. Every command here is safe to repeat (see
    // configureBoxRemote), and a second failure is a real full disk that the
    // error below should report.
    logger.warn("Apps sandbox disk full; reclaiming caches and retrying", {
      sessionKey: ctx.sessionKey,
      what,
    });
    await provider.exec(ctx, RECLAIM_DISK, { timeoutMs: 60_000 });
    result = await provider.exec(ctx, command, { timeoutMs });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).slice(-500);
    throw new Error(
      DISK_FULL.test(detail)
        ? `${what} failed in the sandbox: the disk is full even after clearing caches. Delete large files (check \`du -sh ~/app/* | sort -h\`) or recycle the sandbox. ${detail}`
        : `${what} failed in the sandbox: ${detail}`,
    );
  }
  return result.stdout;
}
