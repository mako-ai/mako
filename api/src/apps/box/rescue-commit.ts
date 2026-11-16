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
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (parts.slice(0, -1).some(dir => DIR_RULES.includes(dir))) {
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
    `cd ${sh(root)} && for c in $(git rev-list ${sh(rev)} --not --remotes); do ` +
    `git diff-tree -r -z --root --no-commit-id -m --diff-filter=d "$c"; done | ` +
    `while IFS= read -r -d '' meta && IFS= read -r -d '' p; do set -- $meta; ` +
    `sz=$(git cat-file -s "$4" 2>/dev/null || echo 0); printf '%s\\t%s\\0' "$sz" "$p"; done`
  );
}

/** The first blocked blob in a `<size>\t<path>\0` listing, or null. */
export function firstBlocked(stdout: string): string | null {
  for (const { path, size } of parseChanges(stdout)) {
    const why = blockedBecause(path, size);
    if (why) return `${path} (${why})`;
  }
  return null;
}

export interface RescueInspection {
  hasRepo: boolean;
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
export function inspectScript(root: string): string {
  return [
    `cd ${sh(root)} 2>/dev/null && test -d .git || { echo repo=no; exit 0; }`,
    "echo repo=yes",
    'echo "head=$(git rev-parse --verify -q HEAD)"',
    'echo "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "gd=$(git rev-parse --git-dir)",
    'for s in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$gd/$s" ] && echo "inprogress=$s"; done',
    '{ [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; } && echo inprogress=REBASE',
    'echo "unmerged=$(git ls-files -u 2>/dev/null | wc -l | tr -d " ")"',
    'echo "stashes=$(git stash list 2>/dev/null | wc -l | tr -d " ")"',
    'echo "headunpushed=$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"',
    "cur=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)",
    'git for-each-ref --format="%(refname:short)" refs/heads | while IFS= read -r b; do [ "$b" = "$cur" ] && continue; n=$(git rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null || echo 0); [ "$n" -gt 0 ] && echo "otherunpushed=$b"; done',
    "true",
  ].join("\n");
}

export function parseInspection(stdout: string): RescueInspection {
  const out: RescueInspection = {
    hasRepo: false,
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
    `while IFS= read -r -d '' f; do if [ -e "$f" ]; then s=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f" 2>/dev/null || echo 0); else s=-1; fi; printf '%s\\t%s\\0' "$s" "$f"; done`
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
  const who =
    input.author?.name && input.author?.email
      ? `GIT_AUTHOR_NAME=${sh(input.author.name)} GIT_AUTHOR_EMAIL=${sh(input.author.email)} ` +
        `GIT_COMMITTER_NAME=${sh(input.author.name)} GIT_COMMITTER_EMAIL=${sh(input.author.email)} `
      : "";
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
  /** Refresh the box's git credential; runs only when something must be pushed. */
  prepareRemote?: () => Promise<void>;
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

  const inspected = await run(inspectScript(root), { timeoutMs: 60_000 });
  if (inspected.exitCode !== 0) {
    return manual(`inspect failed: ${inspected.stderr.slice(-200)}`);
  }
  const seen = parseInspection(inspected.stdout);
  if (!seen.hasRepo) return { status: "clean", excluded, ignored };

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
  if (seen.stashes > 0) return manual(`${seen.stashes} stash entries`);
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
      if (why !== "excluded directory") kept.push(path);
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
        message: `Rescue: uncommitted work from an idle sandbox (${input.now.toISOString().slice(0, 10)})`,
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
  const history = await run(unpushedBlobsScript(root, commit), {
    timeoutMs: 180_000,
  });
  if (history.exitCode !== 0 || history.truncated) {
    return manual("could not scan the unpushed history");
  }
  const leak = firstBlocked(history.stdout);
  if (leak) return manual(`unpushed history holds a blocked file: ${leak}`);

  await input.prepareRemote?.();
  const base = rescueBranchName(input.userId, input.now);
  for (const branch of [base, `${base}-${commit.slice(0, 8)}`]) {
    const pushed = await run(pushScript(root, commit, branch), {
      timeoutMs: 180_000,
    });
    if (pushed.exitCode === 0 && pushed.stdout.includes(commit)) {
      return {
        status: "saved",
        branch,
        commitOid: commit,
        files: include.length,
        excluded,
        ignored,
      };
    }
    // Only a taken name is worth a second try; anything else is final.
    if (
      !/rejected|non-fast-forward|already exists|fetch first/i.test(
        pushed.stderr,
      )
    ) {
      return manual(`push failed: ${pushed.stderr.slice(-200)}`);
    }
  }
  return manual("rescue branch names already taken on the server");
}
