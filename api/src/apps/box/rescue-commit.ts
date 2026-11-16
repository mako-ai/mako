/**
 * Rescue commit: make a box's uncommitted work durable on a side branch,
 * without touching any branch someone works on.
 *
 * Used before a box is deleted (box-idle.service.ts, the paused-box reaper)
 * and meant for any other pass that leaves boxes behind (the E2B workspace
 * move's pre-save, PR 1281, should call this instead of its own copy).
 *
 * The rules, all enforced here:
 * - The work is committed on top of HEAD in a THROWAWAY index and pushed to
 *   `mako-presave/<userId>/<YYYY-MM-DD>` only. The checkout, the real index,
 *   main and the session branch are never written, so nothing deploys
 *   (deploy-on-push reacts to main only) and a half-finished edit from two
 *   weeks ago never lands where people build.
 * - Never force, never pull, never merge. A name already taken on the server
 *   gets a `-<sha>` suffix instead of being overwritten.
 * - Secrets and build output never travel: files over 10 MB and anything
 *   matching RESCUE_EXCLUDES are left out and reported. Ignored files are
 *   reported too, so the caller can log what deletion will lose.
 * - Anything the helper cannot reason about safely (a merge or rebase in
 *   progress, unmerged paths, stashes, another local branch with commits the
 *   server lacks, no HEAD, a truncated listing) is "manual": the caller keeps
 *   the box.
 *
 * Execution is a parameter (`BoxRun`), so the same logic runs over a
 * connect-by-id handle (the reaper), the provider's exec, or a test double.
 */

export interface BoxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Output was cut at the runner's byte cap. */
  truncated?: boolean;
}

/** Run one shell command in the box. */
export type BoxRun = (
  command: string,
  options?: { timeoutMs?: number },
) => Promise<BoxRunResult>;

/**
 * Never committed or pushed by a rescue, whatever .gitignore says. Base-name
 * globs, matched case-insensitively. AWS credential files (`.aws/credentials`)
 * match by path.
 */
export const RESCUE_SECRET_NAMES = [
  ".env*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.p8",
  "*.pfx",
  "*.jks",
  "id_*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "credentials*.json",
  "*service-account*.json",
  "*-key.json",
  "*_key.json",
  "*service_account*.json",
  "*secret*.json",
  "secrets.y*ml",
  "token*.txt",
] as const;

/**
 * A GCP service-account key file keeps its default download name,
 * `<project>-<12 hex>.json`.
 */
const GCP_KEY_FILE = /-[0-9a-f]{12}\.json$/i;

/** Build output: left out of a rescue, and losing it is fine. */
export const RESCUE_EXCLUDED_DIRS = ["node_modules", "target", "dist"] as const;

/** Everything a rescue leaves out, for logs and docs. */
export const RESCUE_EXCLUDES = [
  ...RESCUE_SECRET_NAMES,
  "*/.aws/credentials",
  ...RESCUE_EXCLUDED_DIRS.map(d => `${d}/`),
] as const;

export const RESCUE_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Listing size for a path staged and then deleted, never in HEAD. */
export const INDEX_ONLY = -2;

/** At most this many paths are reported per list (excluded, ignored). */
const REPORT_CAP = 200;

export type RescueResult =
  | { status: "clean"; excluded: string[]; ignored: string[] }
  | {
      status: "saved";
      branch: string;
      commitOid: string;
      files: number;
      excluded: string[];
      ignored: string[];
      /**
       * The server already held this exact rescue (same tree on the same
       * parent) under `branch`; nothing was pushed. Makes a re-run idempotent
       * instead of minting a `-<sha>` branch per run.
       */
      unchanged?: boolean;
    }
  | { status: "manual"; reason: string; excluded: string[]; ignored: string[] };

export function rescueBranchName(userId: string, now: Date): string {
  return `mako-presave/${userId}/${now.toISOString().slice(0, 10)}`;
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

const NAME_RULES = RESCUE_SECRET_NAMES.map(globToRegExp);
const DIR_RULES: readonly string[] = RESCUE_EXCLUDED_DIRS;

/** Why a path is left out of a rescue, or null to include it. */
export function excludedBecause(path: string, size: number): string | null {
  if (size === INDEX_ONLY) return "index-only";
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (parts.slice(0, -1).some(dir => DIR_RULES.includes(dir.toLowerCase()))) {
    return "excluded directory";
  }
  if (NAME_RULES.some(rule => rule.test(base))) return "secret-shaped name";
  if (/(^|\/)\.aws\/credentials$/i.test(path)) return "secret-shaped name";
  if (GCP_KEY_FILE.test(base)) return "secret-shaped name";
  if (size > RESCUE_MAX_FILE_BYTES) return "over 10 MB";
  return null;
}

/**
 * A path that must never reach the server: a secret-shaped name or a blob
 * over 10 MB, anywhere (build directories included, since a committed blob
 * there would travel all the same).
 */
export function blockedBecause(path: string, size: number): string | null {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (NAME_RULES.some(rule => rule.test(base))) return "secret-shaped name";
  if (/(^|\/)\.aws\/credentials$/i.test(path)) return "secret-shaped name";
  if (GCP_KEY_FILE.test(base)) return "secret-shaped name";
  if (size > RESCUE_MAX_FILE_BYTES) return "over 10 MB";
  return null;
}

/**
 * blockedBecause, plus build output (node_modules/, target/, dist/, any
 * letter case) for commits the server lacks. Those folders are in
 * NEVER_COMMIT, so a commit carrying them was forced in by hand, and a
 * rescue push must not be the thing that uploads a dependency tree or a
 * build. Not applied to HEAD's whole tree: content already on the server
 * does not travel, and one committed `dist/` there would block every rescue.
 */
export function blockedInHistory(path: string, size: number): string | null {
  const blocked = blockedBecause(path, size);
  if (blocked) return blocked;
  const dirs = path.split("/").slice(0, -1);
  return dirs.some(dir => DIR_RULES.includes(dir.toLowerCase()))
    ? "excluded directory"
    : null;
}

/** Every blob in a tree: `<size>\t<path>\0` (ls-tree -l). */
export function treeScript(root: string, rev: string): string {
  return (
    `cd ${sh(root)} && git ls-tree -r -l -z ${sh(rev)} | ` +
    `while IFS= read -r -d '' rec; do meta="\${rec%%$'\t'*}"; p="\${rec#*$'\t'}"; ` +
    `set -- $meta; printf '%s\\t%s\\0' "$4" "$p"; done`
  );
}

/**
 * Every blob ADDED or CHANGED by a commit no remote has, ancestors of `rev`
 * included: `<size>\t<path>\0`. Pushing `rev` uploads exactly these, so
 * this is what must be clean before any push.
 */
export function unpushedBlobsScript(root: string, rev: string): string {
  return (
    `cd ${sh(root)} && for c in $(git rev-list ${sh(rev)} ${NOT_ON_SERVER}); do ` +
    `git diff-tree -r -z --root --no-commit-id -m --diff-filter=d "$c"; done | ` +
    `while IFS= read -r -d '' meta && IFS= read -r -d '' p; do set -- $meta; ` +
    `sz=$(git cat-file -s "$4" 2>/dev/null || echo 0); printf '%s\\t%s\\0' "$sz" "$p"; done`
  );
}

/** The first blocked blob in a `<size>\t<path>\0` listing, or null. */
export function firstBlocked(
  stdout: string,
  rule: (path: string, size: number) => string | null = blockedBecause,
): string | null {
  for (const { path, size } of parseChanges(stdout)) {
    const why = rule(path, size);
    if (why) return `${path} (${why})`;
  }
  return null;
}

export interface RescueInspection {
  hasRepo: boolean;
  /** `git remote get-url origin`; empty when there is none. */
  origin: string;
  head: string | null;
  /** null = detached HEAD. */
  branch: string | null;
  inProgress: string[];
  unmerged: number;
  stashes: number;
  /** Commits reachable from HEAD that no remote has. */
  headUnpushed: number;
  /** Other local branches with commits no remote has. */
  otherUnpushed: string[];
}

/** One read-only script answering everything the rescue needs to decide. */
/**
 * The ONLY refs that may count a commit as "already on the server": a fresh
 * copy of the origin's branches, fetched right before the scan. Local
 * remote-tracking refs are never trusted: a stale rescue record, a fetch
 * from a foreign origin, or a second remote (`github`) can each name a
 * commit this server has never received.
 */
export const SERVER_REFS = "refs/mako-server";
export const NOT_ON_SERVER = `--not --glob=${SERVER_REFS}/*`;

/** Fetch the origin's branches into SERVER_REFS, pruning ones it dropped. */
export function serverRefsScript(root: string): string {
  return `cd ${sh(root)} && GIT_TERMINAL_PROMPT=0 git fetch -q --prune --no-tags origin '+refs/heads/*:${SERVER_REFS}/*'`;
}

/** Whether there is a repository, and where its origin points. */
export function originScript(root: string): string {
  return [
    `cd ${sh(root)} 2>/dev/null && test -d .git || { echo repo=no; exit 0; }`,
    "echo repo=yes",
    'echo "origin=$(git remote get-url origin 2>/dev/null)"',
  ].join("\n");
}

export function inspectScript(root: string): string {
  return [
    `cd ${sh(root)} 2>/dev/null && test -d .git || { echo repo=no; exit 0; }`,
    "echo repo=yes",
    'echo "origin=$(git remote get-url origin 2>/dev/null)"',
    'echo "head=$(git rev-parse --verify -q HEAD)"',
    'echo "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "gd=$(git rev-parse --git-dir)",
    'for s in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$gd/$s" ] && echo "inprogress=$s"; done',
    '{ [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; } && echo inprogress=REBASE',
    'echo "unmerged=$(git ls-files -u 2>/dev/null | wc -l | tr -d " ")"',
    'echo "stashes=$(git stash list 2>/dev/null | wc -l | tr -d " ")"',
    `echo "headunpushed=$(git rev-list --count HEAD ${NOT_ON_SERVER} 2>/dev/null || echo 0)"`,
    "cur=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)",
    `git for-each-ref --format="%(refname:short)" refs/heads | while IFS= read -r b; do [ "$b" = "$cur" ] && continue; n=$(git rev-list --count "refs/heads/$b" ${NOT_ON_SERVER} 2>/dev/null || echo 0); [ "$n" -gt 0 ] && echo "otherunpushed=$b"; done`,
    "true",
  ].join("\n");
}

export function parseInspection(stdout: string): RescueInspection {
  const out: RescueInspection = {
    hasRepo: false,
    origin: "",
    head: null,
    branch: null,
    inProgress: [],
    unmerged: 0,
    stashes: 0,
    headUnpushed: 0,
    otherUnpushed: [],
  };
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "repo") out.hasRepo = value === "yes";
    else if (key === "origin") out.origin = value;
    else if (key === "head") out.head = value || null;
    else if (key === "branch") out.branch = value || null;
    else if (key === "inprogress" && value) out.inProgress.push(value);
    else if (key === "unmerged") out.unmerged = Number(value) || 0;
    else if (key === "stashes") out.stashes = Number(value) || 0;
    else if (key === "headunpushed") out.headUnpushed = Number(value) || 0;
    else if (key === "otherunpushed" && value) out.otherUnpushed.push(value);
  }
  return out;
}

/** `<size>\t<path>\0` per changed path (size -1 = deleted). */
export function changesScript(root: string): string {
  return (
    // Worktree changes, untracked files, AND staged changes: a file staged
    // and untouched since is not "modified" to ls-files, but it is work.
    `cd ${sh(root)} && { git ls-files -z --modified --deleted --others --exclude-standard; ` +
    `git diff --cached --name-only -z HEAD 2>/dev/null; } | sort -zu | ` +
    `while IFS= read -r -d '' f; do if [ -e "$f" ] || [ -L "$f" ]; then s=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f" 2>/dev/null || echo 0); ` +
    // Gone from disk: a delete of a HEAD file (-1), or a file that only ever
    // existed in the index, staged and then removed (-2, "index-only").
    `elif git cat-file -e "HEAD:$f" 2>/dev/null; then s=-1; else s=-2; fi; printf '%s\\t%s\\0' "$s" "$f"; done`
  );
}

export function parseChanges(
  stdout: string,
): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    out.push({
      size: Number(record.slice(0, tab)),
      path: record.slice(tab + 1),
    });
  }
  return out;
}

export function ignoredScript(root: string): string {
  return `cd ${sh(root)} && git ls-files -z --others --ignored --exclude-standard --directory | head -c 200000`;
}

/**
 * Commit `paths` on top of HEAD in a throwaway index. Prints COMMIT=<oid>.
 * The checkout and the real index are not touched.
 */
export function commitScript(input: {
  root: string;
  paths: string[];
  message: string;
  author?: { name?: string; email?: string };
}): string {
  const list = Buffer.from(input.paths.join("\0")).toString("base64");
  // Authored by the person whose work it is (the git endpoint checks the
  // author against the token), COMMITTED by "Mako Agent", as agent turns
  // are: `git log --format='%an / %cn'` shows Mako made the rescue.
  const who =
    (input.author?.name && input.author?.email
      ? `GIT_AUTHOR_NAME=${sh(input.author.name)} GIT_AUTHOR_EMAIL=${sh(input.author.email)} `
      : "") +
    "GIT_COMMITTER_NAME='Mako Agent' GIT_COMMITTER_EMAIL='agent@mako.ai' ";
  return [
    `cd ${sh(input.root)} || exit 1`,
    "idx=$(mktemp) && lst=$(mktemp) || exit 1",
    'trap \'rm -f "$idx" "$lst"\' EXIT',
    `printf '%s' ${sh(list)} | base64 -d > "$lst"`,
    'GIT_INDEX_FILE="$idx" git read-tree HEAD || exit 1',
    'GIT_INDEX_FILE="$idx" GIT_LITERAL_PATHSPECS=1 git add -A --pathspec-from-file="$lst" --pathspec-file-nul || exit 1',
    'tree=$(GIT_INDEX_FILE="$idx" git write-tree) || exit 1',
    `commit=$(${who}git commit-tree "$tree" -p HEAD -m ${sh(input.message)}) || exit 1`,
    'echo "COMMIT=$commit"',
  ].join("\n");
}

/**
 * An existing rescue on the server (`base` or `base-<sha8>`, read from
 * SERVER_REFS) holding the same content as `commit`: the same commit, or the
 * same tree on the same first parent. Prints `SAME=<sha> <branch>`.
 */
export function sameRescueScript(
  root: string,
  base: string,
  commit: string,
): string {
  const hex8 = "[0-9a-f]".repeat(8);
  return [
    `cd ${sh(root)} || exit 1`,
    `c=${sh(commit)}; base=${sh(base)}`,
    't=$(git rev-parse "$c^{tree}") || exit 1',
    'p=$(git rev-parse -q --verify "$c^1" 2>/dev/null || true)',
    `git for-each-ref --format="%(objectname) %(refname)" "${SERVER_REFS}/" | while read -r x r; do`,
    `  b="\${r#${SERVER_REFS}/}"`,
    `  case "$b" in "$base"|"$base"-${hex8}) ;; *) continue;; esac`,
    '  if [ "$x" = "$c" ] || { [ "$(git rev-parse "$x^{tree}")" = "$t" ] && [ "$(git rev-parse -q --verify "$x^1" 2>/dev/null || true)" = "$p" ]; }; then echo "SAME=$x $b"; break; fi',
    "done",
    "true",
  ].join("\n");
}

/** Push one commit to a NEW branch name. No force; refuses to overwrite. */
export function pushScript(
  root: string,
  commit: string,
  branch: string,
): string {
  return (
    `cd ${sh(root)} && GIT_TERMINAL_PROMPT=0 git push -q origin ${sh(`${commit}:refs/heads/${branch}`)} && ` +
    `git ls-remote origin ${sh(`refs/heads/${branch}`)}`
  );
}

export async function rescueCommit(input: {
  run: BoxRun;
  root: string;
  userId: string;
  now: Date;
  author?: { name?: string; email?: string };
  /**
   * The only origin a rescue may push to: this workspace's production
   * apps-git endpoint (config.ts appsGitOriginUrl). Anything else is manual.
   * Required: a rescue with no expected origin would push wherever the box
   * points.
   */
  expectedOrigin: string;
  /** Refresh the box's git credential; runs before the server's refs are read. */
  prepareRemote?: () => Promise<void>;
  /**
   * The caller already pushed every stash to its own rescue ref (the E2B
   * move's pre-save, box-presave.ts), so stashes no longer make this manual.
   */
  stashesHandled?: boolean;
  /** Commit message; defaults to the idle-sandbox wording. */
  message?: string;
}): Promise<RescueResult> {
  const { run, root } = input;
  const excluded: string[] = [];
  const ignored: string[] = [];
  const manual = (reason: string): RescueResult => ({
    status: "manual",
    reason,
    excluded,
    ignored,
  });

  const origin = await run(originScript(root), { timeoutMs: 30_000 });
  if (origin.exitCode !== 0) {
    return manual(`reading the origin failed: ${origin.stderr.slice(-200)}`);
  }
  // "No repository" must be said, not inferred: anything but an explicit
  // repo=no or repo=yes keeps the box.
  if (/^repo=no$/m.test(origin.stdout)) {
    return { status: "clean", excluded, ignored };
  }
  if (!/^repo=yes$/m.test(origin.stdout)) {
    return manual("could not tell whether the box holds a repository");
  }
  const where = parseInspection(origin.stdout);
  // A box pointing anywhere but this workspace's apps-git endpoint is not
  // one we can save to: push nothing, and never delete it.
  if (!input.expectedOrigin || where.origin !== input.expectedOrigin) {
    return manual(
      `origin is not this workspace's apps-git endpoint (${where.origin || "none"})`,
    );
  }
  // Credential first, then a fresh read of what the server really holds.
  // Every "unpushed" answer below is measured against that read only.
  await input.prepareRemote?.();
  const fetched = await run(serverRefsScript(root), { timeoutMs: 120_000 });
  if (fetched.exitCode !== 0) {
    return manual(
      `could not read the server's branches: ${fetched.stderr.slice(-200)}`,
    );
  }

  const inspected = await run(inspectScript(root), { timeoutMs: 60_000 });
  if (inspected.exitCode !== 0) {
    return manual(`inspect failed: ${inspected.stderr.slice(-200)}`);
  }
  const seen = parseInspection(inspected.stdout);

  const ign = await run(ignoredScript(root), { timeoutMs: 60_000 });
  for (const path of ign.stdout.split("\0").filter(Boolean)) {
    if (ignored.length < REPORT_CAP) ignored.push(path);
  }

  if (seen.inProgress.length > 0) {
    return manual(
      `${seen.inProgress.join(", ").toLowerCase()} in progress; resolve in the box`,
    );
  }
  if (seen.unmerged > 0) return manual("unmerged paths (conflict) in the box");
  if (seen.stashes > 0 && !input.stashesHandled) {
    return manual(`${seen.stashes} stash entries`);
  }
  if (seen.otherUnpushed.length > 0) {
    return manual(
      `local branches with commits the server lacks: ${seen.otherUnpushed.join(", ")}`,
    );
  }

  const listed = await run(changesScript(root), { timeoutMs: 120_000 });
  if (listed.exitCode !== 0) {
    return manual(`listing changes failed: ${listed.stderr.slice(-200)}`);
  }
  if (listed.truncated) return manual("too many changed paths to list");
  const include: string[] = [];
  const kept: string[] = [];
  for (const { path, size } of parseChanges(listed.stdout)) {
    const why = excludedBecause(path, size);
    if (why) {
      if (excluded.length < REPORT_CAP) excluded.push(`${path} (${why})`);
      // Build output is regenerable; a secret or a big file is not, and
      // deleting the box would lose the only copy.
      // An index-only path (staged, then deleted) has no file to commit: it
      // is reported and the rescue continues.
      if (why !== "excluded directory" && why !== "index-only") kept.push(path);
    } else {
      include.push(path);
    }
  }
  if (kept.length > 0) {
    return manual(
      `uncommitted files that a rescue must not push: ${kept.slice(0, 5).join(", ")}`,
    );
  }

  if (include.length === 0 && seen.headUnpushed === 0) {
    return { status: "clean", excluded, ignored };
  }
  if (!seen.head) {
    return manual("uncommitted work in a repository with no commit");
  }

  let commit = seen.head;
  if (include.length > 0) {
    // Never build a rescue on a tree that already carries a blocked file.
    const tree = await run(treeScript(root, seen.head), { timeoutMs: 120_000 });
    if (tree.exitCode !== 0 || tree.truncated) {
      return manual("could not scan the HEAD tree");
    }
    const inHead = firstBlocked(tree.stdout);
    if (inHead) return manual(`HEAD tree holds a blocked file: ${inHead}`);
    const made = await run(
      commitScript({
        root,
        paths: include,
        message:
          input.message ??
          `Rescue: uncommitted work from an idle sandbox (${input.now.toISOString().slice(0, 10)})`,
        author: input.author,
      }),
      { timeoutMs: 180_000 },
    );
    const oid = /COMMIT=([0-9a-f]{40})/.exec(made.stdout)?.[1];
    if (made.exitCode !== 0 || !oid) {
      return manual(`rescue commit failed: ${made.stderr.slice(-200)}`);
    }
    commit = oid;
  }

  // Pushing `commit` uploads every ancestor no remote has. Scan all of them
  // (not just the working tree) before anything leaves the box.
  const scan = await scanUnpushed(run, root, commit);
  if (scan.status === "error") return manual(scan.reason);
  if (scan.status === "blocked") {
    return manual(`unpushed history holds a blocked file: ${scan.path}`);
  }

  const base = rescueBranchName(input.userId, input.now);
  const same = await run(sameRescueScript(root, base, commit), {
    timeoutMs: 60_000,
  });
  const existing = /^SAME=([0-9a-f]{40}) (.+)$/m.exec(same.stdout);
  if (same.exitCode === 0 && existing?.[1] && existing[2]) {
    return {
      status: "saved",
      branch: existing[2],
      commitOid: existing[1],
      files: include.length,
      excluded,
      ignored,
      unchanged: true,
    };
  }
  const pushed = await pushRescueBranch(run, root, commit, base);
  if (pushed.status !== "pushed") return manual(pushed.reason);
  return {
    status: "saved",
    branch: pushed.branch,
    commitOid: commit,
    files: include.length,
    excluded,
    ignored,
  };
}

/**
 * Is `rev` safe to push? Scans every blob added by a commit the server does
 * not hold. Run `serverRefsScript` first: only SERVER_REFS count as "on the
 * server". Named export for every rescue path: a branch, a detached HEAD, a
 * stash commit.
 */
export async function scanUnpushed(
  run: BoxRun,
  root: string,
  rev: string,
): Promise<
  | { status: "clean" }
  | { status: "blocked"; path: string }
  | { status: "error"; reason: string }
> {
  const history = await run(unpushedBlobsScript(root, rev), {
    timeoutMs: 180_000,
  });
  if (history.exitCode !== 0 || history.truncated) {
    return { status: "error", reason: "could not scan the unpushed history" };
  }
  const leak = firstBlocked(history.stdout, blockedInHistory);
  return leak ? { status: "blocked", path: leak } : { status: "clean" };
}

/**
 * Push `commit` to `base`, or to `base-<sha8>` when `base` is taken. Never
 * forces; verifies the server holds the commit. Call scanUnpushed first.
 */
export async function pushRescueBranch(
  run: BoxRun,
  root: string,
  commit: string,
  base: string,
): Promise<
  { status: "pushed"; branch: string } | { status: "failed"; reason: string }
> {
  for (const branch of [base, `${base}-${commit.slice(0, 8)}`]) {
    const pushed = await run(pushScript(root, commit, branch), {
      timeoutMs: 180_000,
    });
    if (pushed.exitCode === 0 && pushed.stdout.includes(commit)) {
      return { status: "pushed", branch };
    }
    // Only a taken name is worth a second try; anything else is final.
    if (
      !/rejected|non-fast-forward|already exists|fetch first/i.test(
        pushed.stderr,
      )
    ) {
      return {
        status: "failed",
        reason: `push failed: ${pushed.stderr.slice(-200)}`,
      };
    }
  }
  return {
    status: "failed",
    reason: "rescue branch names already taken on the server",
  };
}
