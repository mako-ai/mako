/**
 * The sandbox as an ordinary clone.
 *
 * This replaces a private transfer layer — bundles in both directions, shadow
 * "WIP" commits to decide what to transfer, and a Mongo mirror of the result —
 * with the thing every developer already has: a working copy with a remote it
 * can fetch from and push to.
 *
 * The remote is Mako's own git-over-HTTP endpoint (routes/apps-v2-git.ts),
 * serving the same bare repo the API reads. So there is one repository and two
 * ordinary git clients: the API on the server side of it, the sandbox on the
 * client side. Nothing has to be kept in step, because nothing is duplicated.
 *
 * The practical test of the design is that nothing in the box knows about
 * Mako. `git push`, `git pull`, `git log`, a coding agent running inside the
 * sandbox — all of it is just git talking to a git server.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import { appsV2GitOriginUrl } from "./config";
import { mintGitToken } from "./git-token.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-box-clone");

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

/** Single-quote for a POSIX shell, closing and reopening around any quote. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function boxRoot(ctx: SandboxExecContext): string {
  return getSandboxProvider().root(ctx);
}

function boxGit(ctx: SandboxExecContext, ...args: string[]): string {
  return ["git", "-C", sh(boxRoot(ctx)), ...args.map(sh)].join(" ");
}

async function run(
  ctx: SandboxExecContext,
  command: string,
  what: string,
  timeoutMs = 180_000,
): Promise<string> {
  const result = await getSandboxProvider().exec(ctx, command, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed in the sandbox: ${(result.stderr || result.stdout).slice(-500)}`,
    );
  }
  return result.stdout;
}

/** Is there already a git repository in the sandbox? */
export async function boxHasRepo(ctx: SandboxExecContext): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    `test -d ${sh(`${boxRoot(ctx)}/.git`)}`,
    { timeoutMs: 15_000 },
  );
  return result.exitCode === 0;
}

/** Where the sandbox keeps its credential, outside every working tree. */
const TOKEN_PATH = '"$HOME"/.mako/git-token';

/**
 * Give the sandbox a remote and the credential to use it.
 *
 * The token goes in a file rather than in the remote URL so that rotating it
 * is a write, `git remote -v` does not print a secret, and no command line
 * carrying it is retained anywhere. A one-line credential helper reads it —
 * which is git's own extension point for exactly this, so nothing here has to
 * understand how git authenticates.
 *
 * Safe and cheap to repeat: every call refreshes the token, which is what
 * keeps a long-lived sandbox from reaching its expiry mid-session.
 */
export async function configureBoxRemote(input: {
  ctx: SandboxExecContext;
  workspaceId: string;
  userId: string;
  /** Who commits made in the box are attributed to. */
  author?: { name?: string; email?: string };
}): Promise<void> {
  const { ctx, workspaceId, userId, author } = input;
  const url = appsV2GitOriginUrl(workspaceId);
  const token = mintGitToken({ workspaceId, userId });
  const helper = `!f() { printf 'username=mako\\npassword=%s\\n' "$(cat ${TOKEN_PATH})"; }; f`;

  await run(
    ctx,
    [
      `mkdir -p "$HOME"/.mako`,
      // umask first: the file must never exist world-readable, not even for
      // the instant between creation and a chmod.
      `(umask 077 && printf '%s' ${sh(token)} > ${TOKEN_PATH})`,
      boxGit(ctx, "config", "credential.helper", helper),
      boxGit(ctx, "config", "user.name", author?.name || "Mako Session"),
      boxGit(ctx, "config", "user.email", author?.email || "session@mako.ai"),
      // Push the current branch to the same name, the modern default. Without
      // it, a `git push` with no arguments on a fresh branch fails with advice
      // instead of pushing.
      boxGit(ctx, "config", "push.default", "current"),
      boxGit(ctx, "config", "push.autoSetupRemote", "true"),
      `${boxGit(ctx, "remote", "set-url", "origin", url)} || ${boxGit(ctx, "remote", "add", "origin", url)}`,
    ].join(" && "),
    "configuring the git remote",
    60_000,
  );
}

/**
 * Put a working copy of `branch` in the sandbox.
 *
 * `init` + `fetch` rather than `clone` for one practical reason: a warm
 * sandbox already has node_modules in the directory, and clone refuses a
 * non-empty target. It is the same sequence clone runs.
 */
export async function cloneIntoBox(input: {
  ctx: SandboxExecContext;
  workspaceId: string;
  userId: string;
  branch: string;
  author?: { name?: string; email?: string };
}): Promise<void> {
  const { ctx, workspaceId, userId, branch, author } = input;
  const excludes = '"$HOME"/.mako/never-commit';

  await run(
    ctx,
    [
      `mkdir -p ${sh(boxRoot(ctx))} "$HOME"/.mako`,
      boxGit(ctx, "init", "-q"),
      // A repo-level backstop for the ignores below, independent of whatever
      // .gitignore the app happens to ship.
      `printf '%s\\n' ${NEVER_COMMIT.map(n => sh(`${n}/`)).join(" ")} > ${excludes}`,
      boxGit(ctx, "config", "core.excludesFile", excludes),
    ].join(" && "),
    "preparing the working copy",
    60_000,
  );

  await configureBoxRemote({ ctx, workspaceId, userId, author });

  await run(
    ctx,
    [
      boxGit(ctx, "fetch", "-q", "--tags", "origin"),
      // Track origin's branch, creating the local one if this is the first
      // time. `checkout -B ... origin/<branch>` is the same thing clone does
      // for the default branch.
      boxGit(ctx, "checkout", "-q", "-B", branch, `origin/${branch}`),
    ].join(" && "),
    `fetching ${branch}`,
  );

  logger.info("Apps v2 sandbox cloned the workspace repo", {
    workspaceId,
    branch,
  });
}

/** The branch the sandbox is on, and the commit it is at. */
export async function boxHead(
  ctx: SandboxExecContext,
): Promise<{ branch: string; head: string }> {
  const out = await run(
    ctx,
    [
      boxGit(ctx, "rev-parse", "--abbrev-ref", "HEAD"),
      boxGit(ctx, "rev-parse", "HEAD"),
    ].join(" && "),
    "reading HEAD",
    30_000,
  );
  const [branch, head] = out.split("\n").map(l => l.trim());
  if (!branch || !head) {
    throw new Error(
      `Unexpected git output from the sandbox: ${out.slice(-200)}`,
    );
  }
  return { branch, head };
}
