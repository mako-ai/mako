/**
 * Commits in the box: commit all or one path to a branch, per-path git
 * actions, file versions for diffs, push, checkout and discard.
 */
import { type SandboxExecContext } from "../sandbox/provider";
import type { ChangedFile } from "../repository.service";
import { loggers } from "../../logging";
import { sh, boxRoot, boxGit } from "./shell";
import { isUnreachableOrigin, healBoxOrigin, boxPull } from "./remote";
import { boxExec, boxStatus } from "./files";

const logger = loggers.api("apps-box-clone");

export interface BoxCommitResult {
  committed: boolean;
  commitOid?: string;
  message?: string;
  reason?: string;
}

/**
 * Commit everything in the working copy and push it.
 *
 * The push is not an optimisation, it is the durability guarantee: a sandbox
 * is disposable, so work that has not reached the server is work that only
 * exists on a machine nobody promised to keep. It is what the WIP ref used to
 * be, except that it is a commit on a branch, visible to git, and reachable
 * from any other clone.
 */
/**
 * Set one folder of the working copy back to its content at `sha` — the
 * working-copy half of "restore this version". Tracked files under `root`
 * are removed first so files that did not exist at `sha` disappear too
 * (`git checkout <sha> -- <dir>` alone only adds and overwrites); ignored
 * files (node_modules, dist) are untouched. Nothing is committed here.
 */
export async function boxRestoreTreeFrom(
  ctx: SandboxExecContext,
  sha: string,
  root: string,
): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Invalid commit sha");
  const exists = await boxExec(
    ctx,
    boxGit(ctx, "cat-file", "-e", `${sha}^{commit}`),
    { timeoutMs: 30_000 },
  );
  if (exists.exitCode !== 0) {
    // The box clones from Mako's endpoint; a commit that landed there since
    // the last pull is one fetch away.
    await boxExec(ctx, boxGit(ctx, "fetch", "-q", "origin"), {
      timeoutMs: 120_000,
    });
  }
  const removed = await boxExec(
    ctx,
    boxGit(ctx, "rm", "-r", "-q", "--ignore-unmatch", "--", root),
    { timeoutMs: 120_000 },
  );
  if (removed.exitCode !== 0) {
    throw new Error(`Could not clear ${root}: ${removed.stderr.slice(-300)}`);
  }
  const restored = await boxExec(
    ctx,
    boxGit(ctx, "checkout", sha, "--", root),
    { timeoutMs: 120_000 },
  );
  if (restored.exitCode !== 0) {
    // Put the working copy back the way it was before failing.
    await boxExec(ctx, boxGit(ctx, "checkout", "HEAD", "--", root), {
      timeoutMs: 120_000,
    }).catch(() => undefined);
    throw new Error(
      `This version has no "${root}" to restore: ${restored.stderr.slice(-300)}`,
    );
  }
}

export async function boxCommitAll(input: {
  ctx: SandboxExecContext;
  message: string;
  author?: { name?: string; email?: string };
  /**
   * Who is recorded as the COMMITTER, when it differs from the author. An agent
   * turn is authored by the human it acted for (so blame and the endpoint's
   * authorship check both see the accountable person) but committed by "Mako
   * Agent", so `git log --format='%an / %cn'` still shows an AI wrote it.
   */
  committer?: { name?: string; email?: string };
  /** Commit only what is staged (VS Code with a non-empty Staged group). */
  stagedOnly?: boolean;
  /**
   * Repo-relative pathspecs to limit the commit to. The working copy is ONE
   * clone per (workspace, user), shared by every chat that user runs — so an
   * unscoped commit sweeps whatever a concurrent chat left in its app's
   * folder. With paths, both the `add` and the `commit` are pathspec-scoped:
   * `git commit -- <paths>` takes the listed paths' contents and disregards
   * anything staged for other paths, which stays staged for whoever staged it.
   */
  paths?: string[];
}): Promise<BoxCommitResult> {
  const { ctx, message, author, committer, stagedOnly } = input;
  let paths = input.paths?.map(safeRepoPath);
  if (paths && paths.length > 0) {
    // One pathspec that matches nothing — neither in the working tree nor in
    // HEAD (an app whose folder never actually got created, say) — makes BOTH
    // `git add` and `git commit` abort outright, taking the valid paths down
    // with it. Keep only the paths git can resolve.
    const probe = paths
      .map(
        p =>
          `{ [ -e ${sh(p)} ] || git cat-file -e ${sh(`HEAD:${p}`)} 2>/dev/null; } && printf '%s\\n' ${sh(p)}`,
      )
      .join("; ");
    const existing = await boxExec(
      ctx,
      `cd ${sh(boxRoot(ctx))} && { ${probe}; true; }`,
      { timeoutMs: 60_000 },
    );
    paths = existing.stdout.split("\n").filter(Boolean);
  }
  // A pathspec scope with nothing left in it: there is nothing of OURS to
  // stage or commit. Don't fall back to an unscoped sweep — that is exactly
  // the concurrent-chat clobber the scope exists to prevent. The push
  // fall-through below still runs, making any earlier local-only commit
  // durable.
  const nothingInScope = paths !== undefined && paths.length === 0;
  const identity =
    author?.name && author?.email
      ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
      : [];
  // The committer is set through the env git reads for it, which takes
  // precedence over user.* — so author (from -c user.*) and committer stay
  // independent. Prefixed onto the commit command below.
  const committerEnv =
    committer?.name && committer?.email
      ? `GIT_COMMITTER_NAME=${sh(committer.name)} GIT_COMMITTER_EMAIL=${sh(committer.email)} `
      : "";

  if (!stagedOnly && !nothingInScope) {
    const staged = await boxExec(
      ctx,
      paths?.length
        ? boxGit(ctx, "add", "-A", "--", ...paths)
        : boxGit(ctx, "add", "-A"),
      { timeoutMs: 120_000 },
    );
    if (staged.exitCode !== 0) {
      throw new Error(`Could not stage changes: ${staged.stderr.slice(-300)}`);
    }
  }

  let madeCommit = !nothingInScope;
  if (!nothingInScope) {
    const committed = await boxExec(
      ctx,
      committerEnv +
        [
          "git",
          "-C",
          sh(boxRoot(ctx)),
          ...identity.map(sh),
          "commit",
          "-q",
          "-m",
          sh(message),
          ...(paths?.length ? ["--", ...paths.map(sh)] : []),
        ].join(" "),
      { timeoutMs: 120_000 },
    );
    if (committed.exitCode !== 0) {
      const said = `${committed.stdout}${committed.stderr}`;
      if (/nothing to commit|nothing added to commit/i.test(said)) {
        // No NEW commit — but don't return yet. An earlier commit whose push
        // failed (stale tunnel origin, say) is still local-only, and this is
        // exactly the moment to make it durable: fall through to the push,
        // which is a no-op when everything is already upstream.
        madeCommit = false;
      } else {
        throw new Error(`Could not commit: ${said.slice(-300)}`);
      }
    }
  }

  let pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
    timeoutMs: 180_000,
  });
  if (pushed.exitCode !== 0 && isUnreachableOrigin(pushed.stderr)) {
    await healBoxOrigin(ctx);
    pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
      timeoutMs: 180_000,
    });
  }
  if (pushed.exitCode !== 0) {
    // Someone else pushed to this branch first, so the push is a
    // non-fast-forward. Pull and try once more — which is exactly what a
    // developer does, and it keeps BOTH commits instead of picking one.
    // If the merge conflicts, the retry fails and git's message says so;
    // resolving it is the person's call, not ours, and the conflict is
    // sitting in a real checkout they can open a terminal on.
    await boxPull(ctx);
    pushed = await boxExec(ctx, boxGit(ctx, "push", "-q", "origin", "HEAD"), {
      timeoutMs: 180_000,
    });
  }
  if (pushed.exitCode !== 0) {
    throw new Error(
      `Committed in the sandbox, but the push failed — the commit is not durable yet: ${(pushed.stderr || pushed.stdout).slice(-300)}`,
    );
  }

  if (!madeCommit) {
    return { committed: false, reason: "No changes to commit" };
  }
  const head = await boxExec(ctx, boxGit(ctx, "rev-parse", "HEAD"), {
    timeoutMs: 30_000,
  });
  return { committed: true, commitOid: head.stdout.trim(), message };
}

/**
 * Commit one path as it is in the working copy onto `branch`, without moving
 * the checkout: HEAD, index and working tree stay as they are, so the other
 * chats and the UI sharing this working copy notice nothing.
 *
 * The commit is built on origin's `base` in a throwaway index, and the branch
 * is force-pushed to it. So the branch always holds `base` plus this path's
 * current state: one left by an earlier attempt, merged or not, is replaced,
 * never stacked on.
 */
export async function boxCommitPathToBranch(input: {
  ctx: SandboxExecContext;
  path: string;
  branch: string;
  base: string;
  message: string;
}): Promise<BoxCommitResult> {
  const { ctx, branch, base, message } = input;
  const path = safeRepoPath(input.path);
  const script = [
    "set -e",
    `cd ${sh(boxRoot(ctx))}`,
    "git fetch -q origin",
    `base=$(git rev-parse --verify -q ${sh(`refs/remotes/origin/${base}^{commit}`)})`,
    // Neither in the working copy nor on base: nothing to commit, and a
    // pathspec that matches nothing makes `git add` fail.
    `if [ ! -e ${sh(path)} ] && ! git cat-file -e "$base:"${sh(path)} 2>/dev/null; then echo mako-unchanged; exit 0; fi`,
    `idx="$(git rev-parse --absolute-git-dir)/mako-branch-index.$$"`,
    `trap 'rm -f "$idx"' EXIT`,
    `GIT_INDEX_FILE="$idx" git read-tree "$base"`,
    `GIT_INDEX_FILE="$idx" git add -A -- ${sh(path)}`,
    `tree=$(GIT_INDEX_FILE="$idx" git write-tree)`,
    `if [ "$tree" = "$(git rev-parse "$base^{tree}")" ]; then echo mako-unchanged; exit 0; fi`,
    `commit=$(git commit-tree "$tree" -p "$base" -m ${sh(message)})`,
    `git push -q origin "+$commit:"${sh(`refs/heads/${branch}`)}`,
    `echo "mako-commit $commit"`,
  ].join("\n");
  let result = await boxExec(ctx, script, { timeoutMs: 180_000 });
  if (result.exitCode !== 0 && isUnreachableOrigin(result.stderr)) {
    await healBoxOrigin(ctx);
    result = await boxExec(ctx, script, { timeoutMs: 180_000 });
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not commit to ${branch}: ${(result.stderr || result.stdout).slice(-300)}`,
    );
  }
  const commitOid = /mako-commit ([0-9a-f]+)/.exec(result.stdout)?.[1];
  if (!commitOid) {
    return { committed: false, reason: `No changes against ${base}` };
  }
  return { committed: true, commitOid, message };
}

/** A repo-relative path that stays inside the repo. */
function safeRepoPath(relPath: string): string {
  if (
    !relPath ||
    relPath.startsWith("/") ||
    relPath.split("/").some(seg => seg === "..") ||
    relPath.includes("\0")
  ) {
    throw new Error(`Refusing path outside the repository: ${relPath}`);
  }
  return relPath;
}

/**
 * Stage, unstage, or discard specific files — the per-file actions of VS
 * Code's Source Control view, as the git commands they stand for.
 *
 * discard: the working tree goes back to the INDEX version (what "Discard
 * Changes" on an unstaged change means), and an untracked file is removed;
 * each path is handled on its own so an untracked path does not fail the
 * checkout of the others.
 */
export async function boxGitPaths(
  ctx: SandboxExecContext,
  action: "stage" | "unstage" | "discard",
  paths: string[],
): Promise<void> {
  const safe = paths.map(safeRepoPath);
  if (safe.length === 0) return;
  let command: string;
  if (action === "stage") {
    command = boxGit(ctx, "add", "-A", "--", ...safe);
  } else if (action === "unstage") {
    command = boxGit(ctx, "reset", "-q", "HEAD", "--", ...safe);
  } else {
    // Tracked paths go back to the index version (checkout), untracked ones
    // are removed (clean) — split by `ls-files` so each command runs ONCE
    // over its list. Per-path invocations were 2 git calls per file, which
    // on 300 files outlived the request; and a single checkout over a mixed
    // list aborts entirely on the first untracked pathspec.
    const list = safe.map(sh).join(" ");
    command =
      `tracked=$(${boxGit(ctx, "ls-files", "-z", "--")} ${list} | tr '\\0' '\\n'); ` +
      `if [ -n "$tracked" ]; then printf '%s\\n' "$tracked" | tr '\\n' '\\0' | xargs -0 git -C ${sh(boxRoot(ctx))} checkout -q -- ; fi; ` +
      `${boxGit(ctx, "clean", "-qf", "--")} ${list}`;
  }
  const result = await boxExec(ctx, command, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not ${action} ${safe.length} file(s): ${(result.stderr || result.stdout).slice(-300)}`,
    );
  }
}

export interface BoxFileVersions {
  /** Contents at HEAD; null when the file is new. */
  head: string | null;
  /** Contents in the index; null when not staged/tracked. */
  index: string | null;
  /** Contents in the working tree; null when deleted. */
  working: string | null;
  binary: boolean;
}

/**
 * The three versions a diff can be drawn between (HEAD, index, working
 * tree) — in ONE exec. Each round trip to the sandbox is ~600ms, and the
 * obvious three-command shape made a one-line diff take three seconds.
 * Sections are base64 so no delimiter can occur inside a file.
 */
export async function boxFileVersions(
  ctx: SandboxExecContext,
  relPath: string,
): Promise<BoxFileVersions> {
  const p = safeRepoPath(relPath);
  const git = (spec: string) => boxGit(ctx, "show", spec);
  const file = sh(`${boxRoot(ctx)}/${p}`);
  // Absence must be decided by `git show`'s OWN exit status. Piped straight
  // into base64, the pipeline's status was base64's (0 even on empty stdin),
  // so a missing file parsed as an empty existing one and a new file diffed
  // as "modified from empty". Stage into a temp file first.
  const script =
    `t=$(mktemp); ` +
    `printf 'H:'; if ${git(`HEAD:${p}`)} >"$t" 2>/dev/null; then base64 -w0 <"$t"; printf '\\n'; else printf -- '-\\n'; fi; ` +
    `printf 'I:'; if ${git(`:${p}`)} >"$t" 2>/dev/null; then base64 -w0 <"$t"; printf '\\n'; else printf -- '-\\n'; fi; ` +
    `printf 'W:'; if [ -f ${file} ]; then base64 -w0 < ${file}; printf '\\n'; else printf -- '-\\n'; fi; rm -f "$t"`;
  const result = await boxExec(ctx, script, { timeoutMs: 60_000 });
  const sections: Record<string, string | null> = { H: null, I: null, W: null };
  for (const line of result.stdout.split("\n")) {
    const key = line.slice(0, 1);
    if (!(key in sections) || line[1] !== ":") continue;
    const body = line.slice(2);
    // `git show` of a missing object prints nothing and fails: the `||`
    // branch writes "-" for absent. An EMPTY existing file is "" (present).
    sections[key] =
      body === "-" ? null : Buffer.from(body, "base64").toString("utf8");
  }
  const working = sections.W;
  const binary = working !== null && working.includes("\u0000");
  return {
    head: sections.H,
    index: sections.I,
    working: binary ? null : working,
    binary,
  };
}

/** Branch + shaped changes, for pushing a fresh snapshot after a mutation. */
export async function boxPorcelain(
  ctx: SandboxExecContext,
): Promise<{ branch: string | null; changes: ChangedFile[] }> {
  const status = await boxStatus(ctx);
  return { branch: status.branch, changes: status.changes };
}

/**
 * Push commits the server does not have yet, and only then.
 *
 * A commit made in the terminal is a deliberate act, and a sandbox is
 * disposable — so a commit that has not reached the server is one nobody
 * promised to keep. This is the safety net for that, and it is deliberately
 * only about COMMITS: uncommitted work stays uncommitted, exactly as it would
 * on a laptop.
 *
 * The ahead-check runs in the sandbox so the common case (nothing to push)
 * costs no network at all.
 */
export async function boxPushIfAhead(ctx: SandboxExecContext): Promise<void> {
  const push = () =>
    boxExec(
      ctx,
      // A branch with no upstream is the `git checkout -b` case, and there the
      // answer is not "nothing to do" — the branch and every commit on it exist
      // ONLY on a machine that can be thrown away. Push it and set the upstream,
      // which is what push.autoSetupRemote already says we want.
      `if ${boxGit(ctx, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")} >/dev/null 2>&1; then ` +
        `ahead=$(${boxGit(ctx, "rev-list", "--count", "@{u}..HEAD")} 2>/dev/null || echo 0); ` +
        `if [ "$ahead" -gt 0 ]; then ${boxGit(ctx, "push", "-q", "origin", "HEAD")}; fi; ` +
        `else ${boxGit(ctx, "push", "-q", "-u", "origin", "HEAD")}; fi`,
      { timeoutMs: 180_000 },
    );
  let result = await push();
  if (result.exitCode !== 0 && isUnreachableOrigin(result.stderr)) {
    await healBoxOrigin(ctx);
    result = await push();
  }
  if (result.exitCode !== 0) {
    // This is a safety net, so a failure must not break the caller's flow —
    // but silence here is how commits quietly stay trapped in a disposable
    // machine. Leave a trail.
    logger.warn("Apps push-if-ahead failed", {
      sessionKey: ctx.sessionKey,
      said: (result.stderr || result.stdout).slice(-300),
    });
  }
}

/**
 * Switch branches — `git checkout`, and git decides the outcome.
 *
 * Git carries uncommitted work across when the two branches agree about the
 * files you touched, and refuses, naming them, when it would clobber
 * something. Passing its message through beats inventing one: it is the only
 * version that says which file.
 */
export async function boxCheckout(
  ctx: SandboxExecContext,
  branch: string,
  options: { create?: boolean } = {},
): Promise<void> {
  const fetched = await boxExec(ctx, boxGit(ctx, "fetch", "-q", "origin"), {
    timeoutMs: 120_000,
  });
  if (fetched.exitCode !== 0) {
    throw new Error(
      `Could not reach the remote: ${fetched.stderr.slice(-300)}`,
    );
  }
  // Creating: `git checkout -b` from HEAD, then push -u so the branch exists
  // at the remote immediately (auto-commit pushes assume an upstream).
  // Switching: prefer the remote's version if the box has never seen it.
  const result = await boxExec(
    ctx,
    options.create
      ? `${boxGit(ctx, "checkout", "-b", branch)} && ${boxGit(ctx, "push", "-q", "-u", "origin", branch)}`
      : `${boxGit(ctx, "checkout", branch)} || ${boxGit(ctx, "checkout", "-b", branch, `origin/${branch}`)}`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    const said = (result.stderr || result.stdout).trim();
    throw new Error(
      said
        ? `Could not switch to ${branch}.\n${said.slice(-600)}`
        : `Could not switch to ${branch}.`,
    );
  }
}

/** Throw away uncommitted work — what `git reset --hard` means everywhere. */
export async function boxDiscard(ctx: SandboxExecContext): Promise<void> {
  const result = await boxExec(
    ctx,
    // Ignored files (node_modules) stay: reinstalling them is not what
    // "discard my changes" asks for.
    `${boxGit(ctx, "reset", "-q", "--hard")} && ${boxGit(ctx, "clean", "-qfd")}`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not discard changes: ${result.stderr.slice(-300)}`);
  }
}
