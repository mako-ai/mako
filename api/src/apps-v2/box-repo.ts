/**
 * The sandbox holds the working copy; the bare repo holds the history.
 *
 * There used to be three copies of every app: the bare repo, a working tree on
 * the API host, and the sandbox's own tree — with the last two reconciled by
 * tarring the whole directory back and forth around every command. That is
 * where most of this subsystem's bugs came from. Files edited in the terminal
 * were destroyed by the next sync; `git checkout` inside the sandbox was
 * silently reverted, because the sync deleted `.git` too; and the three copies
 * could disagree about which branch you were even on.
 *
 * So there is one working copy now, and it is the sandbox — the same
 * arrangement as a laptop: your machine holds the work, the remote holds the
 * history, and nobody keeps a third copy in between and rsyncs it. Reads still
 * come from the bare repo, which is not a second state but the same state
 * committed, and is what lets the file tree work while the sandbox is asleep.
 *
 * COMMITS MOVE AS GIT BUNDLES. A bundle is git's own offline transfer format,
 * so this needs no network path between the two and — the point — no
 * credential inside the sandbox. Tenant code and arbitrary npm dependencies
 * run in there; handing it a token that can write the workspace repo would
 * hand them one too. The sandbox writes a file, the API reads it. Bundles are
 * incremental (`--not <base>`), so the return trip is the new objects only.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git";
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import { promisify } from "node:util";
import { loggers } from "../logging";

const execFileAsync = promisify(execFile);

const logger = loggers.api("apps-v2-box-repo");

/**
 * Where the working tree lives, asked of the provider rather than assumed.
 *
 * A microVM has a fixed path; a local sandbox is a directory on this machine.
 * Hardcoding one provider's layout would make this module silently wrong under
 * the other.
 */
export function boxRoot(ctx: SandboxExecContext): string {
  return getSandboxProvider().root(ctx);
}

/** Scratch paths for bundles. Outside the tree, so they never get committed. */
function scratch(ctx: SandboxExecContext, name: string): string {
  return `${getSandboxProvider().scratch(ctx)}/${name}`;
}

/**
 * Directories that must never be committed, whatever the app's own .gitignore
 * says.
 *
 * The snapshot is taken with `git add -A` at the repository root, so anything
 * not ignored is staged. A scaffolded app ignores these itself, but an
 * imported repository need not — and one `npm install` later, a flush would
 * try to commit a hundred thousand files. Installed as the sandbox repo's
 * `core.excludesFile`, so the guarantee does not depend on the app.
 */
export const NEVER_COMMIT = [
  "node_modules",
  ".npm",
  ".cache",
  ".vite",
  ".pnpm-store",
  "dist",
];

/** Ref the sandbox parks an outgoing snapshot on so a bundle can name it. */
const BOX_WIP_REF = "refs/mako/wip";

/** Enough for a big install; a bundle of an app repo is far smaller. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * POSIX-quote a value for interpolation into a shell command.
 *
 * git allows `;`, `$`, backticks, `&` and `|` in branch names, and this module
 * builds shell strings — so an entirely legal branch created in the terminal
 * would otherwise be pasted straight into one. Everything interpolated goes
 * through here, so any name git accepts works and none of them mean anything
 * to the shell.
 */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function boxGit(ctx: SandboxExecContext, ...args: string[]): string {
  return ["git", "-C", sh(boxRoot(ctx)), ...args.map(sh)].join(" ");
}

async function run(
  ctx: SandboxExecContext,
  command: string,
  what: string,
): Promise<string> {
  const result = await getSandboxProvider().exec(ctx, command, {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed in the sandbox: ${(result.stderr || result.stdout).slice(-800)}`,
    );
  }
  return result.stdout.trim();
}

/** Whether the sandbox already holds a usable checkout. */
export async function boxHasRepo(ctx: SandboxExecContext): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    `${boxGit(ctx, "rev-parse", "--git-dir")} >/dev/null 2>&1 && echo yes || echo no`,
    { timeoutMs: 30_000 },
  );
  return result.stdout.trim().endsWith("yes");
}

/**
 * Give a fresh sandbox the repository, at `branch`, plus any uncommitted work.
 *
 * Once per sandbox, not once per command — that difference is the entire point
 * of the change. A sandbox that already has the repo is left alone, so a
 * `git checkout` done in the terminal survives, which it never did before.
 */
export async function hydrateBox(input: {
  ctx: SandboxExecContext;
  repoDir: string;
  branch: string;
  baseSha: string;
  wipOid?: string;
}): Promise<void> {
  const { ctx, repoDir, branch, baseSha, wipOid } = input;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-hydrate-"));
  const bundlePath = path.join(tmp, "hydrate.bundle");
  const hydrateBundle = scratch(ctx, "mako-hydrate.bundle");
  const excludesFile = scratch(ctx, "mako-never-commit");
  try {
    // Carry the WIP commit too, or uncommitted work would be lost the first
    // time a sandbox is rebuilt — which is exactly when it is least excusable.
    const refs = [branch, ...(wipOid ? [wipOid] : [])];
    await runGit(["-C", repoDir, "bundle", "create", bundlePath, ...refs], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const bytes = await fs.readFile(bundlePath);
    await getSandboxProvider().writeFile(
      ctx,
      hydrateBundle,
      new Uint8Array(bytes),
    );

    // init + fetch rather than clone: the directory may already hold
    // node_modules from a warm sandbox, and clone refuses a non-empty target.
    await run(
      ctx,
      [
        `mkdir -p ${sh(boxRoot(ctx))}`,
        boxGit(ctx, "init", "-q"),
        boxGit(ctx, "config", "user.name", "Mako Session"),
        boxGit(ctx, "config", "user.email", "session@mako.ai"),
        // A repo-level backstop for the ignores above, independent of any
        // .gitignore the app happens to ship.
        `printf '%s\\n' ${NEVER_COMMIT.map(n => sh(`${n}/`)).join(" ")} > ${sh(excludesFile)}`,
        boxGit(ctx, "config", "core.excludesFile", excludesFile),
        // Fetch into a namespace, THEN create the branch from it.
        //
        // Fetching straight into `refs/heads/<branch>` fails when that branch
        // is the one checked out — and `git init` leaves HEAD pointing at an
        // unborn `refs/heads/main`, so hydrating a sandbox at `main` (which is
        // what publishing does) hit exactly that: "refusing to fetch into
        // branch 'refs/heads/main' checked out at ...". Every other branch
        // worked, which is why it only ever broke publish.
        `${boxGit(ctx, "fetch", "-q", hydrateBundle, "+refs/heads/*:refs/bundle/*")}`,
        boxGit(ctx, "checkout", "-q", "-B", branch, `refs/bundle/${branch}`),
        `rm -f ${sh(hydrateBundle)}`,
      ].join(" && "),
      "repository hydration",
    );

    if (wipOid) {
      // Restore the uncommitted tree exactly as materializeSession did, so a
      // rebuilt sandbox resumes mid-edit rather than at the last commit.
      await run(
        ctx,
        [
          boxGit(ctx, "reset", "-q", "--hard", baseSha),
          boxGit(ctx, "read-tree", "--reset", "-u", wipOid),
        ].join(" && "),
        "restoring uncommitted work",
      );
    }
    logger.info("Apps v2 sandbox hydrated from the repo", {
      branch,
      baseSha: baseSha.slice(0, 8),
      withWip: Boolean(wipOid),
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export interface BoxTree {
  /** Tree of the sandbox's working directory, staged. */
  treeOid: string;
  /** Branch the sandbox actually has checked out — the authority on this. */
  branch: string;
  /** HEAD the sandbox is on. */
  head: string;
}

/**
 * Stage everything and report the resulting tree.
 *
 * Tree object ids are content addresses, so the one computed in the sandbox is
 * the same id the bare repo would compute. That means "did anything change?"
 * is answered by comparing two strings, and nothing is transferred at all when
 * the answer is no — which is the common case.
 *
 * The branch comes back from the same call because the sandbox is the only
 * thing that knows it: `git checkout` in the terminal is a legitimate way to
 * switch, and everything else follows what the sandbox reports.
 */
export async function boxWorkingTree(
  ctx: SandboxExecContext,
): Promise<BoxTree> {
  const out = await run(
    ctx,
    [
      boxGit(ctx, "add", "-A"),
      boxGit(ctx, "write-tree"),
      boxGit(ctx, "rev-parse", "--abbrev-ref", "HEAD"),
      boxGit(ctx, "rev-parse", "HEAD"),
    ].join(" && "),
    "reading the working tree",
  );
  const [treeOid, branch, head] = out.split("\n").map(l => l.trim());
  if (!treeOid || !branch || !head) {
    throw new Error(
      `Unexpected git output from the sandbox: ${out.slice(-200)}`,
    );
  }
  return { treeOid, branch, head };
}

/**
 * Build a commit in the sandbox for `treeOid` and bring its objects home.
 *
 * `--not <parent>` keeps the bundle to the new objects, so this is proportional
 * to the edit rather than to the repository.
 */
export async function exportTreeAsCommit(input: {
  ctx: SandboxExecContext;
  repoDir: string;
  treeOid: string;
  parent: string;
  message: string;
}): Promise<string> {
  const { ctx, repoDir, treeOid, parent, message } = input;
  const exportBundle = scratch(ctx, "mako-export.bundle");
  // The sandbox can legitimately be missing the parent — a fast-forward that
  // failed, a colleague's commit, a box rebuilt from an older head. Make it
  // present rather than failing with git's "not a valid object", which names
  // neither the cause nor the cure.
  await sendCommitToBox({ ctx, repoDir, commitOid: parent });
  // Two calls rather than one with a shell variable holding the new oid.
  // Everything interpolated into a command is quoted, so a `"$COMMIT"` would
  // be quoted too and arrive as a literal — and the fix is not to carve out an
  // exception to the quoting, it is not to need the variable.
  const commitOid = (
    await run(
      ctx,
      boxGit(ctx, "commit-tree", treeOid, "-p", parent, "-m", message),
      "writing the snapshot commit",
    )
  )
    .split("\n")
    .pop()!
    .trim();
  await run(
    ctx,
    [
      boxGit(ctx, "update-ref", BOX_WIP_REF, commitOid),
      boxGit(
        ctx,
        "bundle",
        "create",
        "-q",
        exportBundle,
        BOX_WIP_REF,
        "--not",
        parent,
      ),
    ].join(" && "),
    "packaging the snapshot",
  );

  const bytes = await getSandboxProvider().readFile(ctx, exportBundle);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-export-"));
  const bundlePath = path.join(tmp, "export.bundle");
  try {
    await fs.writeFile(bundlePath, Buffer.from(bytes));
    // Into a throwaway ref: the caller decides what becomes of the commit, and
    // fetching straight onto a real ref would bypass its CAS.
    await runGit(
      [
        "-C",
        repoDir,
        "fetch",
        "-q",
        bundlePath,
        `+${BOX_WIP_REF}:refs/mako/incoming`,
      ],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return commitOid;
}

/**
 * Copy a directory out of the sandbox (used for build output).
 *
 * Deliberately narrow: one named directory, on request. This is not the old
 * whole-tree sync coming back — publishing genuinely needs the built bytes,
 * and they are not in git.
 */
export async function readBoxDir(
  ctx: SandboxExecContext,
  boxRelDir: string,
  destDir: string,
): Promise<void> {
  const archive = scratch(ctx, `mako-dir-${process.hrtime.bigint()}.tar.gz`);
  // Packed from INSIDE the directory, so entries are "./x" and extraction
  // needs no guessing about how many leading components to strip.
  await run(
    ctx,
    `tar -czf ${sh(archive)} -C ${sh(`${boxRoot(ctx)}/${boxRelDir}`)} .`,
    `reading ${boxRelDir}`,
  );
  const bytes = await getSandboxProvider().readFile(ctx, archive);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-dir-"));
  try {
    const localArchive = path.join(tmp, "dir.tar.gz");
    await fs.writeFile(localArchive, Buffer.from(bytes));
    await fs.mkdir(destDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", localArchive, "-C", destDir]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await getSandboxProvider()
      .exec(ctx, `rm -f ${sh(archive)}`, { timeoutMs: 15_000 })
      .catch(() => undefined);
  }
}

/** Whether the sandbox already has a given object. */
async function boxHasCommit(
  ctx: SandboxExecContext,
  oid: string,
): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    ctx,
    `${boxGit(ctx, "cat-file", "-e", `${oid}^{commit}`)} 2>/dev/null && echo yes || echo no`,
    { timeoutMs: 30_000 },
  );
  return result.stdout.trim().endsWith("yes");
}

/**
 * Send a commit's objects to the sandbox. Objects only — no ref moves, no
 * checkout.
 *
 * Made idempotent and self-healing on purpose: the sandbox can legitimately be
 * behind (a fast-forward that failed, a colleague's commit, a rebuilt box),
 * and every operation that needs a commit present should simply make it so
 * rather than failing with git's "not a valid object", which names neither the
 * cause nor the cure.
 */
export async function sendCommitToBox(input: {
  ctx: SandboxExecContext;
  repoDir: string;
  commitOid: string;
  /** A commit the sandbox already has, so only new objects are packed. */
  have?: string;
}): Promise<void> {
  const { ctx, repoDir, commitOid, have } = input;
  if (await boxHasCommit(ctx, commitOid)) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-send-"));
  const bundlePath = path.join(tmp, "send.bundle");
  const outRef = "refs/mako/send-out";
  try {
    // Park it on a ref first. `git bundle` packages REFS, so naming a raw sha
    // yields "Refusing to create empty bundle" — an empty rev list, reported
    // as neither the cause nor the fix.
    await runGit(["-C", repoDir, "update-ref", outRef, commitOid]);
    try {
      const args = ["-C", repoDir, "bundle", "create", bundlePath, outRef];
      if (have && (await boxHasCommit(ctx, have))) args.push("--not", have);
      await runGit(args, { timeoutMs: GIT_TIMEOUT_MS });
    } finally {
      await runGit(["-C", repoDir, "update-ref", "-d", outRef]).catch(
        () => undefined,
      );
    }
    const bytes = await fs.readFile(bundlePath);
    const remote = scratch(ctx, "mako-send.bundle");
    await getSandboxProvider().writeFile(ctx, remote, new Uint8Array(bytes));
    await run(
      ctx,
      [
        boxGit(ctx, "fetch", "-q", remote, `+${outRef}:refs/mako/incoming`),
        `rm -f ${sh(remote)}`,
      ].join(" && "),
      "sending commits to the sandbox",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Point the sandbox's branch at a commit the API just created.
 *
 * The commit is made on the host (that is where the CAS against the branch ref
 * lives), so its objects travel the other way before the sandbox can move onto
 * it. `--mixed` keeps the working files exactly as they are and only advances
 * HEAD and the index, which is what makes the tree read clean straight after a
 * commit instead of showing every file as new.
 */
export async function advanceBoxToCommit(input: {
  ctx: SandboxExecContext;
  repoDir: string;
  branch: string;
  commitOid: string;
  have?: string;
}): Promise<void> {
  const { ctx, repoDir, branch, commitOid, have } = input;
  await sendCommitToBox({ ctx, repoDir, commitOid, have });
  await run(
    ctx,
    [
      boxGit(ctx, "update-ref", `refs/heads/${branch}`, commitOid),
      boxGit(ctx, "reset", "-q", "--mixed", commitOid),
    ].join(" && "),
    "advancing the sandbox to the new commit",
  );
}

/**
 * Adopt a branch that exists only in the sandbox.
 *
 * Someone can `git checkout -b` in the terminal, and commit there too. Those
 * commits are real work in a real repository and the API has never heard of
 * them, so before anything else can happen the objects and the ref have to
 * come home. Without this, following the sandbox's branch produces the
 * baffling "Branch head missing" the moment you try to commit.
 */
export async function importBoxBranch(input: {
  ctx: SandboxExecContext;
  repoDir: string;
  branch: string;
  head: string;
}): Promise<void> {
  const { ctx, repoDir, branch, head } = input;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-adopt-"));
  const bundlePath = path.join(tmp, "adopt.bundle");
  const remote = scratch(ctx, "mako-adopt.bundle");
  try {
    await run(
      ctx,
      `${boxGit(ctx, "bundle", "create", "-q", remote, `refs/heads/${branch}`)}`,
      `packaging ${branch}`,
    );
    const bytes = await getSandboxProvider().readFile(ctx, remote);
    await fs.writeFile(bundlePath, Buffer.from(bytes));
    await runGit(
      [
        "-C",
        repoDir,
        "fetch",
        "-q",
        bundlePath,
        `+refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    logger.info("Apps v2 adopted a branch created in the sandbox", {
      branch,
      head: head.slice(0, 8),
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await getSandboxProvider()
      .exec(ctx, `rm -f ${sh(remote)}`, { timeoutMs: 15_000 })
      .catch(() => undefined);
  }
}
