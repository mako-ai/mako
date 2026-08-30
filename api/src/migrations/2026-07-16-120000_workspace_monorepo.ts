/**
 * §10 workspace monorepo (apps-v2.md): consolidate the per-project apps-v2
 * git repos into ONE repo per workspace, with each app under `apps/<slug>/`.
 *
 * Per workspace with apps-v2 projects:
 * 1. Backfill an immutable `slug` on every project doc (kebab title, deduped).
 * 2. Create the workspace bare repo (README initial commit) if missing.
 * 3. For each project, materialize the OLD repo's main tree (local cache dir
 *    if present, else a clone of its old cloud mirror) and commit it under
 *    `apps/<slug>/` — a snapshot migration: full history stays reachable in
 *    the old per-project repos, which are left in place on GitHub for manual
 *    cleanup after verification.
 * 4. Ensure the workspace cloud repo (`<prefix>-<workspaceId>`) and mirror
 *    push.
 * 5. Delete all AppWorktreeV2 docs (disposable caches; auto-commit means
 *    uncommitted residue is at most a last unsaved buffer) and drop the old
 *    per-project unique index. Remove old local per-project repo dirs.
 */
import { Db } from "mongodb";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loggers } from "../logging";
import { appsReposRoot } from "../apps/config";
import {
  getMakoCloudOrg,
  getMakoCloudRepoPrefix,
  getMakoCloudToken,
  isMakoCloudConfigured,
} from "../integrations/github/cloud-app-auth";

const log = loggers.migration();
const execFileAsync = promisify(execFile);

export const description =
  "Apps v2 §10: one repo per workspace; apps become apps/<slug> folders";

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "app";
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const WORKSPACE_README = `# Mako workspace

Managed by Mako. Apps live under apps/<name>; consoles, skills and dbt
content will join as sibling folders (apps-v2.md §10).
`;

export async function up(db: Db): Promise<void> {
  const projects = db.collection("app_projects_v2");
  const workspaces = db.collection("workspaces");
  const worktrees = db.collection("app_worktrees_v2");

  const workspaceIds = (await projects.distinct("workspaceId")) as Array<{
    toString(): string;
  }>;
  if (workspaceIds.length === 0) {
    log.info("No apps-v2 projects; nothing to consolidate");
  }

  const reposRoot = appsReposRoot();
  const cloudReady = isMakoCloudConfigured() && Boolean(getMakoCloudOrg());

  for (const wsIdRaw of workspaceIds) {
    const workspaceId = wsIdRaw.toString();
    const wsProjects = await projects.find({ workspaceId: wsIdRaw }).toArray();

    // 1. Slugs (deduped within the workspace).
    const taken = new Set<string>();
    for (const proj of wsProjects) {
      let slug = (proj.slug as string | undefined) ?? slugify(proj.title);
      if (!proj.slug || taken.has(slug)) {
        const base = slugify(proj.title);
        slug = base;
        for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
        await projects.updateOne({ _id: proj._id }, { $set: { slug } });
      }
      taken.add(slug);
      proj.slug = slug;
    }

    // 2. Workspace bare repo.
    const wsRepoDir = path.join(reposRoot, `${workspaceId}.git`);
    if (!(await exists(path.join(wsRepoDir, "HEAD")))) {
      await fs.mkdir(path.dirname(wsRepoDir), { recursive: true });
      await git(["init", "--bare", "-b", "main", wsRepoDir]);
      await git(["-C", wsRepoDir, "config", "transfer.hideRefs", "refs/mako/"]);
      await git([
        "-C",
        wsRepoDir,
        "config",
        "uploadpack.allowAnySHA1InWant",
        "true",
      ]);
      const seed = await fs.mkdtemp(path.join(os.tmpdir(), "mako-mono-seed-"));
      try {
        await git(["clone", wsRepoDir, seed]);
        await fs.writeFile(path.join(seed, "README.md"), WORKSPACE_README);
        await git(["-C", seed, "add", "-A"]);
        await git([
          "-C",
          seed,
          "-c",
          "user.name=Mako",
          "-c",
          "user.email=bot@mako.ai",
          "commit",
          "-m",
          "Initialize workspace repository",
        ]);
        await git(["-C", seed, "push", "origin", "HEAD:main"]);
      } finally {
        await fs.rm(seed, { recursive: true, force: true });
      }
    }

    // 3. Fold each project's old repo into apps/<slug>/.
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mako-mono-"));
    try {
      await git(["clone", "--branch", "main", wsRepoDir, work]);
      let folded = 0;
      for (const proj of wsProjects) {
        const projectId = proj._id.toString();
        const slug = proj.slug as string;
        const dest = path.join(work, "apps", slug);
        if (await exists(dest)) continue; // idempotent re-run

        // Old repo: local cache dir, else clone the old cloud mirror.
        let oldRepo = path.join(reposRoot, workspaceId, `${projectId}.git`);
        let cloned: string | null = null;
        if (!(await exists(path.join(oldRepo, "HEAD")))) {
          const cloudRepo = proj.cloudRepo as
            | { owner: string; repo: string }
            | undefined;
          if (!cloudRepo || !cloudReady) {
            log.warn("Old repo unavailable; skipping project", {
              projectId,
              workspaceId,
            });
            continue;
          }
          const token = await getMakoCloudToken();
          const basic = Buffer.from(`x-access-token:${token}`).toString(
            "base64",
          );
          cloned = await fs.mkdtemp(path.join(os.tmpdir(), "mako-old-"));
          await git([
            "-c",
            `http.extraheader=Authorization: Basic ${basic}`,
            "clone",
            "--bare",
            "--quiet",
            `https://github.com/${cloudRepo.owner}/${cloudRepo.repo}.git`,
            path.join(cloned, "repo.git"),
          ]);
          oldRepo = path.join(cloned, "repo.git");
        }

        // Materialize old main into apps/<slug>/ (checkout keeps .git out).
        await fs.mkdir(dest, { recursive: true });
        await git([
          "-C",
          oldRepo,
          `--work-tree=${dest}`,
          "checkout",
          "main",
          "--",
          ".",
        ]);
        if (cloned) await fs.rm(cloned, { recursive: true, force: true });

        await git(["-C", work, "add", "-A"]);
        await git([
          "-C",
          work,
          "-c",
          "user.name=Mako",
          "-c",
          "user.email=bot@mako.ai",
          "commit",
          "-m",
          `Migrate app "${proj.title}" into apps/${slug} (§10 monorepo)`,
        ]);
        folded += 1;
      }
      if (folded > 0) await git(["-C", work, "push", "origin", "HEAD:main"]);
      log.info("Workspace consolidated", { workspaceId, folded });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }

    // 4. Workspace cloud repo + mirror push.
    if (cloudReady) {
      const org = getMakoCloudOrg() as string;
      const name = `${getMakoCloudRepoPrefix()}-${workspaceId}`;
      const token = await getMakoCloudToken();
      const res = await fetch(`https://api.github.com/orgs/${org}/repos`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          name,
          private: true,
          auto_init: false,
          description: `Mako workspace repo (workspace ${workspaceId})`,
        }),
      });
      if (!res.ok && res.status !== 422) {
        throw new Error(
          `Failed to create workspace cloud repo ${org}/${name}: ${res.status}`,
        );
      }
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      await git([
        "-C",
        wsRepoDir,
        "-c",
        `http.extraheader=Authorization: Basic ${basic}`,
        "push",
        "--mirror",
        "--quiet",
        `https://github.com/${org}/${name}.git`,
      ]);
      await workspaces.updateOne(
        { _id: wsIdRaw },
        { $set: { appsV2CloudRepo: { owner: org, repo: name } } },
      );
    }

    // 5. Worktree docs are disposable caches keyed per-project — drop them
    // (new ones materialize per (workspace, actor) on next touch), and
    // remove the old local per-project repos.
    await worktrees.deleteMany({ workspaceId: wsIdRaw });
    await fs.rm(path.join(reposRoot, workspaceId), {
      recursive: true,
      force: true,
    });
  }

  // Old unique index (projectId, userId) conflicts with projectId-less docs.
  await worktrees.dropIndex("projectId_1_userId_1").catch(() => undefined);
  log.info("Workspace monorepo migration complete", {
    workspaces: workspaceIds.length,
  });
}
