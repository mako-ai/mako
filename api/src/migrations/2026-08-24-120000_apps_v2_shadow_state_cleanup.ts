/**
 * Remove what the apps-v2 shadow-state architecture left behind.
 *
 * The sandbox is an ordinary git clone now: no WIP snapshot refs, no conflict
 * refs preserving losing snapshots, no per-conversation branches, and the
 * worktree document records only which branch an actor is on. Three kinds of
 * debris outlived that change:
 *
 * 1. `refs/mako/worktrees/*` and `refs/mako/conflicts/*` in every workspace
 *    repo — shadow commits nothing can read any more, pinning otherwise
 *    unreachable objects forever (the mirror push is `--mirror`, so they were
 *    being replicated to GitHub too).
 * 2. `chat/*` branches from the one-branch-per-conversation era. They appear
 *    in the branch menu as `chat/<24-hex-mongo-id>`, which means nothing to a
 *    human. Branches AHEAD of main are kept and merely renamed
 *    (`archive/chat-*`) — deleting unmerged work in a cleanup is how cleanups
 *    become incidents; branches already merged into main are deleted.
 * 3. Dead fields on app_worktrees_v2 docs (baseSha, wipOid, revision,
 *    leaseEpoch, lastFlushAt, projectId) — unread projections of refs that no
 *    longer exist.
 */
import { Db } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loggers } from "../logging";
import { appsReposRoot } from "../apps/config";

const log = loggers.migration();
const execFileAsync = promisify(execFile);

export const description =
  "Apps v2: delete shadow-state debris (WIP/conflict refs, chat/* branches, dead worktree fields)";

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    timeout: 60_000,
    encoding: "utf8",
  });
  return stdout;
}

async function cleanRepo(repoDir: string): Promise<void> {
  const refs = (
    await git(repoDir, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/mako/worktrees/",
      "refs/mako/conflicts/",
      // The bundle era's fetch landing pad — every hydration and send fetched
      // into it, and nothing reads it now.
      "refs/mako/incoming",
      "refs/heads/chat/",
    ])
  )
    .split("\n")
    .filter(Boolean);

  for (const ref of refs) {
    if (ref.startsWith("refs/heads/chat/")) {
      const merged = await git(repoDir, [
        "merge-base",
        "--is-ancestor",
        ref,
        "refs/heads/main",
      ])
        .then(() => true)
        .catch(() => false);
      if (!merged) {
        // Unmerged work: keep it, but under a name that says what it is.
        const archived = ref.replace(
          "refs/heads/chat/",
          "refs/heads/archive/chat-",
        );
        await git(repoDir, ["update-ref", archived, ref]);
        log.info("Archived unmerged chat branch", { repoDir, ref, archived });
      }
    }
    await git(repoDir, ["update-ref", "-d", ref]);
  }
  if (refs.length > 0) {
    log.info("Cleaned apps-v2 shadow refs", { repoDir, count: refs.length });
  }
}

export async function up(db: Db): Promise<void> {
  // 1+2: every workspace repo in the local cache. Repos not cached here are
  // restored FROM the mirror on demand, and the next mirror push (forced,
  // --mirror) propagates these deletions — so cleaning the cache cleans the
  // mirror as a consequence, and a host with no cache has nothing to clean.
  const root = appsReposRoot();
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".git")) continue;
    await cleanRepo(path.join(root, entry)).catch(error =>
      log.warn("Repo cleanup failed; continuing", {
        entry,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // 3: dead fields on the worktree docs.
  const result = await db.collection("app_worktrees_v2").updateMany(
    {},
    {
      $unset: {
        baseSha: "",
        wipOid: "",
        revision: "",
        leaseEpoch: "",
        lastFlushAt: "",
        projectId: "",
      },
    },
  );
  log.info("Stripped dead worktree fields", { modified: result.modifiedCount });
}
