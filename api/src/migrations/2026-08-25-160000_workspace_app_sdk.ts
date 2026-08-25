/**
 * Ship `@mako/app-sdk` into existing workspace repos.
 *
 * v1 injected the SDK at runtime; v2 apps are real Vite projects, so the
 * import has to resolve to a real package. New repos get it at init; this
 * brings existing repos level, and adds the `file:` dependency to every app
 * whose source actually imports the SDK — which is exactly the set of apps
 * currently failing with "Failed to resolve import \"@mako/app-sdk\"".
 */
import { Db } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loggers } from "../logging";
import { appsV2ReposRoot } from "../apps-v2/config";
import {
  APP_SDK_DEPENDENCY,
  APP_SDK_DIR,
  appSdkFiles,
} from "../apps-v2/app-sdk-package";
import { commitFilesOnBranch } from "../apps-v2/worktree.service";
import { resolveCommit } from "../apps-v2/repository.service";
import { queueMirrorPush } from "../apps-v2/cloud-repo.service";

const log = loggers.migration();
const execFileAsync = promisify(execFile);

export const description =
  "Apps v2: commit @mako/app-sdk into workspace repos; add the dependency to apps importing it";

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    timeout: 60_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function show(repoDir: string, path_: string): Promise<string | null> {
  try {
    return await git(repoDir, ["show", `refs/heads/main:${path_}`]);
  } catch {
    return null;
  }
}

export async function up(_db: Db): Promise<void> {
  const root = appsV2ReposRoot();
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".git")) continue;
    const repoDir = path.join(root, entry);
    const workspaceId = entry.replace(/\.git$/, "");
    try {
      if (!(await resolveCommit(repoDir, "refs/heads/main"))) continue;
      const writes: Record<string, string> = {};

      if (!(await show(repoDir, `${APP_SDK_DIR}/package.json`))) {
        Object.assign(writes, appSdkFiles());
      }

      // Apps whose SOURCE references the SDK get the dependency — grep
      // scoped to src/ so a mention in MIGRATION.md does not count.
      const grep = await git(repoDir, [
        "grep",
        "-l",
        "@mako/app-sdk",
        "refs/heads/main",
        "--",
        // :(glob) is required: a plain `apps/*/src` pathspec does not match
        // files NESTED under src/, and silently matched nothing.
        ":(glob)apps/*/src/**",
      ]).catch(() => "");
      const appDirs = new Set(
        grep
          .split("\n")
          .map(line => /^[^:]+:apps\/([^/]+)\//.exec(line)?.[1])
          .filter((x): x is string => Boolean(x)),
      );
      for (const app of appDirs) {
        const pkgPath = `apps/${app}/package.json`;
        const raw = await show(repoDir, pkgPath);
        if (!raw) continue;
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
        };
        if (pkg.dependencies?.["@mako/app-sdk"]) continue;
        pkg.dependencies = {
          ...(pkg.dependencies ?? {}),
          ...APP_SDK_DEPENDENCY,
        };
        writes[pkgPath] = `${JSON.stringify(pkg, null, 2)}\n`;
      }

      if (Object.keys(writes).length === 0) continue;
      await commitFilesOnBranch(
        repoDir,
        "main",
        { writes },
        { message: "Add @mako/app-sdk package and wire dependent apps" },
      );
      queueMirrorPush(workspaceId);
      log.info("Shipped @mako/app-sdk", {
        repoDir,
        files: Object.keys(writes).length,
      });
    } catch (error) {
      log.warn("app-sdk backfill failed; continuing", {
        entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
