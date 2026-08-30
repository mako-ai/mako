/**
 * Backfill the workspace repo's root .gitignore.
 *
 * New workspace repos get one at init (see createProject); this brings
 * existing repos level. Without it, an app built by hand — an agent with
 * write_file and bash, or a person pushing from a laptop clone — has no
 * versioned ignore rules at all, and one `git add -A` at the wrong moment
 * commits node_modules (which is not hypothetical: it happened on the first
 * preview deployment, and the resulting tree briefly could not even be
 * listed).
 *
 * Only repos with NO root .gitignore are touched — an existing one may have
 * been customized, and a backfill that overwrites customization is worse
 * than the gap it fills.
 */
import { Db } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";
import { loggers } from "../logging";
import { appsReposRoot } from "../apps/config";
import { workspaceRootGitignore } from "../apps/box";
import { commitFilesOnBranch } from "../apps/worktree.service";
import { resolveCommit } from "../apps/repository.service";
import { queueMirrorPush } from "../apps/cloud-repo.service";
import { runGit } from "../apps/git";

const log = loggers.migration();

export const description =
  "Apps v2: commit a root .gitignore into workspace repos that lack one";

export async function up(_db: Db): Promise<void> {
  const root = appsReposRoot();
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".git")) continue;
    const repoDir = path.join(root, entry);
    const workspaceId = entry.replace(/\.git$/, "");
    try {
      if (!(await resolveCommit(repoDir, "refs/heads/main"))) continue;
      const existing = await runGit(
        ["-C", repoDir, "cat-file", "-e", "refs/heads/main:.gitignore"],
        { timeoutMs: 15_000 },
      )
        .then(() => true)
        .catch(() => false);
      if (existing) continue;

      await commitFilesOnBranch(
        repoDir,
        "main",
        { writes: { ".gitignore": workspaceRootGitignore() } },
        { message: "Add workspace root .gitignore" },
      );
      queueMirrorPush(workspaceId);
      log.info("Backfilled root .gitignore", { repoDir });
    } catch (error) {
      log.warn("Root .gitignore backfill failed; continuing", {
        entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
