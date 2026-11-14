/**
 * A sandbox catching up with main while its owner has uncommitted work in a
 * folder main RENAMED (an app renamed or moved by someone else).
 *
 * A rename moves every file of the app. The plain catch-up (`git merge
 * @{u}`, boxPull) then does one of two bad things:
 *
 *  - an uncommitted EDIT to a file of the renamed app makes git refuse the
 *    merge: the sandbox never catches up, and a later save lands in a new
 *    folder holding only that file;
 *  - an uncommitted NEW file stays in the old folder: the renamed app does
 *    not have it.
 *
 * git's own `merge --autostash` follows the rename for edits but, when one
 * conflicts, writes conflict markers INTO the person's file and still exits
 * 0 (measured in scenarios/app-rename-sandbox.scenarios.test.ts). So the
 * drafts are carried here:
 *
 *  1. Every draft (tracked edits, staged files, untracked files; .gitignore
 *     respected) becomes a commit on `mako-drafts/<time>`, built in a
 *     scratch index. Nothing below can lose what that branch holds.
 *  2. The working copy is made clean — removing only what the snapshot
 *     holds — and main is merged as into any clean checkout.
 *  3. The tracked drafts are cherry-picked onto the result without
 *     committing, with rename and directory-rename detection: an edit to
 *     apps/a/x lands on apps/b/x. A file that conflicts is reset to main's
 *     version (the draft stays on the branch) — never conflict markers.
 *  4. Untracked files go back as what they were (file, executable, link),
 *     where the rename put their folder; if a file is already there, at
 *     their old path; if that is taken too, they stay on the branch.
 *  5. Ignored leftovers (node_modules, dist) follow a folder that only
 *     changed its name, and the emptied old folder is removed.
 *  6. All changes come back unstaged. The branch is deleted when everything
 *     was carried faithfully; otherwise the notice names it.
 *
 * If the merge in step 2 fails, the working copy and the index are put back
 * exactly as they were. Drafts no rename touched take the plain merge, as
 * before. Every decision reads an exit code or `-z`/porcelain output, never
 * git's messages, and uses nothing newer than git 2.39 (the sandbox image).
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";

/** Why an untracked draft could not be put back as it was. */
export type StrandedReason =
  /** Both its new place and its old place are taken. */
  | "taken"
  /** A symbolic link whose target is absolute or leaves the repository. */
  | "escaping-link"
  /** A folder on its way is a symbolic link: never written through. */
  | "linked-folder"
  /** A nested repository (git keeps only a pointer); left where it was. */
  | "unsupported"
  | "write-failed";

export interface PathMove {
  from: string;
  to: string;
}

/** What a catch-up did with the drafts (for the notice, and for tests). */
export interface CatchUpOutcome {
  /** The plain merge ran: no draft was in a renamed folder. */
  plain: boolean;
  /** The folders main renamed since the box last caught up. */
  renames: PathMove[];
  /** Untracked files that followed their folder. */
  moved: PathMove[];
  /** Tracked drafts carried onto main (paths before the catch-up). */
  carried: string[];
  /** Tracked drafts that conflicted: main's version kept, draft on the branch. */
  conflicted: string[];
  /** Untracked drafts left at their old path: the new one is taken. */
  keptInPlace: string[];
  /** Untracked drafts not put back, and why. They are on the branch. */
  stranded: string[];
  strandedWhy: Record<string, StrandedReason>;
  /** Ignored leftovers (node_modules, dist…) moved along. */
  ignoredMoved: PathMove[];
  /** The branch holding every draft, when anything was not carried. */
  draftsBranch?: string;
  /**
   * The box is not caught up. "merge": main could not be merged, and the
   * working copy is exactly as it was. "detached": HEAD is on no branch,
   * nothing was tried. "interrupted": a step failed after the snapshot.
   */
  failed?: "merge" | "detached" | "interrupted";
  /** Files of the box's own commits that conflict with main ("merge"). */
  mergeConflicts?: string[];
  /** What git or the shell said, for the log — never parsed. */
  said?: string;
  /** What to tell the person, when anything beyond "caught up" happened. */
  message?: string;
}

/** Exit codes of {@link mergeUnlessRenamed} that are not git's own. */
export const PULL_RENAMED = 91;
export const PULL_DETACHED = 92;
export const PULL_BUSY = 93;

// In the box's .git: the lock one catch-up holds, the scratch index (and
// the person's own, saved) it works in, and the refusal it remembers.
const LOCK = "mako-catch-up.lock";
const SCRATCH = "mako-drafts-index";
const REFUSED = "mako-catch-up-refused";
const gitPath = (name: string) => `"$(git rev-parse --git-path ${name})"`;
/** With $lock set: is the lock less than ten minutes old (its holder alive)? */
const FRESH = `[ -z "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]`;

/**
 * The pull's merge, run in the working copy — except that it stands back
 * (exit {@link PULL_RENAMED}) when the box is behind and main renamed files,
 * so {@link catchUpAcrossRenames} can carry the drafts. One exec either way:
 * a pull with no rename costs what it did before.
 */
export function mergeUnlessRenamed(defaultBranch: string): string {
  return [
    `renamed() { b=$(git merge-base HEAD "$1" 2>/dev/null) && [ -n "$(git diff -M --diff-filter=R --name-only "$b" "$1" | head -c 1)" ]; }`,
    // A catch-up that could not merge is not tried again until HEAD or main
    // moves: the plain merge below then refuses, touching nothing, as before.
    `refused() { [ "$(cat ${gitPath(REFUSED)} 2>/dev/null)" = "$(git rev-parse HEAD '@{u}' | tr '\\n' ' ')" ]; }`,
    // A catch-up under way: stand back. One that died holding the lock is
    // taken over by the careful path, which says what it left behind.
    `lock=${gitPath(LOCK)}`,
    `if [ -d "$lock" ]; then ${FRESH} && exit ${PULL_BUSY}; exit ${PULL_RENAMED}; fi`,
    `if git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then`,
    `  git merge-base --is-ancestor '@{u}' HEAD || { renamed '@{u}' && ! refused && exit ${PULL_RENAMED}; }`,
    `elif ! git symbolic-ref -q HEAD >/dev/null; then`,
    `  main=refs/remotes/origin/${defaultBranch}`,
    `  git rev-parse -q --verify "$main" >/dev/null 2>&1 && ! git merge-base --is-ancestor "$main" HEAD && renamed "$main" && exit ${PULL_DETACHED}`,
    `fi`,
    `git merge --no-edit '@{u}'`,
  ].join("\n");
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const nul = (out: string) => out.split("\0").filter(Boolean);
const lines = (out: string) => out.split("\n").filter(Boolean);
const said = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  from?: string;
}

/** `git status --porcelain=v1 -z` → entries. */
function parsePorcelainZ(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const entry: StatusEntry = { x: f[0], y: f[1], path: f.slice(3) };
    if ("RC".includes(entry.x) || "RC".includes(entry.y)) {
      entry.from = fields[++i];
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The folders a set of file renames moved. For each renamed file: its
 * topmost folder that is gone upstream, and where the rest of its path
 * hangs now — `apps/a/src/x → apps/b/src/x` is `apps/a → apps/b`, and
 * `apps/a/src/x → apps/Team/a/src/x` is `apps/a → apps/Team/a`. A file
 * moved out of a folder that stays is not a folder rename.
 */
function folderRenames(
  files: ReadonlyArray<PathMove>,
  isGone: (dir: string) => boolean,
): PathMove[] {
  const out = new Map<string, string>();
  for (const { from, to } of files) {
    const parts = from.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      if (!isGone(dir)) continue;
      const tail = from.slice(dir.length);
      if (to.endsWith(tail) && to.length > tail.length && !out.has(dir)) {
        out.set(dir, to.slice(0, -tail.length));
      }
      break;
    }
  }
  return [...out].map(([from, to]) => ({ from, to }));
}

/** `p` mapped through the deepest folder move that contains it. */
function mapThroughRenames(
  p: string,
  renames: ReadonlyArray<PathMove>,
): string | null {
  let best: PathMove | null = null;
  for (const r of renames) {
    if (
      p.startsWith(`${r.from}/`) &&
      (!best || r.from.length > best.from.length)
    ) {
      best = r;
    }
  }
  return best ? `${best.to}${p.slice(best.from.length)}` : null;
}

/**
 * Does a symbolic link at `at` (repo-relative) pointing to `target` stay
 * inside the repository? An absolute target, one that climbs above the
 * root, or one into `.git` does not — it is never recreated. Pure: the
 * target is judged as text, never followed.
 */
function linkStaysInside(at: string, target: string): boolean {
  if (!target || target.startsWith("/")) return false;
  const parts = at.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts[0] !== ".git";
}

type Box = ReturnType<typeof shellIn>;

function shellIn(ctx: SandboxExecContext, root: string) {
  const provider = getSandboxProvider();
  const sh = (script: string) =>
    provider.exec(ctx, `cd ${q(root)} || exit 96\n${script}`, {
      timeoutMs: 180_000,
    });
  /**
   * Output that is parsed: the command must succeed and its output be
   * whole (providers cap output; a cut list must never pass for a list).
   */
  const out = async (script: string): Promise<string> => {
    const r = await sh(`{ ${script}\n} && printf '\\0ok'`);
    if (r.exitCode !== 0 || !r.stdout.endsWith("\0ok")) {
      const detail = (r.stderr || r.stdout).trim().slice(-300);
      throw new Error(
        `${script.slice(0, 60)}: ${detail || `exit ${r.exitCode}`}`,
      );
    }
    return r.stdout.slice(0, -3);
  };
  return { sh, out };
}

/** Folders main renamed between the box's fork point and `upstream`. */
async function goneFolders(
  box: Box,
  head: string,
  upstream: string,
): Promise<PathMove[]> {
  const fields = (
    await box.out(
      `git diff -M --diff-filter=R --name-status -z "$(git merge-base ${head} ${upstream})" ${upstream}`,
    )
  ).split("\0");
  const files: PathMove[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    files.push({ from: fields[i + 1], to: fields[i + 2] });
  }
  const dirs = new Set<string>();
  for (const { from } of files) {
    const parts = from.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      // One name per line below: a name holding a newline is not asked.
      if (!dir.includes("\n")) dirs.add(dir);
    }
  }
  if (dirs.size === 0) return [];
  const asked = [...dirs];
  const types = (
    await box.out(
      `printf '%s\\n' ${asked.map(d => q(`${upstream}:${d}`)).join(" ")} | git cat-file --batch-check='%(objecttype)'`,
    )
  ).split("\n");
  const there = new Set(asked.filter((_, i) => types[i] === "tree"));
  return folderRenames(files, dir => dirs.has(dir) && !there.has(dir));
}

const inRenamed = (e: StatusEntry, renames: ReadonlyArray<PathMove>) =>
  [e.path, e.from].some(p => p && mapThroughRenames(p, renames));

/**
 * What git never tracks — node_modules, dist, caches — stays in a folder
 * main renamed: git moves only what it tracks. It is moved along when the
 * folder only changed its name (same depth, so relative links inside
 * node_modules still hold), holds nothing git sees, and the new folder has
 * no entry of that name: the dev server boots without a reinstall and no
 * husk of the old app is left. Never into or out of a folder that is a
 * link; the emptied folder goes with rmdir, never a recursive delete.
 */
const MOVE_IGNORED = `move_ignored() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -d "$2" ] && [ ! -L "$2" ] || return 0
  [ -z "$(git --literal-pathspecs ls-files --cached --others --exclude-standard -- "$1" | head -c 1)" ] || return 0
  for src in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$src" ] || [ -L "$src" ] || continue
    dst=$2/\${src##*/}
    [ -e "$dst" ] || [ -L "$dst" ] || { mv -- "$src" "$dst" && printf '%s\\0%s\\0' "$src" "$dst"; }
  done
  rmdir -p -- "$1" 2>/dev/null
  return 0
}`;

async function moveIgnoredLeftovers(
  box: Box,
  renames: ReadonlyArray<PathMove>,
): Promise<PathMove[]> {
  const sameDepth = renames.filter(
    r => r.from.split("/").length === r.to.split("/").length,
  );
  if (sameDepth.length === 0) return [];
  const done = await box.sh(
    `${MOVE_IGNORED}\n${sameDepth.map(r => `move_ignored ${q(r.from)} ${q(r.to)}`).join("\n")}`,
  );
  const fields = nul(done.stdout);
  const moved: PathMove[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    moved.push({ from: fields[i], to: fields[i + 1] });
  }
  return moved;
}

/**
 * Where an untracked draft can go: its place in the renamed folder ($1,
 * may be empty) if free, else its old path ($2) if free. Prints M or K for
 * those, T when both are taken, L when a folder on the way is a link.
 */
const PROBE = `probe() {
  for d in "$1" "$2"; do
    [ -n "$d" ] || continue
    if [ -e "$d" ] || [ -L "$d" ]; then continue; fi
    p=$d
    while [ "$p" != "\${p%/*}" ]; do
      p=\${p%/*}
      if [ -L "$p" ]; then printf L; return; fi
    done
    if [ "$d" = "$1" ]; then printf M; else printf K; fi
    return
  done
  printf T
}`;

interface UntrackedDraft {
  path: string;
  /** From the snapshot's tree: 100644, 100755, 120000 (link), 160000. */
  mode: string;
  oid: string;
}

/** In batches, so no one script nears a shell's argument limit. */
function batches<T>(items: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Put the untracked drafts back, each as what the snapshot says it was: a
 * file's bytes (and its exec bit), or a link recreated as a link with the
 * same target — never followed, never written as a file. Nothing existing
 * is overwritten (`set -C`, `ln` without -f).
 */
async function placeUntracked(
  box: Box,
  drafts: UntrackedDraft[],
  renames: ReadonlyArray<PathMove>,
  outcome: CatchUpOutcome,
): Promise<void> {
  const strand = (p: string, why: StrandedReason) => {
    outcome.stranded.push(p);
    outcome.strandedWhy[p] = why;
  };
  const files = drafts.filter(d => {
    // A nested repository was never removed: it is where it was.
    if (d.mode === "160000") strand(d.path, "unsupported");
    return d.mode !== "160000";
  });
  const links = files.filter(d => d.mode === "120000");
  const targets = new Map<string, string>();
  for (const batch of batches(links, 500)) {
    const read = (
      await box.out(
        batch
          .map(d => `git cat-file blob ${d.oid} && printf '\\0'`)
          .join(" && "),
      )
    ).split("\0");
    batch.forEach((d, i) => targets.set(d.path, read[i]));
  }
  const mapped = (d: UntrackedDraft) => mapThroughRenames(d.path, renames);
  for (const batch of batches(files)) {
    const verdicts = await box.out(
      `${PROBE}\n${batch.map(d => `probe ${q(mapped(d) ?? "")} ${q(d.path)}`).join("\n")}`,
    );
    if (verdicts.length !== batch.length) throw new Error("probe: short");
    const writes: Array<{ draft: UntrackedDraft; dest: string; sh: string }> =
      [];
    batch.forEach((draft, i) => {
      const verdict = verdicts[i];
      if (verdict === "T") return strand(draft.path, "taken");
      if (verdict === "L") return strand(draft.path, "linked-folder");
      const dest = verdict === "M" ? (mapped(draft) as string) : draft.path;
      const slash = dest.lastIndexOf("/");
      const mkdir =
        slash > 0 ? `mkdir -p -- ${q(dest.slice(0, slash))} && ` : "";
      if (draft.mode === "120000") {
        const target = targets.get(draft.path) ?? "";
        if (!linkStaysInside(dest, target)) {
          return strand(draft.path, "escaping-link");
        }
        writes.push({
          draft,
          dest,
          sh: `${mkdir}ln -s -- ${q(target)} ${q(dest)}`,
        });
      } else {
        const exec =
          draft.mode === "100755" ? ` && chmod +x ${q(`./${dest}`)}` : "";
        writes.push({
          draft,
          dest,
          sh: `${mkdir}(set -C; git cat-file blob ${draft.oid} > ${q(dest)})${exec}`,
        });
      }
    });
    if (writes.length === 0) continue;
    const wrote = await box.out(
      writes
        .map(w => `{ ${w.sh}; } >/dev/null 2>&1 && printf 1 || printf 0`)
        .join("\n"),
    );
    writes.forEach(({ draft, dest }, i) => {
      if (wrote[i] !== "1") strand(draft.path, "write-failed");
      else if (dest !== draft.path) {
        outcome.moved.push({ from: draft.path, to: dest });
      } else if (mapped(draft)) outcome.keptInPlace.push(draft.path);
    });
  }
}

const blank = (renames: PathMove[] = []): CatchUpOutcome => ({
  plain: false,
  renames,
  moved: [],
  carried: [],
  conflicted: [],
  keptInPlace: [],
  stranded: [],
  strandedWhy: {},
  ignoredMoved: [],
});

/**
 * Catch the box up with its upstream, carrying the owner's drafts across
 * any folder rename (see the module doc). Called when the pull stood back
 * ({@link PULL_RENAMED}); the fetch has happened. Null when another
 * catch-up of this box is under way.
 */
export async function catchUpAcrossRenames(
  ctx: SandboxExecContext,
  root: string,
): Promise<CatchUpOutcome | null> {
  const box = shellIn(ctx, root);
  // One catch-up per box at a time (two tabs, two API instances): exit 4
  // when another holds the lock. Exit 3: the lock is ours, but a merge,
  // rebase or cherry-pick of the person's own is under way — git's own
  // refusal is the answer then, as before. A lock taken over from a
  // catch-up that died mid-way (an API restart) prints the branch its
  // drafts are on, if it left them there.
  const claim = await box.sh(
    [
      `lock=${gitPath(LOCK)}`,
      `if [ -d "$lock" ]; then ${FRESH} && exit 4; died=1; fi`,
      `rmdir "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null || exit 4`,
      `[ -n "$died" ] && [ -e ${gitPath(`${SCRATCH}.saved`)} ] && git for-each-ref --sort=-refname --count=1 --format='%(refname:short)' refs/heads/mako-drafts/`,
      `for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do [ -e "$(git rev-parse --git-path "$f")" ] && exit 3; done`,
      `exit 0`,
    ].join("\n"),
  );
  if (claim.exitCode === 4) return null;
  if (claim.exitCode !== 0 && claim.exitCode !== 3) {
    throw new Error(`claim: ${(claim.stderr || claim.stdout).trim()}`);
  }
  const orphan = claim.stdout.trim();
  const told = (outcome: CatchUpOutcome) => {
    if (!orphan) return outcome;
    outcome.draftsBranch ??= orphan;
    outcome.message = [
      `An earlier catch-up of your sandbox was interrupted. The uncommitted changes you had then are saved on the branch ${orphan}, at the paths they had: in the terminal, \`git checkout ${orphan} -- <path>\` restores one.`,
      ...(outcome.message ? [outcome.message] : []),
    ].join(" ");
    return outcome;
  };
  try {
    const [head, upstream, gitDir] = lines(
      await box.out("git rev-parse HEAD '@{u}' --absolute-git-dir"),
    );
    const renames = await goneFolders(box, head, upstream);
    const status = parsePorcelainZ(
      await box.out("git status --porcelain=v1 -z --untracked-files=all"),
    );
    const outcome = blank(renames);
    const plain = async () => {
      outcome.plain = true;
      const merged = await box.sh("git merge --no-edit '@{u}'");
      if (merged.exitCode !== 0) {
        outcome.failed = "merge";
        outcome.said = (merged.stderr || merged.stdout).trim();
        return outcome;
      }
      outcome.ignoredMoved = await moveIgnoredLeftovers(box, renames);
      return outcome;
    };
    // Drafts no rename touched, or a conflict left unresolved in the
    // index: the plain merge, exactly as before.
    const unmerged = (e: StatusEntry) =>
      e.x === "U" || e.y === "U" || (e.x === e.y && "AD".includes(e.x));
    if (
      claim.exitCode !== 0 ||
      status.some(unmerged) ||
      !status.some(e => inRenamed(e, renames))
    ) {
      return told(await plain());
    }

    const scratch = `${gitDir}/${SCRATCH}`;
    // The person's index as it is: what is staged stays staged if the
    // catch-up has to be undone.
    const savedIndex = `${scratch}.saved`;
    let snapshot: Snapshot;
    try {
      snapshot = await takeSnapshot(box, head, scratch, savedIndex);
    } catch (error) {
      // Nothing has been touched: the plain merge.
      outcome.said = said(error);
      return told(await plain());
    }
    return told(
      await carry(box, { head, renames, status, savedIndex }, snapshot),
    );
  } finally {
    await box
      .sh(
        `rm -f ${gitPath(SCRATCH)} ${gitPath(`${SCRATCH}.saved`)}; rmdir ${gitPath(LOCK)}`,
      )
      .catch(() => undefined);
  }
}

interface Snapshot {
  /** The commit holding every draft; `branch` points at it. */
  all: string;
  branch: string;
  /** The tracked drafts alone, as a commit on the old HEAD; null if none. */
  tracked: string | null;
  untracked: UntrackedDraft[];
  /** Untracked entries git could not snapshot (a repository with no commit). */
  unsaved: string[];
}

/** Step 1. Reads the working copy; changes nothing but a scratch index. */
async function takeSnapshot(
  box: Box,
  head: string,
  scratch: string,
  savedIndex: string,
): Promise<Snapshot> {
  const scratchIndex = `export GIT_INDEX_FILE=${q(scratch)}`;
  // `add -u` on a copy of the person's index: tracked edits, deletions and
  // staged new files. Then `add -A`: untracked files too. --ignore-errors,
  // because an entry git cannot add (a nested repository with no commit)
  // must not stop the rest from being saved.
  const [trackedTree, allTree] = lines(
    await box.out(
      [
        `cp -p ${gitPath("index")} ${q(savedIndex)}`,
        `cp -p ${q(savedIndex)} ${q(scratch)}`,
        scratchIndex,
        `git add -u`,
        `git write-tree`,
        `{ git add -A --ignore-errors >/dev/null 2>&1; true; }`,
        `git write-tree`,
      ].join(" && "),
    ),
  );
  // What the snapshot does not hold. An untracked leftover is left where
  // it is and named; a tracked one means the snapshot is not faithful.
  const left = parsePorcelainZ(
    await box.out(
      `${scratchIndex} && git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`,
    ),
  );
  if (left.some(e => e.x !== "?" && e.y !== " ")) {
    throw new Error("the snapshot would not hold every tracked change");
  }
  // The untracked drafts are what `all` has and the tracked drafts do not.
  const fields = (
    await box.out(`git diff-tree -r -z --no-renames ${trackedTree} ${allTree}`)
  ).split("\0");
  const untracked: UntrackedDraft[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , oid, kind] = fields[i].split(" ");
    if (kind !== "A") throw new Error("the snapshot is not only additions");
    untracked.push({ path: fields[i + 1], mode, oid });
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const branch = `mako-drafts/${stamp}`;
  const [headTree, all, tracked] = lines(
    await box.out(
      [
        `git rev-parse ${head}^{tree}`,
        `all=$(git commit-tree ${allTree} -p ${head} -m 'Uncommitted changes, saved before catching up with main')`,
        `echo "$all"`,
        `git commit-tree ${trackedTree} -p ${head} -m 'Uncommitted changes to tracked files'`,
        // Last, and never over an existing branch.
        `git update-ref refs/heads/${branch} "$all" ''`,
      ].join(" && "),
    ),
  );
  return {
    all,
    branch,
    tracked: trackedTree === headTree ? null : tracked,
    untracked,
    unsaved: left.filter(e => e.x === "?").map(e => e.path.replace(/\/+$/, "")),
  };
}

/** Steps 2–6. */
async function carry(
  box: Box,
  was: {
    head: string;
    renames: PathMove[];
    status: StatusEntry[];
    savedIndex: string;
  },
  snapshot: Snapshot,
): Promise<CatchUpOutcome> {
  const { head, renames } = was;
  const outcome = blank(renames);
  outcome.draftsBranch = snapshot.branch;
  const done = () => {
    outcome.message = describe(outcome);
    return outcome;
  };
  /** Back to exactly where the person was: every file, and the index. */
  const restore = async () => {
    await box.sh("git merge --abort");
    await box.out(
      [
        `git read-tree --reset -u ${snapshot.all}`,
        `cp -p ${q(was.savedIndex)} ${gitPath("index")}`,
        `{ git update-index -q --refresh; true; }`,
        `git rev-parse HEAD '@{u}' | tr '\\n' ' ' > ${gitPath(REFUSED)}`,
      ].join(" && "),
    );
  };
  let caughtUp = false;
  try {
    // 2. A clean tree: only what the snapshot holds is removed (HEAD and
    // the branch never move), then main merged as into any clean checkout.
    await box.out(
      `git read-tree ${snapshot.all} && git read-tree --reset -u ${head} && { git update-index -q --refresh; true; }`,
    );
    const merged = await box.sh("git merge --no-edit '@{u}'");
    if (merged.exitCode !== 0) {
      outcome.said = (merged.stderr || merged.stdout).trim();
      outcome.mergeConflicts = nul(
        await box.out("git diff --name-only -z --diff-filter=U"),
      );
      await restore();
      outcome.failed = "merge";
      return done();
    }
    caughtUp = true;
    const target = (await box.out("git rev-parse HEAD")).trim();

    // 3. The tracked drafts, through the rename.
    if (snapshot.tracked) {
      const picked = await box.sh(
        `git -c merge.directoryRenames=true -c merge.renames=true cherry-pick --no-commit ${snapshot.tracked}`,
      );
      // 0 applied, 1 applied with conflicts; anything else applied nothing.
      if (picked.exitCode > 1) {
        throw new Error(
          `cherry-pick: ${(picked.stderr || picked.stdout).trim()}`,
        );
      }
      const unmerged =
        picked.exitCode === 0
          ? []
          : nul(await box.out("git diff --name-only -z --diff-filter=U"));
      if (unmerged.length > 0) {
        // Main's version, or none: never conflict markers in their file.
        const inMain = new Set(
          nul(
            await box.out(
              `git --literal-pathspecs ls-tree -r -z --name-only ${target} -- ${unmerged.map(q).join(" ")}`,
            ),
          ),
        );
        const git = (verb: string, paths: string[]) =>
          paths.length === 0
            ? []
            : [`git --literal-pathspecs ${verb} -- ${paths.map(q).join(" ")}`];
        await box.out(
          [
            ...git(
              `checkout ${target}`,
              unmerged.filter(p => inMain.has(p)),
            ),
            ...git(
              "rm -q -f",
              unmerged.filter(p => !inMain.has(p)),
            ),
          ].join(" && "),
        );
        // git names them under the NEW folder; the person knows the old.
        const back = renames.map(r => ({ from: r.to, to: r.from }));
        outcome.conflicted = unmerged.map(p => mapThroughRenames(p, back) ?? p);
      }
      await box.sh("git cherry-pick --quit");
      outcome.carried = was.status
        .filter(e => e.x !== "?" && !outcome.conflicted.includes(e.path))
        .map(e => e.path);
    }
    // Everything comes back unstaged.
    await box.out("git reset -q");

    // 4. The untracked drafts.
    for (const p of snapshot.unsaved) {
      outcome.stranded.push(p);
      outcome.strandedWhy[p] = "unsupported";
    }
    await placeUntracked(box, snapshot.untracked, renames, outcome);

    // 5. What git never tracks follows the folder too.
    outcome.ignoredMoved = await moveIgnoredLeftovers(box, renames);

    // 6. Faithfully carried: nothing to keep a branch for.
    if (outcome.conflicted.length + outcome.stranded.length === 0) {
      await box.sh(`git update-ref -d refs/heads/${snapshot.branch}`);
      delete outcome.draftsBranch;
    }
    return done();
  } catch (error) {
    outcome.said = said(error);
    const restored =
      !caughtUp &&
      (await restore().then(
        () => true,
        () => false,
      ));
    if (!restored) await box.sh("git cherry-pick --quit; git reset -q");
    outcome.failed = restored ? "merge" : "interrupted";
    return done();
  }
}

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const moves = (renames: ReadonlyArray<PathMove>) =>
  renames.map(r => `${r.from} → ${r.to}`).join(", ");

function describe(o: CatchUpOutcome): string | undefined {
  const b = o.draftsBranch;
  if (o.failed === "merge") {
    const why = o.mergeConflicts?.length
      ? `commits made in the sandbox conflict with main in ${o.mergeConflicts.join(", ")}`
      : "main could not be merged";
    return `Your sandbox could not catch up with main, which renamed ${moves(o.renames)}: ${why}. Nothing in the sandbox was changed, and your uncommitted changes are also saved on the branch ${b}. To catch up, run \`git merge\` in the terminal and resolve it there.`;
  }
  if (o.failed === "interrupted") {
    return `Carrying your uncommitted changes across a rename on main (${moves(o.renames)}) was interrupted. All of them are saved on the branch ${b}, at the paths they had: in the terminal, \`git checkout ${b} -- <path>\` restores one.`;
  }
  const parts: string[] = [];
  const followed = o.carried.length + o.moved.length;
  if (followed > 0) {
    parts.push(
      `Main renamed ${moves(o.renames)}; your ${count(followed, "uncommitted change", "uncommitted changes")} followed it.`,
    );
  }
  if (o.keptInPlace.length > 0) {
    parts.push(
      `${o.keptInPlace.join(", ")} stayed where ${o.keptInPlace.length === 1 ? "it was" : "they were"}: a file with that name already exists in the renamed folder.`,
    );
  }
  const reason: Record<StrandedReason, string> = {
    taken:
      "a file with that name exists both in the renamed folder and where it was",
    "escaping-link":
      "a symbolic link pointing outside the repository, not recreated",
    "linked-folder":
      "a folder on its way is a symbolic link, which Mako does not write through",
    unsupported: "a nested repository, left where it was",
    "write-failed": "it could not be written",
  };
  const notCarried = [
    ...o.conflicted.map(p => `${p} (main changed it too)`),
    ...o.stranded.map(p => `${p} (${reason[o.strandedWhy[p]]})`),
  ];
  if (notCarried.length > 0) {
    parts.push(
      `Not carried over: ${notCarried.join(", ")}. Your versions are saved on the branch ${b} — in the terminal, \`git show ${b}:<path>\` prints one and \`git checkout ${b} -- <path>\` restores it.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * A box on a DETACHED HEAD (a `git checkout <sha>` in the terminal) follows
 * no branch: it is never caught up and never touched, as before. What is
 * new is the person hearing about it when it matters — main renamed a
 * folder their uncommitted work sits in. Null when nothing of theirs is
 * affected. Called when the pull stood back with {@link PULL_DETACHED}.
 */
export async function detachedOutcome(
  ctx: SandboxExecContext,
  root: string,
  defaultBranch: string,
): Promise<CatchUpOutcome | null> {
  const box = shellIn(ctx, root);
  const [head, main] = lines(
    await box.out(`git rev-parse HEAD refs/remotes/origin/${defaultBranch}`),
  );
  const status = parsePorcelainZ(
    await box.out("git status --porcelain=v1 -z --untracked-files=all"),
  );
  if (status.length === 0) return null;
  const renames = await goneFolders(box, head, main);
  const n = status.filter(e => inRenamed(e, renames)).length;
  if (n === 0) return null;
  const them = n === 1 ? "it" : "them";
  return {
    ...blank(renames),
    plain: true,
    failed: "detached",
    message: `Your sandbox is on a detached commit, not a branch, so it was not caught up with ${defaultBranch} — which renamed ${moves(renames)}. Your ${count(n, "uncommitted change", "uncommitted changes")} there ${n === 1 ? "is" : "are"} untouched, still at the old path. To bring ${them} along, check out a branch again (\`git checkout ${defaultBranch}\`, or the branch you were on): the next catch-up carries ${them} across the rename.`,
  };
}
