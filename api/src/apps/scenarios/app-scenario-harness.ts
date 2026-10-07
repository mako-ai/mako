/**
 * Shared rig for the app rename scenario suites (./*.scenarios.test.ts):
 * real bare repos under a temp APPS_GIT_ROOT, mongodb-memory-server, and a
 * real `git clone` / `git mv` / `git push` for the laptop path — the same
 * harness as app-index.service.test.ts and rename/handlers/app.test.ts,
 * factored out so every scenario file builds its world the same way.
 *
 * Not a test file: it is imported by them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  WorkspaceMember,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../bind-test-workspace-repo";
import {
  invalidateAppsIndexCache,
  loadAppsIndex,
  syncAppsIndexFromRepo,
} from "../app-index.service";
import { runGit } from "../git";

export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** A manifest like the scaffold writes (description and all). */
export function manifest(
  title: string,
  id?: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    {
      ...(id ? { id } : {}),
      schemaVersion: 1,
      title,
      description: `${title}: a dashboard with enough words in it that git's rename detection pairs it when one line changes.`,
      entry: "src/main.tsx",
      bindings: [],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

/** A manifest small enough that one changed line defeats `git diff -M`. */
export function tinyManifest(title: string, id?: string): string {
  return `${JSON.stringify({ ...(id ? { id } : {}), title })}\n`;
}

export interface ScenarioEnv {
  tmpRoot: string;
  stop(): Promise<void>;
}

/** Temp roots, local sandbox, and an in-memory Mongo for one test file. */
export async function startScenarioEnv(prefix: string): Promise<ScenarioEnv> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  return {
    tmpRoot,
    async stop() {
      await mongoose.disconnect();
      await mongo.stop();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** A fresh repo and empty app state for `workspaceId`. */
export async function resetWorkspace(
  env: ScenarioEnv,
  workspaceId: string,
  files: Record<string, string>,
): Promise<void> {
  await AppIndexEntry.deleteMany({ workspaceId });
  await AppIndexHead.deleteMany({ workspaceId });
  await AppProject.deleteMany({ workspaceId });
  await WorkspaceMember.deleteMany({ workspaceId });
  await unbindTestWorkspaceRepo(workspaceId);
  invalidateAppsIndexCache();
  await fs.rm(repoDirFor(workspaceId), { recursive: true, force: true });
  await initRepo(repoDirFor(workspaceId), files);
  await bindTestWorkspaceRepo(workspaceId);
}

export async function addMember(
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
  await WorkspaceMember.create({
    workspaceId: new Types.ObjectId(workspaceId),
    userId,
    role,
  });
}

export async function fileAt(
  workspaceId: string,
  rel: string,
  ref = MAIN,
): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(workspaceId), ref, rel)).contents;
  } catch {
    return null;
  }
}

export async function headOf(workspaceId: string): Promise<string> {
  const sha = await resolveCommit(repoDirFor(workspaceId), MAIN);
  if (!sha) throw new Error("main is missing");
  return sha;
}

export async function commitsSince(
  workspaceId: string,
  before: string,
): Promise<number> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "rev-list",
    "--count",
    `${before}..${MAIN}`,
  ]);
  return Number(stdout.trim());
}

/**
 * Every path a range changed, rename detection on: `R apps/a/x → apps/b/x`
 * as `apps/a/x -> apps/b/x`, others as the path. Sorted.
 */
export async function changedPaths(
  workspaceId: string,
  from: string,
  to = MAIN,
): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "diff",
    "--name-status",
    "-M",
    "-z",
    from,
    to,
  ]);
  const fields = stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      out.push(`${fields[i + 1]} -> ${fields[i + 2]}`);
      i += 2;
    } else {
      out.push(fields[i + 1]);
      i += 1;
    }
  }
  return out.sort();
}

/** A commit straight onto main, as another writer would land it. */
export async function externalCommit(
  workspaceId: string,
  writes: Record<string, string>,
  deletes: string[] = [],
  message = "external edit",
): Promise<string> {
  const result = await commitBlobsOnBranch(
    repoDirFor(workspaceId),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message, author: { name: "Laptop", email: "laptop@example.com" } },
  );
  invalidateAppsIndexCache(workspaceId);
  return result.commitOid;
}

/**
 * A laptop: clone the workspace repo, run `steps` in the checkout (real
 * `git mv`, real edits), commit everything as ONE commit, push it to main,
 * then run the apps leg of the push hook (syncRepoBackedResources →
 * syncAppsIndexFromRepo), as the git endpoint does after a receive-pack.
 */
export async function laptopPush(
  env: ScenarioEnv,
  workspaceId: string,
  steps: (checkout: {
    dir: string;
    git: (...args: string[]) => Promise<string>;
    write: (rel: string, contents: string) => Promise<void>;
    read: (rel: string) => Promise<string>;
  }) => Promise<void>,
  message = "laptop change",
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(env.tmpRoot, "laptop-"));
  try {
    await runGit(["clone", "-q", repoDirFor(workspaceId), dir]);
    const git = async (...args: string[]) =>
      (
        await runGit(
          [
            "-C",
            dir,
            "-c",
            "user.name=Laptop",
            "-c",
            "user.email=laptop@example.com",
            ...args,
          ],
          { timeoutMs: 60_000 },
        )
      ).stdout;
    await steps({
      dir,
      git,
      write: async (rel, contents) => {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, contents, "utf8");
      },
      read: rel => fs.readFile(path.join(dir, rel), "utf8"),
    });
    await git("add", "-A");
    await git("commit", "-q", "-m", message);
    await git("push", "-q", "origin", `HEAD:${DEFAULT_BRANCH}`);
    const sha = (await git("rev-parse", "HEAD")).trim();
    invalidateAppsIndexCache(workspaceId);
    await syncAppsIndexFromRepo(workspaceId);
    return sha;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The index row for an app id (after a fresh load). */
export async function indexed(workspaceId: string, appId: string) {
  return (await loadAppsIndex(workspaceId)).apps.find(a => a.appId === appId);
}

/** A random 24-hex id, as a Mongo ObjectId would give. */
export const newId = () => new Types.ObjectId().toHexString();

/** Wall time of `fn`, in ms, with its result. */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
}
