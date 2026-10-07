/**
 * A sandbox catching up with main while its owner has uncommitted work —
 * and main RENAMED the folder that work sits in.
 *
 * A rename (an app's, a folder's) moves every file of the app. The plain
 * catch-up (`git merge @{u}`, boxPull) then does one of two bad things:
 *
 *  - an uncommitted EDIT to any file of the renamed app makes git refuse
 *    ("your local changes would be overwritten"): the sandbox never catches
 *    up, and the app it shows is the one from before the rename;
 *  - an uncommitted NEW file in the old folder is left there: the renamed
 *    app does not have it, and a later commit lands it in a stray folder.
 *
 * git's own `merge --autostash` follows the rename for edits but, when one
 * conflicts, writes conflict markers INTO the user's file and still exits 0
 * (measured: app-rename-sandbox.scenarios.test.ts). So the drafts are
 * carried here, and the rule is: the sandbox ends caught up and clean of
 * conflict markers, every draft either follows the rename or is kept where
 * it was, and anything that cannot be carried is saved on a branch — and
 * the person is told, over the sandbox's own status channel.
 *
 *  1. Every draft (tracked edits, staged files, untracked new files) is
 *     snapshotted as a commit on `mako-drafts/<time>` first. Nothing below
 *     can lose what that branch holds.
 *  2. The tracked drafts become one commit on the old HEAD; the box resets
 *     to that HEAD and merges main as a clean tree would.
 *  3. The tracked drafts are cherry-picked onto the result WITHOUT
 *     committing, with git's rename and directory-rename detection: an edit
 *     to apps/a/x lands on apps/b/x. A file that conflicts is reset to
 *     main's version (its draft stays on the branch) — never markers.
 *  4. Untracked files go back where the rename put their folder, unless a
 *     file is already there: then at their old path, unless that is taken
 *     too — then only on the branch.
 *  5. All changes come back unstaged. If everything was carried, the
 *     branch is deleted again; otherwise it stays and the message names it.
 *
 * Drafts no rename touched take the plain path, exactly as before.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";

/** What a catch-up did with the drafts (for the message, and for tests). */
export interface CatchUpOutcome {
  /** The plain merge ran (no draft was in a renamed folder), as before. */
  plain: boolean;
  /** Untracked files that followed their folder: from → to. */
  moved: Array<{ from: string; to: string }>;
  /** Tracked edits carried onto main (paths before the catch-up). */
  carried: string[];
  /** Tracked drafts that conflicted: main's version kept, draft on the branch. */
  conflicted: string[];
  /** Untracked drafts left at their old path: the new one is taken. */
  keptInPlace: string[];
  /** Untracked drafts on the branch only: both paths are taken. */
  stranded: string[];
  /** The branch holding every draft, when anything could not be carried. */
  draftsBranch?: string;
  /** The catch-up could not happen (its own merge failed); drafts restored. */
  failed?: string;
  /** The folder renames on main the drafts sat in. */
  renames?: Array<{ from: string; to: string }>;
  /** Ignored leftovers (node_modules, dist…) moved along: from → to. */
  ignoredMoved?: Array<{ from: string; to: string }>;
  /** What to tell the person, when anything beyond "caught up" happened. */
  message?: string;
}

const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Rename map between two commits: old folder → new folder (folders only). */
export function folderRenames(
  nameStatusZ: string,
): Array<{ from: string; to: string }> {
  const fields = nameStatusZ.split("\0");
  const out = new Map<string, string>();
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (/^[RC]\d*$/.test(status)) {
      const from = fields[i + 1] ?? "";
      const to = fields[i + 2] ?? "";
      i += 2;
      if (!status.startsWith("R")) continue;
      const a = from.split("/");
      const b = to.split("/");
      // Strip the shared tail (the file name and the folders under the moved
      // one): what is left on each side is the folder that moved.
      while (
        a.length > 1 &&
        b.length > 1 &&
        a[a.length - 1] === b[b.length - 1]
      ) {
        a.pop();
        b.pop();
      }
      // Only a folder move: the file's own name must have been shared.
      if (a.length === from.split("/").length) continue;
      const oldDir = a.join("/");
      const newDir = b.join("/");
      if (oldDir && newDir && oldDir !== newDir && !out.has(oldDir)) {
        out.set(oldDir, newDir);
      }
    } else {
      i += 1;
    }
  }
  return [...out].map(([from, to]) => ({ from, to }));
}

/** `p` mapped through the deepest folder move that contains it. */
export function mapThroughRenames(
  p: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): string | null {
  let best: { from: string; to: string } | null = null;
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

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  from?: string;
}

/** `git status --porcelain=v1 -z` → entries. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || f.length < 4) continue;
    const entry: StatusEntry = { x: f[0], y: f[1], path: f.slice(3) };
    if (entry.x === "R" || entry.x === "C") entry.from = fields[++i];
    entries.push(entry);
  }
  return entries;
}

type GitOut = (...args: string[]) => Promise<string>;

/**
 * Folders main renamed since the box's HEAD forked from `upstream`: old →
 * new. Only folders that are GONE upstream count: a file merely moved out
 * of a folder that stays is not a folder rename.
 */
async function goneFolders(
  out: GitOut,
  upstream: string,
): Promise<Array<{ from: string; to: string }>> {
  const base = (await out("merge-base", "HEAD", upstream)).trim();
  const renames = folderRenames(
    await out("diff", "-M", "--name-status", "-z", base, upstream),
  );
  const gone: Array<{ from: string; to: string }> = [];
  for (const r of renames) {
    const there = await out("ls-tree", "--name-only", upstream, "--", r.from);
    if (!there.trim()) gone.push(r);
  }
  return gone;
}

const draftInRenamed = (
  e: StatusEntry,
  gone: ReadonlyArray<{ from: string; to: string }>,
) => [e.path, e.from].some(p => p && mapThroughRenames(p, gone));

/**
 * A box on a DETACHED HEAD (a `git checkout <sha>` in the terminal) has no
 * branch, so it follows nothing: it is never caught up, and its working
 * copy is never touched — exactly as before. What is new is the person
 * hearing about it when it matters: main renamed a folder their
 * uncommitted work sits in, so the work will not follow on its own. Null
 * when the box is not detached, or nothing of theirs is affected.
 */
export async function detachedDraftsNotice(
  ctx: SandboxExecContext,
  root: string,
  defaultBranch: string,
): Promise<{
  message: string;
  renames: Array<{ from: string; to: string }>;
} | null> {
  const provider = getSandboxProvider();
  const git = (...args: string[]) =>
    provider.exec(ctx, ["git", "-C", sh(root), ...args.map(sh)].join(" "), {
      timeoutMs: 60_000,
    });
  const out: GitOut = async (...args) => {
    const r = await git(...args);
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim());
    return r.stdout;
  };
  if ((await git("symbolic-ref", "-q", "HEAD")).exitCode === 0) return null;
  const upstream = `refs/remotes/origin/${defaultBranch}`;
  if ((await git("rev-parse", "--verify", "-q", upstream)).exitCode !== 0) {
    return null;
  }
  if (
    (await git("merge-base", "--is-ancestor", upstream, "HEAD")).exitCode === 0
  ) {
    return null;
  }
  const status = parsePorcelainZ(
    await out("status", "--porcelain=v1", "-z", "--untracked-files=all"),
  );
  if (status.length === 0) return null;
  const gone = await goneFolders(out, upstream);
  const affected = status.filter(e => draftInRenamed(e, gone));
  if (affected.length === 0) return null;
  const moves = gone.map(r => `${r.from} → ${r.to}`).join(", ");
  return {
    renames: gone,
    message: `Your sandbox is on a detached commit, not a branch, so it was not caught up with ${defaultBranch} — which renamed ${moves}. Your ${affected.length} uncommitted change${affected.length === 1 ? "" : "s"} there ${affected.length === 1 ? "is" : "are"} untouched, still at the old path. To bring ${affected.length === 1 ? "it" : "them"} along, check out a branch again (\`git checkout ${defaultBranch}\`, or the branch you were on): the next catch-up carries ${affected.length === 1 ? "it" : "them"} across the rename. If git refuses, nothing is changed.`,
  };
}

type Exec = (
  command: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * What git never tracks — node_modules, dist, caches — stays in a folder
 * main renamed: git moves only what it tracks. Moved along when the folder
 * only changed its name (same depth, so relative links inside
 * node_modules still hold) and the new folder has none of it yet: the
 * app's dev server boots without a reinstall, and no ignored-only husk of
 * the old app is left behind. Anything else stays where it is (the next
 * dev boot installs afresh); nothing is ever deleted.
 */
async function moveIgnoredLeftovers(
  exec: Exec,
  root: string,
  gone: ReadonlyArray<{ from: string; to: string }>,
): Promise<Array<{ from: string; to: string }>> {
  const moved: Array<{ from: string; to: string }> = [];
  for (const r of gone) {
    if (r.from.split("/").length !== r.to.split("/").length) continue;
    // Only a folder holding nothing git sees (ignored files alone) moves.
    const listed = await exec(
      `cd ${sh(root)} && [ -d ${sh(r.from)} ] && git ls-files -z --cached --others --exclude-standard -- ${sh(r.from)} | head -c 1 | wc -c`,
    );
    if (listed.exitCode !== 0 || listed.stdout.trim() !== "0") continue;
    const entries = await exec(`cd ${sh(`${root}/${r.from}`)} && ls -A1`);
    for (const name of entries.stdout.split("\n").filter(Boolean)) {
      const src = `${r.from}/${name}`;
      const dst = `${r.to}/${name}`;
      const done = await exec(
        `cd ${sh(root)} && [ -d ${sh(r.to)} ] && [ ! -e ${sh(dst)} ] && [ ! -L ${sh(dst)} ] && mv ${sh(src)} ${sh(dst)}`,
      );
      if (done.exitCode === 0) moved.push({ from: src, to: dst });
    }
    // The husk, if nothing is left in it — never a recursive delete.
    await exec(`cd ${sh(root)} && rmdir ${sh(r.from)} 2>/dev/null; true`);
  }
  return moved;
}

/**
 * Catch the box up with its upstream, carrying the owner's drafts across
 * any folder rename (see the module doc). Assumes the fetch has happened.
 */
export async function catchUpCarryingDrafts(
  ctx: SandboxExecContext,
  root: string,
): Promise<CatchUpOutcome> {
  const provider = getSandboxProvider();
  const exec = (command: string) =>
    provider.exec(ctx, command, { timeoutMs: 180_000 });
  const git = (...args: string[]) =>
    exec(["git", "-C", sh(root), ...args.map(sh)].join(" "));
  const out = async (...args: string[]) => {
    const r = await git(...args);
    if (r.exitCode !== 0) {
      throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout;
  };
  const outcome: CatchUpOutcome = {
    plain: false,
    moved: [],
    carried: [],
    conflicted: [],
    keptInPlace: [],
    stranded: [],
  };

  const gone = await goneFolders(out, "@{u}");
  const plainMerge = async () => {
    outcome.plain = true;
    const r = await git("merge", "--no-edit", "@{u}");
    if (r.exitCode !== 0) {
      outcome.failed = (r.stderr || r.stdout).trim();
      return outcome;
    }
    outcome.ignoredMoved = await moveIgnoredLeftovers(exec, root, gone);
    return outcome;
  };

  const status = parsePorcelainZ(
    await out("status", "--porcelain=v1", "-z", "--untracked-files=all"),
  );
  if (status.length === 0) return plainMerge();
  if (!status.some(e => draftInRenamed(e, gone))) return plainMerge();

  const head = (await out("rev-parse", "HEAD")).trim();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const draftsBranch = `mako-drafts/${stamp}`;
  const gitPath = (
    await out("rev-parse", "--git-path", "mako-drafts-index")
  ).trim();
  const tmpIndex = gitPath.startsWith("/") ? gitPath : `${root}/${gitPath}`;
  const must = async (
    r: { exitCode: number; stdout: string; stderr: string },
    what: string,
  ) => {
    if (r.exitCode !== 0) {
      throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout.trim();
  };
  // The person's index as it is — what is staged stays staged if the
  // catch-up has to be undone (restoreOriginal).
  const indexAt = (await out("rev-parse", "--git-path", "index")).trim();
  const index = indexAt.startsWith("/") ? indexAt : `${root}/${indexAt}`;
  const indexBackup = `${tmpIndex}.original`;
  await must(
    await exec(`cp -p ${sh(index)} ${sh(indexBackup)}`),
    "saving the index",
  );
  const withIndex = (...args: string[]) =>
    exec(
      `GIT_INDEX_FILE=${sh(tmpIndex)} git -C ${sh(root)} ${args.map(sh).join(" ")}`,
    );
  const commitTree = async (tree: string, message: string) =>
    must(
      await git("commit-tree", tree, "-p", head, "-m", message),
      "commit-tree",
    );

  // 1. Everything, untracked included (.gitignore respected), on a branch.
  await must(await withIndex("read-tree", head), "read-tree");
  await must(await withIndex("add", "-A"), "add");
  const all = await commitTree(
    await must(await withIndex("write-tree"), "write-tree"),
    "Uncommitted changes, saved while catching up with main",
  );
  await out("update-ref", `refs/heads/${draftsBranch}`, all);

  // 2. The tracked drafts alone (edits, deletions, staged new files).
  const untracked = status.filter(e => e.x === "?").map(e => e.path);
  const staged = status
    .filter(e => e.x === "A" || e.x === "R" || e.x === "C")
    .map(e => e.path);
  await must(await withIndex("read-tree", head), "read-tree");
  await must(await withIndex("add", "-u"), "add -u");
  if (staged.length > 0) {
    await must(await withIndex("add", "--", ...staged), "add staged");
  }
  const trackedTree = await must(await withIndex("write-tree"), "write-tree");
  await exec(`rm -f ${sh(tmpIndex)}`);
  const headTree = (await out("rev-parse", `${head}^{tree}`)).trim();
  const drafts =
    trackedTree === headTree ? null : await commitTree(trackedTree, "drafts");
  const draftPaths = status.filter(e => e.x !== "?").map(e => e.path);

  const restoreOriginal = async (reason: string) => {
    // Back to exactly where the person was, byte for byte: HEAD, every
    // file (untracked ones included — they are in `all`), and the index as
    // it was (what was staged stays staged; untracked stays untracked).
    await git("merge", "--abort");
    await git("reset", "-q", "--hard", all);
    await git("reset", "-q", head);
    await must(
      await exec(`cp -p ${sh(indexBackup)} ${sh(index)}`),
      "restoring the index",
    );
    await git("update-index", "-q", "--refresh");
    await exec(`rm -f ${sh(indexBackup)}`);
    outcome.failed = reason;
    outcome.draftsBranch = draftsBranch;
    outcome.renames = gone;
    outcome.message = describe(outcome, gone);
    return outcome;
  };

  // 3. A clean tree, merged with main as any clean checkout would be.
  for (const p of untracked) await exec(`rm -f -- ${sh(`${root}/${p}`)}`);
  await out("reset", "-q", "--hard", head);
  const merged = await git("merge", "--no-edit", "@{u}");
  if (merged.exitCode !== 0) {
    return restoreOriginal((merged.stderr || merged.stdout).trim());
  }
  const target = (await out("rev-parse", "HEAD")).trim();

  // 4. The tracked drafts, through the rename.
  if (drafts) {
    const picked = await git(
      "-c",
      "merge.directoryRenames=true",
      "-c",
      "merge.renames=true",
      "cherry-pick",
      "--no-commit",
      drafts,
    );
    if (picked.exitCode !== 0) {
      const unmerged = (
        await out("diff", "--name-only", "-z", "--diff-filter=U")
      )
        .split("\0")
        .filter(Boolean);
      for (const p of unmerged) {
        // Main's version, or none: never conflict markers in their file.
        const inTarget = await git("cat-file", "-e", `${target}:${p}`);
        if (inTarget.exitCode === 0) {
          await out("checkout", target, "--", p);
        } else {
          await git("rm", "-q", "-f", "--", p);
        }
      }
      // Paths git reports under the NEW name map back to the drafts' names.
      const back = new Map(gone.map(r => [r.to, r.from]));
      outcome.conflicted = unmerged.map(p => {
        for (const [to, from] of back) {
          if (p.startsWith(`${to}/`)) return `${from}${p.slice(to.length)}`;
        }
        return p;
      });
      await git("cherry-pick", "--quit");
    }
    outcome.carried = draftPaths.filter(p => !outcome.conflicted.includes(p));
  }
  await git("reset", "-q");

  // 5. The untracked files: where their folder went, else where they were.
  const exists = async (p: string) =>
    (
      await exec(
        `test -e ${sh(`${root}/${p}`)} || test -L ${sh(`${root}/${p}`)}`,
      )
    ).exitCode === 0;
  for (const p of untracked) {
    const mapped = mapThroughRenames(p, gone);
    let dest: string | null = null;
    if (mapped && !(await exists(mapped))) dest = mapped;
    else if (!(await exists(p))) dest = p;
    if (!dest) {
      outcome.stranded.push(p);
      continue;
    }
    const abs = `${root}/${dest}`;
    const mode = (await out("ls-tree", all, "--", p)).split(/\s+/)[0];
    const wrote = await exec(
      `mkdir -p ${sh(abs.slice(0, abs.lastIndexOf("/")))} && git -C ${sh(root)} cat-file blob ${sh(`${all}:${p}`)} > ${sh(abs)}${mode === "100755" ? ` && chmod +x ${sh(abs)}` : ""}`,
    );
    if (wrote.exitCode !== 0) {
      outcome.stranded.push(p);
      continue;
    }
    if (dest !== p) outcome.moved.push({ from: p, to: dest });
    else if (mapped) outcome.keptInPlace.push(p);
  }

  // 6. What git never tracks follows the folder too (moveIgnoredLeftovers).
  outcome.ignoredMoved = await moveIgnoredLeftovers(exec, root, gone);
  await exec(`rm -f ${sh(indexBackup)}`);

  const lost = outcome.conflicted.length + outcome.stranded.length;
  if (lost === 0) {
    await git("branch", "-D", draftsBranch);
  } else {
    outcome.draftsBranch = draftsBranch;
  }
  outcome.renames = gone;
  outcome.message = describe(outcome, gone);
  return outcome;
}

function describe(
  o: CatchUpOutcome,
  renames: ReadonlyArray<{ from: string; to: string }>,
): string | undefined {
  const moves = renames.map(r => `${r.from} → ${r.to}`).join(", ");
  const parts: string[] = [];
  if (o.failed) {
    return `Your sandbox could not catch up with main (${moves}): ${o.failed.split("\n")[0]}. Your uncommitted changes are untouched, and also saved on the branch ${o.draftsBranch}.`;
  }
  const followed = o.carried.length + o.moved.length;
  if (followed > 0) {
    parts.push(
      `Main renamed ${moves}; your ${followed} uncommitted change${followed === 1 ? "" : "s"} followed it.`,
    );
  }
  if (o.keptInPlace.length > 0) {
    parts.push(
      `${o.keptInPlace.join(", ")} stayed where ${o.keptInPlace.length === 1 ? "it was" : "they were"}: a file with that name already exists in the renamed folder.`,
    );
  }
  if (o.conflicted.length + o.stranded.length > 0) {
    const paths = [...o.conflicted, ...o.stranded].join(", ");
    parts.push(
      `Not carried over (they conflict with main, which now has its own version): ${paths}. Your versions are saved on the branch ${o.draftsBranch} — in the terminal, \`git show ${o.draftsBranch}:<path>\` prints one, \`git checkout ${o.draftsBranch} -- <path>\` restores it.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
