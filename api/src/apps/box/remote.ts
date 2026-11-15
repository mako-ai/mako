/**
 * The box's clone and its remote (Mako's git endpoint): cloning, the
 * credential and remote config, healing an unreachable origin, pulling, and
 * copying a directory out of the box.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { appsGitOriginBase, appsGitOriginUrl } from "../config";
import { mintGitToken } from "../git-token.service";
import { loggers } from "../../logging";
import { NEVER_COMMIT, sh, boxRoot, boxGit, run } from "./shell";
import { boxExec } from "./files";

const logger = loggers.api("apps-box-clone");

/** Is there already a git repository in the sandbox? */
export async function boxHasRepo(ctx: SandboxExecContext): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    `test -d ${sh(`${boxRoot(ctx)}/.git`)}`,
    { timeoutMs: 15_000 },
  );
  return result.exitCode === 0;
}

/**
 * Does the box hold a REAL checkout — not merely a `.git`?
 *
 * `boxHasRepo` (a `.git` exists) is not enough as a readiness gate. A clone
 * that ran `git init` but never completed `fetch`+`checkout` — a hydrate that
 * threw partway, e.g. the git origin (the dev tunnel) was not up when the box
 * booted — leaves a `.git` with an UNBORN HEAD and an empty working tree. The
 * old gate saw the `.git`, declared the box ready, and never re-cloned, so the
 * box stayed permanently empty ("app is not in this checkout"). This verifies
 * HEAD actually resolves to a commit, which an unhydrated clone fails.
 */
export async function boxHasValidCheckout(
  ctx: SandboxExecContext,
): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    // `test -d .git` FIRST: `git rev-parse` alone walks up to a parent repo, so
    // an empty box nested under one (the local provider in tests) would falsely
    // report ready. Anchor to a `.git` AT the box root, then require HEAD to
    // resolve — an unhydrated clone (git init, no commit) fails the second test.
    `test -d ${sh(`${boxRoot(ctx)}/.git`)} && git -C ${sh(boxRoot(ctx))} rev-parse --verify HEAD >/dev/null 2>&1 && echo ok || echo no`,
    { timeoutMs: 15_000 },
  );
  return result.stdout.includes("ok");
}

/**
 * Where a sandbox keeps its credential: inside the clone's own `.git`.
 *
 * The two wrong answers have both been shipped and both bit. $HOME: the local
 * provider shares one HOME across sandboxes (deliberately, for tool caches),
 * so two workspaces overwrote each other's token and one got 401s from a
 * valid credential for the wrong repository. Scratch (/tmp): tmpfs on the
 * microVM, which E2B's pause snapshot does not preserve — a resumed sandbox
 * woke with a configured helper pointing at a file that no longer existed and
 * failed auth with "No such file" while nothing had been rotated.
 *
 * `.git` is per-clone by construction, inside the snapshot because the clone
 * is, and nothing under it can ever be committed.
 */
function tokenPath(ctx: SandboxExecContext): string {
  return `${boxRoot(ctx)}/.git/mako-git-token`;
}

/**
 * Where box processes (launcher, hooks, agent) find how to reach the API:
 * `MAKO_API`, `MAKO_WS`, `MAKO_TOKEN_FILE`, one per line. Rewritten with the
 * token on every configure/heal, so a tunnel restart updates it too.
 */
export function boxEnvPath(ctx: SandboxExecContext): string {
  return `${boxRoot(ctx)}/.git/mako-box.env`;
}

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
  const url = appsGitOriginUrl(workspaceId);
  if (
    getSandboxProvider().id !== "local" &&
    /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)
  ) {
    // A microVM cannot reach this machine's localhost. Configuring it
    // anyway is how agent commits ended up "committed but not durable"
    // with the failure buried in a log. Fail loudly instead: the tunnel
    // (.env.tunnel) is not up yet — retry after `pnpm dev` finishes booting.
    throw new Error(
      `Refusing to configure a remote sandbox with a localhost git origin (${url}) — the tunnel is not up yet.`,
    );
  }
  const token = mintGitToken({ workspaceId, userId, email: author?.email });
  const credential = tokenPath(ctx);
  const helper = `!f() { printf 'username=mako\\npassword=%s\\n' "$(cat ${credential})"; }; f`;

  await run(
    ctx,
    [
      // umask first: the file must never exist world-readable, not even for
      // the instant between creation and a chmod.
      `(umask 077 && printf '%s' ${sh(token)} > ${sh(credential)})`,
      `(umask 077 && printf 'MAKO_API=%s\\nMAKO_WS=%s\\nMAKO_TOKEN_FILE=%s\\n' ${sh(appsGitOriginBase())} ${sh(workspaceId)} ${sh(credential)} > ${sh(boxEnvPath(ctx))})`,
      // An EMPTY helper resets the inherited list, then ours is the only one.
      //
      // Git runs every configured helper in order, including any from system
      // config, and a helper that wants to talk to a human blocks forever
      // where there is no human. macOS ships `credential.helper=osxkeychain`
      // in Xcode's gitconfig, which hung every fetch and push against the
      // local sandbox until the timeout — with empty stderr, because nothing
      // had failed; git was waiting. A sandbox image that picks up a helper
      // would do the same, so this is not a macOS workaround.
      boxGit(ctx, "config", "--replace-all", "credential.helper", ""),
      boxGit(ctx, "config", "--add", "credential.helper", helper),
      // Commit identity. Set it to the real actor when we know who they are;
      // the git endpoint enforces that pushed commits carry exactly this email
      // (its pre-receive hook), so a stale or generic identity here would get
      // the actor's own commit rejected. When the actor is unknown — a
      // low-level origin heal that has only a sessionKey — leave whatever is
      // already configured rather than stamping a generic identity over the
      // real one, and only fall back to a placeholder if nothing is set yet,
      // so `git commit` never fails with "who are you" on a fresh box.
      ...(author?.name
        ? [boxGit(ctx, "config", "user.name", author.name)]
        : []),
      ...(author?.email
        ? [boxGit(ctx, "config", "user.email", author.email)]
        : []),
      `${boxGit(ctx, "config", "user.email")} >/dev/null 2>&1 || ${boxGit(ctx, "config", "user.email", "session@mako.ai")}`,
      `${boxGit(ctx, "config", "user.name")} >/dev/null 2>&1 || ${boxGit(ctx, "config", "user.name", "Mako Session")}`,
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
  // `.git/info/exclude` is git's own home for repo-local ignores — no config
  // key needed, and (unlike the scratch file this used to be) inside the
  // pause snapshot, so a resumed sandbox cannot wake with its excludes gone
  // and quietly start committing node_modules.
  const excludes = `${boxRoot(ctx)}/.git/info/exclude`;

  await run(
    ctx,
    [
      `mkdir -p ${sh(boxRoot(ctx))}`,
      boxGit(ctx, "init", "-q"),
      `mkdir -p ${sh(`${boxRoot(ctx)}/.git/info`)}`,
      // A repo-level backstop, independent of whatever .gitignore the app
      // happens to ship.
      `printf '%s\\n' ${NEVER_COMMIT.map(n => sh(`${n}/`)).join(" ")} > ${sh(excludes)}`,
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

  logger.info("Apps sandbox cloned the workspace repo", {
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

/** Push/fetch stderr that means "could not REACH origin" (vs a git refusal). */
export function isUnreachableOrigin(stderr: string): boolean {
  return /unable to access|Failed to connect|Could not resolve host/i.test(
    stderr,
  );
}

/**
 * Re-point the box's origin at the CURRENT git endpoint and token.
 *
 * Every `pnpm dev` restarts the tunnel with a fresh URL, so a box configured
 * against the previous one keeps failing every push and pull until something
 * rewrites its remote. Callers invoke this when a git network operation could
 * not reach origin, then retry once.
 */
export async function healBoxOrigin(ctx: SandboxExecContext): Promise<void> {
  logger.warn("Apps origin unreachable; reconfiguring the box remote", {
    sessionKey: ctx.sessionKey,
  });
  const [workspaceId, ...rest] = ctx.sessionKey.split(":");
  const userId = rest.join(":");
  // Recover the author identity too. Healing without it re-minted the git
  // token with no email, which fail-opens authorship enforcement until the
  // next full ensureBox. Dynamic import: worktree.service imports this
  // module, so a static import would be a cycle.
  const author = await import("../worktree.service")
    .then(m => m.resolveActorIdentity(userId))
    .catch(() => undefined);
  await configureBoxRemote({ ctx, workspaceId, userId, author });
}

/**
 * Bring the box up to date with the server — `git pull`, essentially.
 *
 * Fast-forwards a clean tree and merges a dirty one, which is git's own rule.
 * A conflict is left in the working copy rather than resolved on the user's
 * behalf: it is a real conflict in a real checkout, and it is fixable there.
 */
/**
 * Drop uncommitted changes under `workflows/` that upstream now holds
 * byte for byte. A workflow is committed to its preview branch without
 * moving the checkout (boxCommitPathToBranch), so once that branch is merged
 * the working copy still has the same edits uncommitted, and git refuses a
 * merge over them even though they are identical. Nothing is lost: each
 * dropped file is exactly what the merge brings.
 */
const SETTLE_MERGED_WORKFLOWS = [
  `git status --porcelain --untracked-files=all -- workflows/ | while IFS= read -r line; do`,
  `p="\${line#???}"`,
  `[ -f "$p" ] || continue`,
  `up=$(git rev-parse -q --verify "@{u}:$p") || continue`,
  `[ "$(git hash-object -- "$p")" = "$up" ] || continue`,
  `if git cat-file -e "HEAD:$p" 2>/dev/null; then git checkout -q HEAD -- "$p"; else git rm -q --cached --ignore-unmatch -- "$p"; rm -f -- "$p"; fi`,
  `done`,
].join("\n");

export async function boxPull(ctx: SandboxExecContext): Promise<void> {
  // The merge may legitimately refuse (uncommitted work in the way, or a
  // real conflict) — that is the user's to resolve in their checkout, not
  // ours to force. But refusing SILENTLY cost a debugging session when a
  // stale box kept lacking an app that main had for days: log what git said
  // so "the box is behind and won't catch up" has a trail.
  const pull = [
    boxGit(ctx, "fetch", "-q", "origin"),
    // Best effort: whatever it could not settle, the merge reports.
    `{ (cd ${sh(boxRoot(ctx))} && ${SETTLE_MERGED_WORKFLOWS}); true; }`,
    `${boxGit(ctx, "merge", "--no-edit", "@{u}")}`,
  ].join(" && ");
  let result = await boxExec(ctx, pull, { timeoutMs: 180_000 });
  if (result.exitCode !== 0 && isUnreachableOrigin(result.stderr)) {
    await healBoxOrigin(ctx);
    result = await boxExec(ctx, pull, { timeoutMs: 180_000 });
  }
  if (result.exitCode !== 0) {
    logger.warn("Apps box pull did not merge", {
      sessionKey: ctx.sessionKey,
      said: (result.stderr || result.stdout).slice(-400),
    });
  }
}

/**
 * Copy a directory out of the sandbox — a build's `dist/`, typically.
 *
 * Not a git operation: build output is deliberately not committed, so it
 * cannot travel as a commit, and publishing still needs the bytes. A tar
 * through the provider's file channel is the plain way to move a directory
 * off a machine.
 */
export async function readBoxDir(
  ctx: SandboxExecContext,
  boxRelDir: string,
  destDir: string,
): Promise<void> {
  const execFileAsync = promisify(execFile);
  const archive = `${getSandboxProvider().scratch(ctx)}/mako-dir-${process.hrtime.bigint()}.tar.gz`;
  // Packed from INSIDE the directory, so entries are "./x" and extraction
  // needs no guessing about how many leading components to strip.
  const packed = await boxExec(
    ctx,
    `tar -czf ${sh(archive)} -C ${sh(`${boxRoot(ctx)}/${boxRelDir}`)} .`,
    { timeoutMs: 180_000 },
  );
  if (packed.exitCode !== 0) {
    throw new Error(
      `Could not read ${boxRelDir} from the sandbox: ${packed.stderr.slice(-300)}`,
    );
  }
  const bytes = await getSandboxProvider().readFile(ctx, archive);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-dir-"));
  try {
    const localArchive = path.join(tmp, "dir.tar.gz");
    await fs.writeFile(localArchive, Buffer.from(bytes));
    await fs.mkdir(destDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", localArchive, "-C", destDir]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await boxExec(ctx, `rm -f ${sh(archive)}`, { timeoutMs: 15_000 }).catch(
      () => undefined,
    );
  }
}
